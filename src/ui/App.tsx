import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { GameController } from "../game/controller";
import {
  catCashCents,
  playerWarehouseInventory,
  treasuryCashCents,
} from "../game/domainSemantics";
import { catStockPurchaseQuote, formatMoney, grossProductionValuePerMinute } from "../game/engine";
import type { CatStockPurchaseQuote } from "../game/engine";
import { GameCanvas } from "./GameCanvas";
import { LawPanel } from "./LawPanel";
import { CatalogPanel } from "./CatalogPanel";
import { Inspector } from "./Inspector";
import { BuildingPanel } from "./BuildingPanel";
import { ITEM_BY_ID, ITEMS } from "../game/catalog";
import { DIFFICULTY_PROFILES } from "../game/difficulty";
import type { DifficultyProfile } from "../game/difficulty";
import type { DifficultyLevel, LandmarkId } from "../game/types";
import type { AchievementEvent } from "../game/types";
import { achievementGrade, pendingAchievements } from "../game/achievements";
import {
  DEFAULT_SPEECH_FREQUENCY,
  SPEECH_FREQUENCY_MAX,
  SPEECH_FREQUENCY_MIN,
  speechCapacityForFrequency,
} from "../game/speech";
import { DeepSeekKeyDialog } from "./DeepSeekKeyDialog";
import { EmojiIcon } from "./EmojiIcon";
import {
  buildMapLensSnapshot,
  ITEM_SCOPED_LENSES,
  MAP_LENS_OPTIONS,
  mapLensSelectableItemIds,
  mapLensTitle,
  WEALTH_LENS_WINDOW_OPTIONS_MS,
  type MapLensId,
  type WealthLensMode,
} from "./mapLenses";
import { itemQualityLevel, itemQualityPalette, qualityPaletteAtLevel } from "./itemQuality";
import {
  CONTROL_SCALE_MAX,
  CONTROL_SCALE_MIN,
  DEFAULT_UI_PREFERENCES,
  INTERFACE_FONT_SCALE_MAX,
  INTERFACE_FONT_SCALE_MIN,
  MAP_SCALE_MAX,
  MAP_SCALE_MIN,
  normalizeUiPreferences,
  SPEECH_BUBBLE_SCALE_MAX,
  SPEECH_BUBBLE_SCALE_MIN,
  type UiPreferences,
} from "./uiPreferences";
import type { CommerceFeedback, CommerceItemDelta, LandmarkPlacementFeedback, PlacementFeedback } from "./appTypes";
import { loadUiPreferences, loadWealthLensPreferences, useAppPreferencePersistence } from "./appPreferences";
import { beginDesktopWindowDrag, openRecipeInterface, useDesktopShellInteractions, useResponsiveShellLayout } from "./appPlatform";
import { useRecipeBridge } from "./appRecipeBridge";
import { useDeepSeekSettings } from "./appDeepSeekSettings";
import { startAppSession } from "./appSession";

const controller = new GameController();

type Panel = "laws" | "warehouse" | "recipes" | "cat" | "settings" | null;

function aggregatePurchaseItems(quote: CatStockPurchaseQuote): CommerceItemDelta[] {
  const quantities = new Map<string, number>();
  for (const line of quote.lines) quantities.set(line.itemId, (quantities.get(line.itemId) ?? 0) + line.quantity);
  return ITEMS.filter((item) => quantities.has(item.id))
    .sort((left, right) => itemQualityLevel(right.id) - itemQualityLevel(left.id)
      || ITEMS.indexOf(left) - ITEMS.indexOf(right))
    .map((item) => ({ itemId: item.id, quantity: quantities.get(item.id)! }));
}

function achievementPresentation(achievement: AchievementEvent): {
  eyebrow: string;
  title: string;
  description: string;
  emoji: string;
} {
  if (achievement.kind === "first-craft") {
    const item = ITEM_BY_ID.get(achievement.itemId ?? "");
    return {
      eyebrow: "首次制作成就",
      title: `第一次制作 ${item?.name ?? achievement.itemId ?? "新商品"}`,
      description: `${item?.emoji ?? "✨"} 已正式加入猫咪工坊的生产记录。`,
      emoji: item?.emoji ?? "✨",
    };
  }
  if (achievement.kind === "production-rate") {
    return {
      eyebrow: "生产速度成就",
      title: `产值/分达到 ${formatMoney(achievement.thresholdCents ?? 0)}`,
      description: "最近一个逻辑分钟的完工商品价值跨过了新台阶。",
      emoji: "📈",
    };
  }
  return {
    eyebrow: "累计产值成就",
    title: `总产值达到 ${formatMoney(achievement.thresholdCents ?? 0)}`,
    description: "猫咪们累计完成的商品价值跨过了新里程碑。",
    emoji: "🏆",
  };
}

function AchievementDialog({ achievement, state, onAcknowledge }: {
  achievement: AchievementEvent;
  state: GameController["state"];
  onAcknowledge: () => void;
}) {
  const presentation = achievementPresentation(achievement);
  const grade = achievementGrade(achievement);
  const palette = grade >= 7
    ? itemQualityPalette("stargate")
    : qualityPaletteAtLevel(grade);
  const remaining = pendingAchievements(state).length;
  const style = {
    "--achievement-accent": palette.accent,
    "--achievement-halo": palette.haloInner,
    "--achievement-surface-a": palette.topStops[0],
    "--achievement-surface-b": palette.topStops[1],
  } as CSSProperties;
  return <div className="pet-achievement-backdrop" role="presentation" data-testid="achievement-backdrop">
    <section
      className={`pet-achievement-card quality-${palette.id}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="achievement-title"
      data-testid="achievement-dialog"
      data-achievement-id={achievement.id}
      data-achievement-kind={achievement.kind}
      data-rarity-level={grade}
      style={style}
    >
      <div className="achievement-burst" aria-hidden="true">
        {Array.from({ length: 12 }, (_, index) => <i key={index} style={{ "--spark-index": index } as CSSProperties} />)}
      </div>
      <div className="achievement-medallion" aria-hidden="true"><span><EmojiIcon emoji={presentation.emoji} size={48} /></span></div>
      <small>{presentation.eyebrow}</small>
      <h2 id="achievement-title">{presentation.title}</h2>
      <p>{presentation.description}</p>
      {achievement.kind === "production-rate" && <strong className="achievement-current">当前 {formatMoney(grossProductionValuePerMinute(state))}/分</strong>}
      {achievement.kind === "total-production" && <strong className="achievement-current">累计 {formatMoney(state.totalProductionValueCents)}</strong>}
      {remaining > 1 && <span className="achievement-queue-count">之后还有 {remaining - 1} 项成就</span>}
      <button type="button" data-testid="acknowledge-achievement" onClick={onAcknowledge}>我知道了！</button>
    </section>
  </div>;
}

function AnimatedTreasury({ cents }: { cents: number }) {
  const [displayCents, setDisplayCents] = useState(cents);
  const displayRef = useRef(cents);
  useEffect(() => {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion || displayRef.current === cents) {
      displayRef.current = cents;
      setDisplayCents(cents);
      return;
    }
    const from = displayRef.current;
    const startedAt = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.max(0, Math.min(1, (now - startedAt) / 720));
      const eased = 1 - ((1 - progress) ** 3);
      const next = Math.round(from + (cents - from) * eased);
      displayRef.current = next;
      setDisplayCents(next);
      if (progress < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [cents]);
  return <strong
    className={`pet-treasury-value ${displayCents === cents ? "" : "rolling"}`}
    data-testid="treasury-value"
    data-value-cents={cents}
  >{formatMoney(displayCents)}</strong>;
}

export function App() {
  useSyncExternalStore((listener) => controller.subscribe(listener), controller.getRevision, controller.getRevision);
  const [selectedCatId, setSelectedCatId] = useState("cat-0");
  const selectedCatRef = useRef(selectedCatId);
  const [panel, setPanel] = useState<Panel>(null);
  const [expansionMode, setExpansionMode] = useState(false);
  const expansionModeRef = useRef(expansionMode);
  const [mapLensPaletteOpen, setMapLensPaletteOpen] = useState(false);
  const [mapLensId, setMapLensId] = useState<MapLensId>("none");
  const mapLensIdRef = useRef<MapLensId>(mapLensId);
  const [mapLensItemId, setMapLensItemId] = useState<string | null>(null);
  const mapLensItemIdRef = useRef<string | null>(mapLensItemId);
  const [mapLensItemPickerOpen, setMapLensItemPickerOpen] = useState(false);
  const mapLensItemPickerOpenRef = useRef(mapLensItemPickerOpen);
  const initialWealthLensPreferences = useRef(loadWealthLensPreferences());
  const [wealthLensMode, setWealthLensMode] = useState<WealthLensMode>(initialWealthLensPreferences.current.mode);
  const wealthLensModeRef = useRef(wealthLensMode);
  const [wealthLensWindowMs, setWealthLensWindowMs] = useState(initialWealthLensPreferences.current.windowMs);
  const wealthLensWindowMsRef = useRef(wealthLensWindowMs);
  const [placingBuildingItemId, setPlacingBuildingItemId] = useState<string | null>(null);
  const placingBuildingRef = useRef<string | null>(placingBuildingItemId);
  const [placingLandmarkId, setPlacingLandmarkId] = useState<LandmarkId | null>(null);
  const placingLandmarkRef = useRef<LandmarkId | null>(placingLandmarkId);
  const [placementFeedback, setPlacementFeedback] = useState<PlacementFeedback | null>(null);
  const placementFeedbackRef = useRef<PlacementFeedback | null>(placementFeedback);
  const [landmarkFeedback, setLandmarkFeedback] = useState<LandmarkPlacementFeedback | null>(null);
  const landmarkFeedbackRef = useRef<LandmarkPlacementFeedback | null>(landmarkFeedback);
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  const [commerceFeedback, setCommerceFeedback] = useState<CommerceFeedback | null>(null);
  const commerceFeedbackRef = useRef<CommerceFeedback | null>(commerceFeedback);
  const [achievementReviewArmed, setAchievementReviewArmed] = useState(false);
  const achievementReviewArmedRef = useRef(achievementReviewArmed);
  const nextCommerceFeedbackId = useRef(0);
  const commerceFeedbackTimer = useRef<number | null>(null);
  const [uiPreferences, setUiPreferences] = useState<UiPreferences>(loadUiPreferences);
  const uiPreferencesRef = useRef(uiPreferences);
  const windowDragActive = useRef(false);
  const petWindowRef = useRef<HTMLDivElement>(null);
  const titlebarRef = useRef<HTMLElement>(null);
  const quickStatsRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const mapLensItemPickerRef = useRef<HTMLDivElement>(null);
  const state = controller.state;

  useEffect(() => { selectedCatRef.current = selectedCatId; }, [selectedCatId]);
  useEffect(() => { expansionModeRef.current = expansionMode; }, [expansionMode]);
  useEffect(() => { mapLensIdRef.current = mapLensId; }, [mapLensId]);
  useEffect(() => { mapLensItemIdRef.current = mapLensItemId; }, [mapLensItemId]);
  useEffect(() => { mapLensItemPickerOpenRef.current = mapLensItemPickerOpen; }, [mapLensItemPickerOpen]);
  useEffect(() => { wealthLensModeRef.current = wealthLensMode; }, [wealthLensMode]);
  useEffect(() => { wealthLensWindowMsRef.current = wealthLensWindowMs; }, [wealthLensWindowMs]);
  useEffect(() => { placingBuildingRef.current = placingBuildingItemId; }, [placingBuildingItemId]);
  useEffect(() => { placingLandmarkRef.current = placingLandmarkId; }, [placingLandmarkId]);
  useEffect(() => { placementFeedbackRef.current = placementFeedback; }, [placementFeedback]);
  useEffect(() => { landmarkFeedbackRef.current = landmarkFeedback; }, [landmarkFeedback]);
  useEffect(() => { commerceFeedbackRef.current = commerceFeedback; }, [commerceFeedback]);
  useEffect(() => { achievementReviewArmedRef.current = achievementReviewArmed; }, [achievementReviewArmed]);
  useAppPreferencePersistence(
    uiPreferences,
    uiPreferencesRef,
    wealthLensMode,
    wealthLensWindowMs,
  );

  useEffect(() => {
    if (!mapLensItemPickerOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!mapLensItemPickerRef.current?.contains(event.target as Node)) setMapLensItemPickerOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside, true);
    return () => window.removeEventListener("pointerdown", closeOutside, true);
  }, [mapLensItemPickerOpen]);

  useEffect(() => {
    if (!mapLensPaletteOpen || !ITEM_SCOPED_LENSES.has(mapLensId)) setMapLensItemPickerOpen(false);
  }, [mapLensId, mapLensPaletteOpen]);

  useResponsiveShellLayout(
    petWindowRef,
    titlebarRef,
    quickStatsRef,
    dockRef,
    uiPreferencesRef,
    uiPreferences.controlScale,
    uiPreferences.interfaceFontScale,
  );

  const {
    configured: deepSeekConfigured,
    checking: deepSeekChecking,
    storage: deepSeekStorage,
    baseUrl: deepSeekBaseUrl,
    dialogOpen: deepSeekDialogOpen,
    error: deepSeekError,
    refresh: refreshDeepSeekStatus,
    open: openDeepSeekSettings,
    cancel: cancelDeepSeekSettings,
    submit: submitDeepSeekSettings,
  } = useDeepSeekSettings(controller);

  useDesktopShellInteractions(expansionModeRef, windowDragActive);

  useRecipeBridge(controller);

  useEffect(() => startAppSession(controller, {
    selectedCatRef,
    placingBuildingRef,
    placementFeedbackRef,
    placingLandmarkRef,
    landmarkFeedbackRef,
    uiPreferencesRef,
    expansionModeRef,
    mapLensIdRef,
    mapLensItemIdRef,
    wealthLensModeRef,
    wealthLensWindowMsRef,
    commerceFeedbackRef,
    achievementReviewArmedRef,
    mapLensItemPickerOpenRef,
    commerceFeedbackTimer,
    setMapLensItemPickerOpen,
    setExpansionMode,
    setMapLensPaletteOpen,
    setMapLensId,
    setPlacingBuildingItemId,
    setPlacingLandmarkId,
  }), []);

  const personalCashCents = state.cats.reduce((sum, cat) => sum + catCashCents(cat), 0);
  const productionValuePerMinute = grossProductionValuePerMinute(state);
  const allCatStock = catStockPurchaseQuote(state);
  const queuedAchievements = pendingAchievements(state);
  const currentAchievement = !achievementReviewArmed ? null : (queuedAchievements[0] ?? null);
  useEffect(() => {
    if (achievementReviewArmed && queuedAchievements.length === 0) {
      setAchievementReviewArmed(false);
    }
  }, [achievementReviewArmed, queuedAchievements.length]);
  const selectedCat = state.cats.find((cat) => cat.id === selectedCatId) ?? state.cats[0];
  const selectedInventoryCount = useMemo(() => selectedCat ? Object.values(selectedCat.inventory).reduce((sum, value) => sum + value, 0) : 0, [selectedCat, state.simTime]);
  const warehouse = playerWarehouseInventory(state);
  const warehouseKinds = ITEMS.filter((item) => (warehouse[item.id] ?? 0) > 0).length;
  const selectableMapLensItemIds = mapLensSelectableItemIds(state);
  const selectedMapLensItem = mapLensItemId ? ITEM_BY_ID.get(mapLensItemId) : null;
  const mapLensSnapshot = buildMapLensSnapshot(state, mapLensId, mapLensItemId, { wealthMode: wealthLensMode, wealthWindowMs: wealthLensWindowMs });
  const panelTitle = panel === "laws" ? "逻辑法典" : panel === "warehouse" ? "我的仓库" : panel === "recipes" ? "购买配方" : panel === "cat" ? "猫咪详情" : "桌宠设置";
  const togglePanel = (next: Exclude<Panel, null>) => setPanel((current) => current === next ? null : next);
  const cycleSpeed = () => {
    const current = controller.getRuntimeSpeedMultiplier();
    const index = GameController.RUNTIME_SPEED_PRESETS.indexOf(current);
    controller.setRuntimeSpeedMultiplier(
      GameController.RUNTIME_SPEED_PRESETS[(index + 1) % GameController.RUNTIME_SPEED_PRESETS.length],
    );
  };
  const showCommerceFeedback = (feedback: Omit<CommerceFeedback, "id">) => {
    if (commerceFeedbackTimer.current !== null) window.clearTimeout(commerceFeedbackTimer.current);
    if (feedback.ok) setAchievementReviewArmed(true);
    setCommerceFeedback({ ...feedback, id: ++nextCommerceFeedbackId.current });
    commerceFeedbackTimer.current = window.setTimeout(() => {
      setCommerceFeedback(null);
      commerceFeedbackTimer.current = null;
    }, 3_200);
  };
  const formatSignedMoney = (cents: number) => `${cents >= 0 ? "+" : "−"}${formatMoney(Math.abs(cents))}`;
  const openRecipes = openRecipeInterface;

  const beginWindowDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    beginDesktopWindowDrag(event, windowDragActive);
  };

  const petStyle = {
    "--pet-control-scale": String(uiPreferences.controlScale),
    "--pet-font-scale": String(uiPreferences.interfaceFontScale),
  } as CSSProperties;

  return (
    <div className="pet-window" id="game-shell" style={petStyle} ref={petWindowRef}>
      <header className="pet-titlebar" ref={titlebarRef}>
        <div
          className="pet-drag-region"
          onPointerDown={beginWindowDrag}
          title="左键拖动桌宠"
        >
          <span className="pet-title-emoji"><EmojiIcon emoji="🐾" size={22} /></span>
          <strong>猫咪工坊</strong>
          <span className={`pet-live-dot ${state.paused ? "paused" : ""}`} title={state.paused ? "已暂停" : "正在运行"} />
        </div>
        <div className="pet-headline-stats">
          <span className="pet-treasury-stat"><small>国库</small><AnimatedTreasury cents={treasuryCashCents(state)} />
            {commerceFeedback?.ok && commerceFeedback.treasuryDeltaCents !== undefined && <em
              key={commerceFeedback.id}
              className={commerceFeedback.treasuryDeltaCents >= 0 ? "gain" : "cost"}
              data-testid="treasury-delta"
            >{formatSignedMoney(commerceFeedback.treasuryDeltaCents)}</em>}
          </span>
          <div className="pet-main-commerce" data-testid="main-commerce-actions">
            <button
              data-testid="buy-all-cat-stock"
              disabled={allCatStock.totalQuantity === 0 || state.treasuryCoins < allCatStock.totalCostCents}
              title={`一键购买猫咪现货：${allCatStock.totalQuantity} 件，需 ${formatMoney(allCatStock.totalCostCents)}`}
              onClick={() => {
                const quote = allCatStock;
                const result = controller.buyAllCatStock();
                showCommerceFeedback({
                  ok: result.ok,
                  text: result.ok ? `已购买 ${result.quantity} 件，支付 ${formatMoney(result.costCents ?? 0)}` : result.error ?? "一键购买失败",
                  itemDeltas: result.ok ? aggregatePurchaseItems(quote) : undefined,
                  treasuryDeltaCents: result.ok ? -(result.costCents ?? 0) : undefined,
                });
              }}
            ><span>一键购买</span><small data-testid="buy-all-price">需 {formatMoney(allCatStock.totalCostCents)}</small></button>
            <button
              data-testid="buy-all-cat-stock-and-sell"
              disabled={allCatStock.totalQuantity === 0 || state.treasuryCoins < allCatStock.requiredTreasuryCents}
              title={`一键购买并转售：需垫付 ${formatMoney(allCatStock.requiredTreasuryCents)}`}
              onClick={() => {
                const quote = allCatStock;
                const result = controller.buyAllCatStockAndSell();
                showCommerceFeedback({
                  ok: result.ok,
                  text: result.ok ? `已购买并转售 ${result.quantity} 件，国库 ${formatSignedMoney(result.netCents ?? 0)}` : result.error ?? "购买并转售失败",
                  itemDeltas: result.ok ? aggregatePurchaseItems(quote) : undefined,
                  treasuryDeltaCents: result.ok ? (result.netCents ?? 0) : undefined,
                });
              }}
            ><span>购买并转售</span><small data-testid="buy-resell-price">净 {formatSignedMoney(allCatStock.netCents)}</small></button>
          </div>
        </div>
        <div className="pet-window-controls">
          <button className={alwaysOnTop ? "active" : ""} title="置顶" onClick={async () => {
            const next = await window.catWorkshopDesktop?.toggleAlwaysOnTop();
            if (typeof next === "boolean") setAlwaysOnTop(next);
          }}>⌖</button>
          <button title="最小化" onClick={() => window.catWorkshopDesktop?.minimize()}>—</button>
          <button className="close" title="关闭" data-testid="close-window" onClick={() => window.catWorkshopDesktop?.close()}>×</button>
        </div>
      </header>

      <main className="pet-stage">
        <section className="pet-canvas">
          <GameCanvas
            controller={controller}
            selectedCatId={selectedCatId}
            expansionMode={expansionMode}
            placingBuildingItemId={placingBuildingItemId}
            placingLandmarkId={placingLandmarkId}
            speechScale={uiPreferences.speechBubbleScale}
            mapScale={uiPreferences.mapScale}
            onMapScaleChange={(mapScale) => setUiPreferences((current) => normalizeUiPreferences({ ...current, mapScale }))}
            onBuildingPlacementResult={(feedback) => {
              setPlacementFeedback(feedback);
              if (feedback.ok) setPlacingBuildingItemId(null);
            }}
            onLandmarkPlacementResult={(feedback) => {
              setLandmarkFeedback(feedback);
              if (feedback.ok) setPlacingLandmarkId(null);
            }}
            mapLensId={expansionMode ? mapLensId : "none"}
            mapLensItemId={mapLensItemId}
            wealthLensMode={wealthLensMode}
            wealthLensWindowMs={wealthLensWindowMs}
            onSelectCat={(id) => { setSelectedCatId(id); setPanel("cat"); }}
          />
        </section>

        <div className="pet-quick-stats" ref={quickStatsRef}>
          <span data-testid="gross-production-rate" title="最近一分钟商品完工价值，不是国库增速"><b>{formatMoney(productionValuePerMinute)}</b> 产值/分</span>
          <span data-testid="total-production-value" title="所有商品在完工时记录的累计生产价值"><b>{formatMoney(state.totalProductionValueCents)}</b> 总产值</span>
          <span title="猫咪持有现金"><b>{formatMoney(personalCashCents)}</b> 猫币</span>
        </div>

        {commerceFeedback && <div className={`pet-commerce-feedback ${commerceFeedback.ok ? "ok" : "error"}`} data-testid="main-commerce-message">
          <span>{commerceFeedback.text}</span>
          {commerceFeedback.itemDeltas && commerceFeedback.itemDeltas.length > 0 && <div className="pet-commerce-items" data-testid="commerce-item-deltas">
            {commerceFeedback.itemDeltas.map((entry) => {
              const item = ITEM_BY_ID.get(entry.itemId);
              const palette = itemQualityPalette(entry.itemId);
              return <i
                key={entry.itemId}
                title={`${item?.name ?? entry.itemId} ×${entry.quantity} · ${palette.label}`}
                data-item-id={entry.itemId}
                data-rarity={palette.id}
                data-rarity-level={itemQualityLevel(entry.itemId)}
                style={{ "--commerce-rarity": palette.accent, "--commerce-rarity-bg": palette.topStops[0] } as CSSProperties}
              >+{entry.quantity} <EmojiIcon emoji={item?.emoji ?? "❔"} label={item?.name} /></i>;
            })}
          </div>}
        </div>}

        {currentAchievement && <AchievementDialog
          achievement={currentAchievement}
          state={state}
          onAcknowledge={() => controller.acknowledgeAchievement(currentAchievement.id)}
        />}

        <nav className="pet-dock" aria-label="工坊操作" ref={dockRef}>
          <button className={state.paused ? "active" : ""} onClick={() => controller.togglePause()} data-testid="pause-button"><span>{state.paused ? "▶" : "Ⅱ"}</span>{state.paused ? "继续" : "暂停"}</button>
          <button onClick={cycleSpeed} data-testid="speed-cycle"><span>×{controller.getRuntimeSpeedMultiplier()}</span>速度</button>
          <button className={panel === "laws" ? "active" : ""} onClick={() => togglePanel("laws")}><span><EmojiIcon emoji="📜" /></span>法典</button>
          <button className={panel === "warehouse" ? "active" : ""} onClick={() => { togglePanel("warehouse"); setLandmarkFeedback(null); }}><span><EmojiIcon emoji="📦" /></span>仓库{warehouseKinds > 0 && <i>{warehouseKinds}</i>}</button>
          <button className={panel === "recipes" ? "active" : ""} onClick={() => togglePanel("recipes")} data-testid="open-recipes"><span><EmojiIcon emoji="🧶" /></span>配方</button>
          <button
            className={expansionMode ? "active" : ""}
            title="地图模式：拖动与滚轮调整地图，也可点击相邻地块开拓"
            aria-label="地图与开拓"
            onClick={() => {
            setPlacingBuildingItemId(null);
            setPlacingLandmarkId(null);
            setExpansionMode((value) => {
              if (value) {
                setMapLensPaletteOpen(false);
                setMapLensItemPickerOpen(false);
                setMapLensId("none");
              }
              return !value;
            });
          }} data-testid="expand-mode-button"><span><EmojiIcon emoji="🗺️" /></span>{expansionMode ? "完成" : "地图与开拓"}</button>
          <button
            className={mapLensPaletteOpen || mapLensId !== "none" ? "active" : ""}
            title="打开地图滤镜：订单供需、生产瓶颈、生产环境、财富信用、活跃热力、法规影响、生产稳定与坐标索引"
            aria-label="打开地图滤镜选项"
            onClick={() => {
              setPlacingBuildingItemId(null);
              setPlacingLandmarkId(null);
              setExpansionMode(true);
              setMapLensPaletteOpen((value) => {
                if (value) setMapLensItemPickerOpen(false);
                return !value;
              });
            }}
            data-testid="map-lens-button"
          ><span><EmojiIcon emoji="🎨" /></span>滤镜</button>
          <button className={panel === "settings" ? "active" : ""} data-testid="open-settings" onClick={() => togglePanel("settings")}><span><EmojiIcon emoji="⚙️" /></span>设置</button>
        </nav>

        {expansionMode && mapLensPaletteOpen && <div className="map-lens-palette" data-testid="map-lens-palette" aria-label="地图滤镜选项">
          <button
            className={mapLensId === "none" ? "active" : ""}
            onClick={() => {
              setMapLensItemPickerOpen(false);
              setMapLensId("none");
            }}
            data-testid="map-lens-none"
          >普通</button>
          {MAP_LENS_OPTIONS.map((lens) => <button
            key={lens.id}
            className={mapLensId === lens.id ? "active" : ""}
            onClick={() => {
              setMapLensItemPickerOpen(false);
              setMapLensId((current) => current === lens.id ? "none" : lens.id);
              if (lens.id === "stability" && !mapLensItemId) {
                setMapLensItemId(state.discoveredItems.includes("wood") ? "wood" : (state.discoveredItems[0] ?? "wood"));
              }
            }}
            data-testid={`map-lens-${lens.id}`}
          >{lens.label}</button>)}
          {mapLensId === "wealth" && <div className="map-lens-wealth-controls" data-testid="wealth-lens-controls">
            <div className="map-lens-segments" role="group" aria-label="财富统计方式">
              <button
                type="button"
                className={wealthLensMode === "total" ? "active" : ""}
                onClick={() => setWealthLensMode("total")}
                data-testid="wealth-lens-total"
              >当前总量</button>
              <button
                type="button"
                className={wealthLensMode === "change" ? "active" : ""}
                onClick={() => setWealthLensMode("change")}
                data-testid="wealth-lens-change"
              >近期增量</button>
            </div>
            {wealthLensMode === "change" && <div className="map-lens-window-segments" role="group" aria-label="近期财富统计时段">
              {WEALTH_LENS_WINDOW_OPTIONS_MS.map((windowMs) => <button
                type="button"
                key={windowMs}
                className={wealthLensWindowMs === windowMs ? "active" : ""}
                onClick={() => setWealthLensWindowMs(windowMs)}
                data-testid={`wealth-window-${windowMs}`}
              >{windowMs < 60_000 ? `${windowMs / 1_000}秒` : `${windowMs / 60_000}分`}</button>)}
            </div>}
          </div>}
          {ITEM_SCOPED_LENSES.has(mapLensId) && <div className="map-lens-item-picker" ref={mapLensItemPickerRef}>
            <button
              type="button"
              className="map-lens-item-trigger"
              aria-label="选择滤镜商品"
              aria-haspopup="listbox"
              aria-expanded={mapLensItemPickerOpen}
              aria-controls="map-lens-item-options"
              data-testid="map-lens-item"
              data-value={mapLensItemId ?? ""}
              onClick={() => setMapLensItemPickerOpen((value) => !value)}
            >
              <span>{selectedMapLensItem ? <><EmojiIcon emoji={selectedMapLensItem.emoji} label={selectedMapLensItem.name} /> {selectedMapLensItem.name}</> : "全部商品"}</span>
              <i aria-hidden="true">⌄</i>
            </button>
            {mapLensItemPickerOpen && <div
              className="map-lens-item-options"
              id="map-lens-item-options"
              role="listbox"
              aria-label="可查看商品"
              data-testid="map-lens-item-options"
            >
              {mapLensId !== "stability" && <button
                type="button"
                role="option"
                aria-selected={!mapLensItemId}
                className={!mapLensItemId ? "active" : ""}
                data-testid="map-lens-item-all"
                onClick={() => {
                  setMapLensItemId(null);
                  setMapLensItemPickerOpen(false);
                }}
              >全部商品</button>}
              {selectableMapLensItemIds.map((itemId) => {
                const item = ITEM_BY_ID.get(itemId);
                return <button
                  type="button"
                  key={itemId}
                  role="option"
                  aria-selected={mapLensItemId === itemId}
                  className={mapLensItemId === itemId ? "active" : ""}
                  data-testid={`map-lens-item-${itemId}`}
                  data-item-id={itemId}
                  onClick={() => {
                    setMapLensItemId(itemId);
                    setMapLensItemPickerOpen(false);
                  }}
                ><EmojiIcon emoji={item?.emoji ?? "❔"} label={item?.name} /> {item?.name ?? itemId}</button>;
              })}
            </div>}
          </div>}
        </div>}

        {expansionMode && mapLensId !== "none" && <aside className="map-lens-legend" data-testid="map-lens-legend">
          <strong>{mapLensTitle(mapLensId, mapLensItemId, { wealthMode: wealthLensMode, wealthWindowMs: wealthLensWindowMs })}</strong>
          <div>{mapLensSnapshot.legend.map((entry) => <span key={entry.id}>
            <i style={{ background: entry.top }} />{entry.label}
          </span>)}</div>
        </aside>}

        {panel && <aside className="pet-drawer" data-testid={`drawer-${panel}`}>
          <header><div><small>按需面板</small><strong>{panelTitle}</strong></div><button data-testid="close-drawer" onClick={() => setPanel(null)} aria-label="关闭面板">×</button></header>
          <div className="pet-drawer-content">
            {panel === "laws" && <LawPanel controller={controller} />}
            {panel === "recipes" && <CatalogPanel controller={controller} onOpenGraph={openRecipes} />}
            {panel === "warehouse" && <BuildingPanel
              controller={controller}
              placingItemId={placingBuildingItemId}
              feedback={placementFeedback}
              onStartPlacement={(itemId) => {
                setExpansionMode(false);
                setPlacingLandmarkId(null);
                setPlacementFeedback(null);
                setPlacingBuildingItemId(itemId);
              }}
              onCancelPlacement={() => setPlacingBuildingItemId(null)}
              placingLandmarkId={placingLandmarkId}
              landmarkFeedback={landmarkFeedback}
              onStartLandmarkPlacement={(landmarkId) => {
                setExpansionMode(false);
                setPlacingBuildingItemId(null);
                setLandmarkFeedback(null);
                setPlacingLandmarkId(landmarkId);
              }}
              onCancelLandmarkPlacement={() => { setPlacingLandmarkId(null); setLandmarkFeedback(null); }}
            />}
            {panel === "cat" && <Inspector
              cat={selectedCat}
              controller={controller}
              totalItems={selectedInventoryCount}
              onRemoved={() => setSelectedCatId(controller.state.cats[0]?.id ?? "")}
            />}
            {panel === "settings" && <div className="pet-settings">
              <section><strong>运行</strong><p>当前速度 ×{controller.getRuntimeSpeedMultiplier()} · {state.paused ? "已暂停" : "自动运行中"}</p></section>
              <section className="pet-speech-settings">
                <div className="pet-range-heading"><label htmlFor="pet-speech-frequency">猫咪说话频率</label><output>{state.speechFrequency}%</output></div>
                <input
                  id="pet-speech-frequency"
                  data-testid="speech-frequency"
                  aria-label="猫咪说话频率"
                  type="range"
                  min={SPEECH_FREQUENCY_MIN}
                  max={SPEECH_FREQUENCY_MAX}
                  step={1}
                  value={state.speechFrequency}
                  onChange={(event) => controller.setSpeechFrequency(Number(event.target.value))}
                />
                <p>0 为完全静音；{DEFAULT_SPEECH_FREQUENCY} 为默认频率。当前最多同时显示 {speechCapacityForFrequency(state.speechFrequency)} 个气泡，调低后会立即减少；不改变猫咪行动。</p>
              </section>
              <section className="pet-visual-settings">
                <div className="pet-range-heading"><label htmlFor="pet-control-scale">控件大小</label><output>{Math.round(uiPreferences.controlScale * 100)}%</output></div>
                <input
                  id="pet-control-scale"
                  data-testid="control-scale"
                  type="range"
                  min={Math.round(CONTROL_SCALE_MIN * 100)}
                  max={Math.round(CONTROL_SCALE_MAX * 100)}
                  step={5}
                  value={uiPreferences.controlScale * 100}
                  onChange={(event) => setUiPreferences((current) => ({ ...current, controlScale: Number(event.target.value) / 100 }))}
                />
                <p>调整按钮、面板、间距和关闭键，不改变文字比例。</p>
                <div className="pet-range-heading"><label htmlFor="pet-interface-font-scale">界面文字</label><output>{Math.round(uiPreferences.interfaceFontScale * 100)}%</output></div>
                <input
                  id="pet-interface-font-scale"
                  data-testid="interface-font-scale"
                  type="range"
                  min={Math.round(INTERFACE_FONT_SCALE_MIN * 100)}
                  max={Math.round(INTERFACE_FONT_SCALE_MAX * 100)}
                  step={5}
                  value={uiPreferences.interfaceFontScale * 100}
                  onChange={(event) => setUiPreferences((current) => ({ ...current, interfaceFontScale: Number(event.target.value) / 100 }))}
                />
                <p>只调整标题、按钮、面板和说明文字，不改变猫语气泡。</p>
                <div className="pet-range-heading"><label htmlFor="pet-speech-bubble-scale">猫语气泡</label><output>{Math.round(uiPreferences.speechBubbleScale * 100)}%</output></div>
                <input
                  id="pet-speech-bubble-scale"
                  data-testid="speech-bubble-scale"
                  type="range"
                  min={Math.round(SPEECH_BUBBLE_SCALE_MIN * 100)}
                  max={Math.round(SPEECH_BUBBLE_SCALE_MAX * 100)}
                  step={5}
                  value={uiPreferences.speechBubbleScale * 100}
                  onChange={(event) => setUiPreferences((current) => ({ ...current, speechBubbleScale: Number(event.target.value) / 100 }))}
                />
                <p>只调整猫咪决策台词，不改变任何控件或界面文字。</p>
                <div className="pet-range-heading"><label htmlFor="pet-map-scale">地图缩放</label><output>{Math.round(uiPreferences.mapScale * 100)}%</output></div>
                <input
                  id="pet-map-scale"
                  data-testid="map-scale"
                  type="range"
                  min={Math.round(MAP_SCALE_MIN * 100)}
                  max={Math.round(MAP_SCALE_MAX * 100)}
                  step={5}
                  value={uiPreferences.mapScale * 100}
                  onChange={(event) => setUiPreferences((current) => ({ ...current, mapScale: Number(event.target.value) / 100 }))}
                />
                <p>单独调整猫咪、工位与网格的视野大小，不改变桌宠窗口和控件。</p>
                <button className="pet-size-reset" data-testid="reset-ui-scale" onClick={() => setUiPreferences({ ...DEFAULT_UI_PREFERENCES })}>恢复 100%</button>
              </section>
              <section>
                <label htmlFor="pet-difficulty">难度</label>
                <select id="pet-difficulty" aria-label="难度" data-testid="difficulty-select" value={state.difficulty} onChange={async (event) => {
                  const next = Number(event.target.value) as DifficultyLevel;
                  if (next === state.difficulty) return;
                  if (!window.confirm(`切换到难度 ${next} · ${DIFFICULTY_PROFILES[next].name} 会清空当前工坊，继续吗？`)) return;
                  await controller.reset(next);
                  setSelectedCatId("cat-0");
                  setPanel(null);
                  setExpansionMode(false);
                  setPlacingBuildingItemId(null);
                  setPlacingLandmarkId(null);
                }}>
                  {(Object.values(DIFFICULTY_PROFILES) as DifficultyProfile[]).map((profile) => <option key={profile.level} value={profile.level}>{profile.level} · {profile.name}</option>)}
                </select>
              </section>
              <button className={`pet-setting-action ${deepSeekConfigured ? "ok" : "attention"}`} onClick={openDeepSeekSettings} data-testid="open-deepseek-settings">
                <span>DeepSeek 法规</span><strong>{deepSeekConfigured ? "已配置安全密钥" : "需要配置"}</strong>
              </button>
              <button className="pet-danger-action" onClick={async () => {
                if (!window.confirm("确定清空整个工坊存档吗？此操作不可撤销。")) return;
                await controller.reset(state.difficulty);
                setSelectedCatId("cat-0");
                setExpansionMode(false);
                setPlacingBuildingItemId(null);
                setPlacingLandmarkId(null);
                setPlacementFeedback(null);
                setLandmarkFeedback(null);
                setPanel(null);
              }}>清空工坊存档</button>
            </div>}
          </div>
        </aside>}
      </main>
      <DeepSeekKeyDialog
        open={deepSeekDialogOpen}
        required={!deepSeekConfigured}
        checking={deepSeekChecking}
        storage={deepSeekStorage}
        baseUrl={deepSeekBaseUrl}
        error={deepSeekError}
        onCancel={cancelDeepSeekSettings}
        onRetry={refreshDeepSeekStatus}
        onSubmit={submitDeepSeekSettings}
      />
    </div>
  );
}
