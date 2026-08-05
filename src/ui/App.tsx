import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { GameController } from "../game/controller";
import { catStockPurchaseQuote, formatMoney, grossProductionValuePerMinute, inventoryTotal, itemPrice, purchasableParcels, warehouseBulkSellQuote, warehouseQuote, warehouseSellPrice } from "../game/engine";
import type { CatStockPurchaseQuote } from "../game/engine";
import { GameCanvas } from "./GameCanvas";
import { LawPanel } from "./LawPanel";
import { CatalogPanel } from "./CatalogPanel";
import { Inspector } from "./Inspector";
import { BuildingPanel } from "./BuildingPanel";
import { canUnlockRecipe, ITEM_BY_ID, ITEMS, MARKET_CERTIFICATION_ITEM_IDS, RECIPES, recipeUnlockCost } from "../game/catalog";
import { localVisibleCats, LOCAL_VISION_RADIUS } from "../game/localPlanner";
import { DIFFICULTY_PROFILES } from "../game/difficulty";
import type { DifficultyProfile } from "../game/difficulty";
import type { DifficultyLevel, LandmarkId } from "../game/types";
import type { AchievementEvent } from "../game/types";
import { achievementGrade, pendingAchievements } from "../game/achievements";
import { LANDMARK_DEFINITIONS, landmarkEffectsAt } from "../game/landmarks";
import { lawProgramSummary, SHARED_BEHAVIOR_HASH } from "../game/lawProgram";
import {
  DEFAULT_SPEECH_FREQUENCY,
  safeSpeechTemplates,
  SPEECH_FREQUENCY_MAX,
  SPEECH_FREQUENCY_MIN,
  speechCapacityForFrequency,
  speechEventIsVisible,
} from "../game/speech";
import { positionKey, resourceHarvestTiles, resourceNodesAtPosition } from "../game/world";
import { getDeepSeekStatus, setDeepSeekApiKey } from "../api";
import { DeepSeekKeyDialog } from "./DeepSeekKeyDialog";
import { buildMapLensSnapshot, ITEM_SCOPED_LENSES, MAP_LENS_OPTIONS, mapLensTitle, type MapLensId } from "./mapLenses";
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
  parseUiPreferences,
  serializeUiPreferences,
  SPEECH_BUBBLE_SCALE_MAX,
  SPEECH_BUBBLE_SCALE_MIN,
  UI_PREFERENCES_STORAGE_KEY,
  type UiPreferences,
} from "./uiPreferences";
import {
  bountyBroadcastsForCat,
  broadcastsForCat,
  buildingOfferBroadcastsForCat,
  creditAvailableCents,
  externalNetCentsAt,
  netWorthCents,
  planForCatPublic,
  readyContractForCat,
  signalsForCat,
} from "../game/market";

const controller = new GameController();

type Panel = "laws" | "warehouse" | "recipes" | "cat" | "settings" | null;

function loadUiPreferences(): UiPreferences {
  try {
    return parseUiPreferences(window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_UI_PREFERENCES };
  }
}

interface PlacementFeedback {
  itemId: string;
  position: { x: number; y: number };
  ok: boolean;
  error?: string;
}

interface LandmarkPlacementFeedback {
  landmarkId: LandmarkId;
  position: { x: number; y: number };
  ok: boolean;
  error?: string;
}

interface CommerceItemDelta {
  itemId: string;
  quantity: number;
}

interface CommerceFeedback {
  id: number;
  ok: boolean;
  text: string;
  itemDeltas?: CommerceItemDelta[];
  treasuryDeltaCents?: number;
}

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
      <div className="achievement-medallion" aria-hidden="true"><span>{presentation.emoji}</span></div>
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
  const [placingBuildingItemId, setPlacingBuildingItemId] = useState<string | null>(null);
  const placingBuildingRef = useRef<string | null>(placingBuildingItemId);
  const [placingLandmarkId, setPlacingLandmarkId] = useState<LandmarkId | null>(null);
  const placingLandmarkRef = useRef<LandmarkId | null>(placingLandmarkId);
  const [placementFeedback, setPlacementFeedback] = useState<PlacementFeedback | null>(null);
  const placementFeedbackRef = useRef<PlacementFeedback | null>(placementFeedback);
  const [landmarkFeedback, setLandmarkFeedback] = useState<LandmarkPlacementFeedback | null>(null);
  const landmarkFeedbackRef = useRef<LandmarkPlacementFeedback | null>(landmarkFeedback);
  const [deepSeekConfigured, setDeepSeekConfigured] = useState(false);
  const [deepSeekChecking, setDeepSeekChecking] = useState(true);
  const [deepSeekStorage, setDeepSeekStorage] = useState<"secure-local" | "session">("session");
  const [deepSeekDialogOpen, setDeepSeekDialogOpen] = useState(false);
  const [deepSeekError, setDeepSeekError] = useState<string | null>(null);
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
  const state = controller.state;

  useEffect(() => { selectedCatRef.current = selectedCatId; }, [selectedCatId]);
  useEffect(() => { expansionModeRef.current = expansionMode; }, [expansionMode]);
  useEffect(() => { mapLensIdRef.current = mapLensId; }, [mapLensId]);
  useEffect(() => { mapLensItemIdRef.current = mapLensItemId; }, [mapLensItemId]);
  useEffect(() => { placingBuildingRef.current = placingBuildingItemId; }, [placingBuildingItemId]);
  useEffect(() => { placingLandmarkRef.current = placingLandmarkId; }, [placingLandmarkId]);
  useEffect(() => { placementFeedbackRef.current = placementFeedback; }, [placementFeedback]);
  useEffect(() => { landmarkFeedbackRef.current = landmarkFeedback; }, [landmarkFeedback]);
  useEffect(() => { commerceFeedbackRef.current = commerceFeedback; }, [commerceFeedback]);
  useEffect(() => { achievementReviewArmedRef.current = achievementReviewArmed; }, [achievementReviewArmed]);
  useEffect(() => {
    uiPreferencesRef.current = uiPreferences;
    try {
      window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, serializeUiPreferences(uiPreferences));
    } catch {
      // Private browsing or a locked profile must not prevent the game from running.
    }
  }, [uiPreferences]);

  useEffect(() => {
    const shell = petWindowRef.current;
    const titlebar = titlebarRef.current;
    const quickStats = quickStatsRef.current;
    const dock = dockRef.current;
    if (!shell || !titlebar || !quickStats || !dock || !titlebar.closest(".desktop-shell")) return;

    let frame = 0;
    const numericStyle = (style: CSSStyleDeclaration, property: string) => Number.parseFloat(style.getPropertyValue(property)) || 0;
    const naturalWidth = (element: HTMLElement) => {
      const style = window.getComputedStyle(element);
      const children = [...element.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
      const childWidth = children.reduce((sum, child) => sum + Math.max(child.scrollWidth, child.getBoundingClientRect().width), 0);
      const gap = numericStyle(style, "column-gap") * Math.max(0, children.length - 1);
      const chrome = numericStyle(style, "padding-left") + numericStyle(style, "padding-right")
        + numericStyle(style, "border-left-width") + numericStyle(style, "border-right-width");
      return Math.max(element.scrollWidth, childWidth + gap + chrome);
    };
    const updateLayout = () => {
      frame = 0;
      const drag = titlebar.querySelector<HTMLElement>(".pet-drag-region");
      const headline = titlebar.querySelector<HTMLElement>(".pet-headline-stats");
      const controls = titlebar.querySelector<HTMLElement>(".pet-window-controls");
      if (!drag || !headline || !controls) return;

      const titleStyle = window.getComputedStyle(titlebar);
      const requiredWidth = naturalWidth(drag) + naturalWidth(headline) + naturalWidth(controls)
        + numericStyle(titleStyle, "column-gap") * 2;
      titlebar.classList.toggle("stacked", requiredWidth > titlebar.clientWidth + 0.5);

      const stage = shell.querySelector<HTMLElement>(".pet-stage");
      if (!stage) return;
      const stageTop = stage.getBoundingClientRect().top;
      const titleBottom = Math.max(
        drag.getBoundingClientRect().bottom,
        headline.getBoundingClientRect().bottom,
        controls.getBoundingClientRect().bottom,
      );
      const controlScale = uiPreferencesRef.current.controlScale;
      shell.style.setProperty("--pet-title-safe-bottom", `${Math.ceil(titleBottom - stageTop + 8 * controlScale)}px`);
      const quickRect = quickStats.getBoundingClientRect();
      const quickBottom = quickRect.bottom;
      shell.style.setProperty("--pet-quick-safe-bottom", `${Math.ceil(quickBottom - stageTop + 8 * controlScale)}px`);
      const drawer = shell.querySelector<HTMLElement>(".pet-drawer");
      const drawerRect = drawer?.getBoundingClientRect();
      const drawerCrossesQuickStats = drawerRect
        ? quickRect.left < drawerRect.right && quickRect.right > drawerRect.left
        : false;
      shell.style.setProperty(
        "--pet-drawer-safe-top",
        `${Math.ceil((drawerCrossesQuickStats ? quickBottom : titleBottom) - stageTop + 8 * controlScale)}px`,
      );
      const stageBottom = stage.getBoundingClientRect().bottom;
      const dockTop = dock.getBoundingClientRect().top;
      shell.style.setProperty("--pet-dock-safe-bottom", `${Math.ceil(stageBottom - dockTop + 8 * controlScale)}px`);
    };
    const scheduleLayout = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateLayout);
    };

    const resizeObserver = new ResizeObserver(scheduleLayout);
    resizeObserver.observe(shell);
    resizeObserver.observe(titlebar);
    resizeObserver.observe(quickStats);
    resizeObserver.observe(dock);
    for (const child of titlebar.children) resizeObserver.observe(child);
    const mutationObserver = new MutationObserver(scheduleLayout);
    mutationObserver.observe(titlebar, { childList: true, subtree: true, characterData: true });
    const shellMutationObserver = new MutationObserver(scheduleLayout);
    shellMutationObserver.observe(shell, { childList: true, subtree: true });
    scheduleLayout();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      shellMutationObserver.disconnect();
    };
  }, [uiPreferences.controlScale, uiPreferences.interfaceFontScale]);

  const refreshDeepSeekStatus = async (showDialog = false) => {
    setDeepSeekChecking(true);
    setDeepSeekError(null);
    if (showDialog) setDeepSeekDialogOpen(true);
    try {
      const status = await getDeepSeekStatus();
      setDeepSeekConfigured(status.configured);
      setDeepSeekStorage(status.keyStorage);
    } catch (error) {
      setDeepSeekConfigured(false);
      setDeepSeekError(error instanceof Error ? error.message : "无法连接本地服务");
    } finally {
      setDeepSeekChecking(false);
    }
  };

  useEffect(() => {
    void refreshDeepSeekStatus(false);
  }, []);

  useEffect(() => {
    const onDesktopWheel = (event: WheelEvent) => {
      if (!window.catWorkshopDesktop) return;
      if ((event.target as HTMLElement | null)?.closest(".pet-drawer-content")) return;
      if (expansionModeRef.current) return;
      void window.catWorkshopDesktop.scaleWindow(event.deltaY, event.screenX, event.screenY);
    };
    window.addEventListener("wheel", onDesktopWheel, { capture: true, passive: false });
    return () => window.removeEventListener("wheel", onDesktopWheel, true);
  }, []);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (!windowDragActive.current) return;
      window.catWorkshopDesktop?.moveWindowDrag(event.screenX, event.screenY);
    };
    const endWindowDrag = () => {
      if (!windowDragActive.current) return;
      windowDragActive.current = false;
      window.catWorkshopDesktop?.endWindowDrag();
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endWindowDrag);
    window.addEventListener("pointercancel", endWindowDrag);
    window.addEventListener("blur", endWindowDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endWindowDrag);
      window.removeEventListener("pointercancel", endWindowDrag);
      window.removeEventListener("blur", endWindowDrag);
    };
  }, []);

  useEffect(() => {
    const channel = new BroadcastChannel("cat-workshop-interface-v1");
    const sendState = () => channel.postMessage({
      type: "recipe-state",
      state: {
        unlockedRecipes: [...controller.state.unlockedRecipes],
        craftedItems: ITEMS.filter((item) => controller.state.itemStats[item.id].crafted > 0).map((item) => item.id),
        treasuryCoins: controller.state.treasuryCoins,
        difficulty: controller.state.difficulty,
      },
    });
    channel.onmessage = (event) => {
      if (event.data?.type === "recipe-state-request") sendState();
      if (event.data?.type === "recipe-unlock" && typeof event.data.recipeId === "string") {
        const result = controller.unlockRecipe(event.data.recipeId);
        channel.postMessage({ type: "recipe-unlock-result", recipeId: event.data.recipeId, ...result });
        sendState();
      }
    };
    const timer = window.setInterval(sendState, 1_000);
    sendState();
    return () => {
      window.clearInterval(timer);
      channel.close();
    };
  }, []);

  useEffect(() => {
    controller.setRuntimeBlocked(false);
    void controller.initialize();
    window.advanceTime = (ms) => controller.advance(ms);
    window.render_game_to_text = () => renderGameToText(
      controller.state,
      controller.getSpeedMultiplier(),
      selectedCatRef.current,
      placingBuildingRef.current,
      placementFeedbackRef.current,
      placingLandmarkRef.current,
      landmarkFeedbackRef.current,
      uiPreferencesRef.current,
      expansionModeRef.current,
      mapLensIdRef.current,
      mapLensItemIdRef.current,
      commerceFeedbackRef.current,
      achievementReviewArmedRef.current,
    );
    window.__CAT_WORKSHOP__ = {
      reset: (difficulty) => controller.reset(difficulty),
      state: () => structuredClone(controller.state),
      setSpeed: (multiplier) => controller.setSpeed(multiplier),
      setSpeechFrequency: (frequency) => controller.setSpeechFrequency(frequency),
      removeCat: (catId) => controller.removeCat(catId),
      buyCatItem: (catId, itemId) => controller.buyCatItem(catId, itemId),
      buyAllCatStock: () => controller.buyAllCatStock(),
      buyAllCatStockAndSell: () => controller.buyAllCatStockAndSell(),
      sellWarehouseItem: (itemId, quantity) => controller.sellWarehouseItem(itemId, quantity),
      sellAllUnlockedWarehouseItems: () => controller.sellAllUnlockedWarehouseItems(),
      toggleWarehouseItemLock: (itemId) => controller.toggleWarehouseItemLock(itemId),
      acknowledgeAchievement: (achievementId) => controller.acknowledgeAchievement(achievementId),
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (!typing && event.key.toLowerCase() === "p") {
        event.preventDefault();
        controller.togglePause();
        return;
      }
      if (!typing) {
        const speedByKey: Record<string, number> = { "1": 1, "2": 2, "3": 4, "4": 8 };
        const nextSpeed = speedByKey[event.key];
        if (nextSpeed) {
          controller.setSpeed(nextSpeed);
          return;
        }
      }
      if (event.key === "Escape") {
        setExpansionMode(false);
        setMapLensPaletteOpen(false);
        setMapLensId("none");
        setPlacingBuildingItemId(null);
        setPlacingLandmarkId(null);
      }
      if (event.key.toLowerCase() === "f" && !["INPUT", "TEXTAREA"].includes((event.target as HTMLElement)?.tagName)) {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.getElementById("game-shell")?.requestFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      if (commerceFeedbackTimer.current !== null) window.clearTimeout(commerceFeedbackTimer.current);
      controller.destroy();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const personalCoins = state.cats.reduce((sum, cat) => sum + cat.coins, 0);
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
  const warehouseKinds = ITEMS.filter((item) => (state.playerBuildingInventory[item.id] ?? 0) > 0).length;
  const mapLensSnapshot = buildMapLensSnapshot(state, mapLensId, mapLensItemId);
  const panelTitle = panel === "laws" ? "逻辑法典" : panel === "warehouse" ? "我的仓库" : panel === "recipes" ? "购买配方" : panel === "cat" ? "猫咪详情" : "桌宠设置";
  const togglePanel = (next: Exclude<Panel, null>) => setPanel((current) => current === next ? null : next);
  const cycleSpeed = () => {
    const current = controller.getSpeedMultiplier();
    const index = GameController.SPEED_PRESETS.indexOf(current as typeof GameController.SPEED_PRESETS[number]);
    controller.setSpeed(GameController.SPEED_PRESETS[(index + 1) % GameController.SPEED_PRESETS.length]);
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
  const openRecipes = () => {
    if (window.catWorkshopDesktop) {
      void window.catWorkshopDesktop.openRecipesInBrowser();
      return;
    }
    const recipeWindow = window.open("/recipes.html", "cat-workshop-recipes", "popup,width=1280,height=820");
    recipeWindow?.focus();
  };

  const beginWindowDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !window.catWorkshopDesktop) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    windowDragActive.current = true;
    window.catWorkshopDesktop.beginWindowDrag(event.screenX, event.screenY);
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
          <span className="pet-title-emoji">🐾</span>
          <strong>猫咪工坊</strong>
          <span className={`pet-live-dot ${state.paused ? "paused" : ""}`} title={state.paused ? "已暂停" : "正在运行"} />
        </div>
        <div className="pet-headline-stats">
          <span className="pet-treasury-stat"><small>国库</small><AnimatedTreasury cents={state.treasuryCoins} />
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
            onSelectCat={(id) => { setSelectedCatId(id); setPanel("cat"); }}
          />
        </section>

        <div className="pet-quick-stats" ref={quickStatsRef}>
          <span data-testid="gross-production-rate" title="最近一分钟商品完工价值，不是国库增速"><b>{formatMoney(productionValuePerMinute)}</b> 产值/分</span>
          <span data-testid="total-production-value" title="所有商品在完工时记录的累计生产价值"><b>{formatMoney(state.totalProductionValueCents)}</b> 总产值</span>
          <span title="猫咪持有现金"><b>{formatMoney(personalCoins)}</b> 猫币</span>
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
              >+{entry.quantity} {item?.emoji ?? "❔"}</i>;
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
          <button onClick={cycleSpeed} data-testid="speed-cycle"><span>×{controller.getSpeedMultiplier()}</span>速度</button>
          <button className={panel === "laws" ? "active" : ""} onClick={() => togglePanel("laws")}><span>📜</span>法典</button>
          <button className={panel === "warehouse" ? "active" : ""} onClick={() => { togglePanel("warehouse"); setLandmarkFeedback(null); }}><span>📦</span>仓库{warehouseKinds > 0 && <i>{warehouseKinds}</i>}</button>
          <button className={panel === "recipes" ? "active" : ""} onClick={() => togglePanel("recipes")} data-testid="open-recipes"><span>🧶</span>配方</button>
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
                setMapLensId("none");
              }
              return !value;
            });
          }} data-testid="expand-mode-button"><span>🗺️</span>{expansionMode ? "完成" : "地图与开拓"}</button>
          <button
            className={mapLensPaletteOpen || mapLensId !== "none" ? "active" : ""}
            title="打开地图滤镜：订单供需、生产瓶颈、生产环境、财富信用、活跃热力、法规影响、生产稳定与坐标索引"
            aria-label="打开地图滤镜选项"
            onClick={() => {
              setPlacingBuildingItemId(null);
              setPlacingLandmarkId(null);
              setExpansionMode(true);
              setMapLensPaletteOpen((value) => !value);
            }}
            data-testid="map-lens-button"
          ><span>🎨</span>滤镜</button>
          <button className={panel === "settings" ? "active" : ""} data-testid="open-settings" onClick={() => togglePanel("settings")}><span>⚙️</span>设置</button>
        </nav>

        {expansionMode && mapLensPaletteOpen && <div className="map-lens-palette" data-testid="map-lens-palette" aria-label="地图滤镜选项">
          <button
            className={mapLensId === "none" ? "active" : ""}
            onClick={() => setMapLensId("none")}
            data-testid="map-lens-none"
          >普通</button>
          {MAP_LENS_OPTIONS.map((lens) => <button
            key={lens.id}
            className={mapLensId === lens.id ? "active" : ""}
            onClick={() => {
              setMapLensId((current) => current === lens.id ? "none" : lens.id);
              if (lens.id === "stability" && !mapLensItemId) {
                setMapLensItemId(state.discoveredItems.includes("wood") ? "wood" : (state.discoveredItems[0] ?? "wood"));
              }
            }}
            data-testid={`map-lens-${lens.id}`}
          >{lens.label}</button>)}
          {ITEM_SCOPED_LENSES.has(mapLensId) && <select
            value={mapLensItemId ?? ""}
            onChange={(event) => setMapLensItemId(event.target.value || null)}
            aria-label="滤镜商品"
            data-testid="map-lens-item"
          >
            {mapLensId !== "stability" && <option value="">全部商品</option>}
            {state.discoveredItems.map((itemId) => {
              const item = ITEM_BY_ID.get(itemId);
              return <option key={itemId} value={itemId}>{item?.emoji} {item?.name ?? itemId}</option>;
            })}
          </select>}
        </div>}

        {expansionMode && mapLensId !== "none" && <aside className="map-lens-legend" data-testid="map-lens-legend">
          <strong>{mapLensTitle(mapLensId, mapLensItemId)}</strong>
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
              <section><strong>运行</strong><p>当前速度 ×{controller.getSpeedMultiplier()} · {state.paused ? "已暂停" : "自动运行中"}</p></section>
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
              <button className={`pet-setting-action ${deepSeekConfigured ? "ok" : "attention"}`} onClick={() => { setDeepSeekError(null); setDeepSeekDialogOpen(true); }} data-testid="open-deepseek-settings">
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
        error={deepSeekError}
        onCancel={() => {
          controller.setRuntimeBlocked(false);
          setDeepSeekDialogOpen(false);
        }}
        onRetry={refreshDeepSeekStatus}
        onSubmit={async (apiKey) => {
          setDeepSeekError(null);
          try {
            const result = await setDeepSeekApiKey(apiKey.trim());
            setDeepSeekConfigured(result.configured);
            setDeepSeekStorage(result.persisted ? "secure-local" : "session");
            controller.setRuntimeBlocked(false);
            setDeepSeekDialogOpen(false);
          } catch (error) {
            setDeepSeekError(error instanceof Error ? error.message : "密钥保存失败");
          }
        }}
      />
    </div>
  );
}

function renderGameToText(
  state: GameController["state"],
  speedMultiplier: number,
  selectedCatId: string,
  placingBuildingItemId: string | null,
  placementFeedback: PlacementFeedback | null,
  placingLandmarkId: LandmarkId | null,
  landmarkFeedback: LandmarkPlacementFeedback | null,
  uiPreferences: UiPreferences,
  mapInteractionMode: boolean,
  mapLensId: MapLensId,
  mapLensItemId: string | null,
  commerceFeedback: CommerceFeedback | null,
  achievementReviewArmed: boolean,
): string {
  const craftedItems = ITEMS.filter((item) => state.itemStats[item.id].crafted > 0).map((item) => item.id);
  const certifiedItems = MARKET_CERTIFICATION_ITEM_IDS.filter((itemId) => state.itemStats[itemId].crafted > 0);
  const missingCertificationItems = MARKET_CERTIFICATION_ITEM_IDS.filter((itemId) => !certifiedItems.includes(itemId));
  const positionMap = new Map(state.cats.map((cat) => [positionKey(cat.position), cat]));
  const decisionLaws = state.laws.filter((law) => law.status === "active");
  const activeMapLens = mapInteractionMode ? buildMapLensSnapshot(state, mapLensId, mapLensItemId) : null;
  return JSON.stringify({
    coordinateSystem: "整数方格；原点(0,0)；x向右增加，y向下增加；只可向四邻传递",
    simTimeMs: Math.round(state.simTime),
    difficulty: DIFFICULTY_PROFILES[state.difficulty],
    paused: state.paused,
    runtimeSpeedMultiplier: speedMultiplier,
    visualPreferences: {
      controlScale: uiPreferences.controlScale,
      interfaceFontScale: uiPreferences.interfaceFontScale,
      speechBubbleScale: uiPreferences.speechBubbleScale,
      mapScale: uiPreferences.mapScale,
      speechFrequencyPercent: state.speechFrequency,
      speechBubbleAvoidsControls: [
        "dragRegion", "headlineStats", "mainCommerce", "windowControls", "dock",
        "filterPalette", "legend", "drawer", "commerceFeedback", "quickStats", "tileActionMenu",
      ],
    },
    speedShortcuts: { "1": "1x", "2": "2x", "3": "4x", "4": "8x", p: "pause" },
    treasuryCents: state.treasuryCoins,
    personalCashCents: state.cats.reduce((sum, cat) => sum + cat.coins, 0),
    totalDebtCents: state.cats.reduce((sum, cat) => sum + cat.debtCents, 0),
    totalSalesCents: state.totalSales,
    totalProductionValueCents: state.totalProductionValueCents,
    grossProductionValuePerMinuteCents: grossProductionValuePerMinute(state),
    commerceAnimation: commerceFeedback ? {
      active: true,
      ok: commerceFeedback.ok,
      message: commerceFeedback.text,
      treasuryDeltaCents: commerceFeedback.treasuryDeltaCents ?? null,
      items: (commerceFeedback.itemDeltas ?? []).map((entry) => ({
        ...entry,
        emoji: ITEM_BY_ID.get(entry.itemId)?.emoji ?? "❔",
        name: ITEM_BY_ID.get(entry.itemId)?.name ?? entry.itemId,
        tier: ITEM_BY_ID.get(entry.itemId)?.tier ?? 0,
        rarity: itemQualityPalette(entry.itemId).id,
        rarityLevel: itemQualityLevel(entry.itemId),
      })),
    } : { active: false, items: [], treasuryDeltaCents: null },
    achievements: {
      unlockedCount: state.achievements.length,
      acknowledgedCount: state.achievements.filter((achievement) => achievement.acknowledgedAt !== null).length,
      pending: pendingAchievements(state).map((achievement) => ({
        id: achievement.id,
        kind: achievement.kind,
        itemId: achievement.itemId,
        thresholdCents: achievement.thresholdCents,
        grade: achievementGrade(achievement),
      })),
      presentationTrigger: "successful-main-commerce-action",
      reviewArmed: achievementReviewArmed,
      awaitingCommerceTrigger: !achievementReviewArmed && pendingAchievements(state).length > 0,
      currentDialogId: !achievementReviewArmed ? null : (pendingAchievements(state)[0]?.id ?? null),
      concurrentWithCommerce: Boolean(achievementReviewArmed && commerceFeedback && pendingAchievements(state).length > 0),
      deferredByCommerce: false,
    },
    decisionModel: {
      visionRadius: LOCAL_VISION_RADIUS,
      sharedByAllCats: true,
      sharedBehaviorHash: SHARED_BEHAVIOR_HASH,
      decisionLaws: decisionLaws.map((law) => ({ id: law.id, title: law.title, astHash: law.astHash, speechTemplates: safeSpeechTemplates(law.speechTemplates) })),
      actionAuthority: "唯一共享 behavior 按优先级解释统一法典；每条法规每次决策最多执行一次",
      marketPlanningRequiresLawHelper: true,
      bountyPlanningAuthority: "悬赏是公开法规数据；只有共享 behavior 函数调用 earnCoins/choose/weighted 后才能认领并创建计划",
      fallback: null,
    },
    discoveredItems: state.discoveredItems,
    unlockedRecipes: state.unlockedRecipes,
    world: {
      mapInteractionMode,
      mapLens: {
        id: mapInteractionMode ? mapLensId : "none",
        title: mapInteractionMode ? mapLensTitle(mapLensId, mapLensItemId) : "普通地图",
        itemId: mapInteractionMode && ITEM_SCOPED_LENSES.has(mapLensId) ? mapLensItemId : null,
        colorOnly: mapLensId !== "inventory",
        inventoryMarkersEnhancedOnly: true,
        actionItemsHidden: mapInteractionMode && mapLensId !== "none",
        craftActionItemsHidden: mapInteractionMode && mapLensId !== "none",
        speechBubblesHidden: mapInteractionMode && mapLensId !== "none",
        catCoordinates: mapInteractionMode && mapLensId === "coordinates"
          ? state.cats.map((cat) => ({ catId: cat.id, serial: cat.createdIndex + 1, position: cat.position }))
          : [],
        wealthNormalization: mapInteractionMode && mapLensId === "wealth" && activeMapLens?.metric ? {
          unit: activeMapLens.metric.unit,
          min: activeMapLens.metric.min,
          median: activeMapLens.metric.median,
          max: activeMapLens.metric.max,
          cats: state.cats.map((cat) => ({
            catId: cat.id,
            value: activeMapLens.metric?.values.get(cat.id) ?? 0,
            normalized: activeMapLens.metric?.normalized.get(cat.id) ?? 0.5,
          })),
        } : null,
        activityHeat: mapInteractionMode && mapLensId === "activity" && activeMapLens?.metric ? {
          unit: activeMapLens.metric.unit,
          activeMeaning: "当前正在制作或运输",
          stalledAfterMs: 60_000,
          cats: state.cats.map((cat) => ({
            catId: cat.id,
            inactiveMs: activeMapLens.metric?.values.get(cat.id) ?? 60_000,
            normalizedInactivity: activeMapLens.metric?.normalized.get(cat.id) ?? 1,
          })),
        } : null,
        stationInventoryMarkers: (mapInteractionMode && mapLensId === "inventory")
          ? state.cats.map((cat) => {
              const entries = Object.entries(cat.inventory)
                .filter(([itemId, quantity]) => quantity > 0 && ITEM_BY_ID.has(itemId))
                .sort(([leftId], [rightId]) => (ITEM_BY_ID.get(rightId)?.tier ?? -1) - (ITEM_BY_ID.get(leftId)?.tier ?? -1)
                  || leftId.localeCompare(rightId));
              return {
                catId: cat.id,
                shown: entries.slice(0, 3).map(([itemId, quantity]) => ({ itemId, quantity })),
                hiddenKinds: Math.max(0, entries.length - 3),
              };
            })
          : [],
        orderParticipants: [...(activeMapLens?.orderFloors.values() ?? [])].map((floor) => ({
          catId: floor.catId,
          demands: floor.demandItemIds,
          demandTargets: floor.demandTargets,
          supplies: floor.supplyItemIds,
          carrier: floor.carrier,
        })) ?? [],
        stabilityHistory: mapInteractionMode && mapLensId === "stability" ? {
          persistentAcrossSaves: true,
          selectedItemId: mapLensItemId,
          producers: state.cats.map((cat) => ({
            catId: cat.id,
            plannedCount: mapLensItemId ? (state.productionHistory.byCat[cat.id]?.[mapLensItemId]?.plannedCount ?? 0) : 0,
            craftedCount: mapLensItemId ? (state.productionHistory.byCat[cat.id]?.[mapLensItemId]?.craftedCount ?? 0) : 0,
            lastCraftedAt: mapLensItemId ? (state.productionHistory.byCat[cat.id]?.[mapLensItemId]?.lastCraftedAt ?? null) : null,
          })).filter((entry) => entry.plannedCount > 0 || entry.craftedCount > 0),
          relations: activeMapLens?.edges.map((edge) => ({
            id: edge.id,
            kind: edge.kind ?? null,
            itemId: edge.itemId ?? null,
            sourceCatId: edge.sourceCatId,
            targetCatId: edge.targetCatId,
            count: edge.count ?? 1,
          })) ?? [],
          arrowEncoding: "线宽与箭头大小按累计计划次数的 log2 缩放",
        } : null,
      },
      parcelSize: 9,
      worldSeed: state.worldSeed,
      unlockedParcels: state.unlockedParcels,
      purchasableParcels: purchasableParcels(state),
      resourceNodes: state.resourceNodes.map((node) => ({
        itemId: node.itemId,
        position: node.position,
        centerOccupied: state.cats.some((cat) => cat.position.x === node.position.x && cat.position.y === node.position.y),
        harvestTiles: resourceHarvestTiles(node),
        harvestingCats: state.cats.filter((cat) => resourceNodesAtPosition([node], cat.position).length > 0).map((cat) => cat.id),
      })),
      buildings: state.buildings,
      buildingOrders: state.buildingOrders,
      buildingOffers: state.buildingOffers.filter((offer) => offer.status === "open"),
      warehouse: {
        inventory: state.playerBuildingInventory,
        purchasedSource: state.playerWarehousePurchases,
        lockedItemIds: state.lockedWarehouseItemIds,
        fixedSellPricesCents: Object.fromEntries(ITEMS.map((item) => [item.id, warehouseSellPrice(item.id)])),
        sellPriceRule: "catalog base price × 2; unaffected by laws, difficulty, or landmarks",
        distinctItems: ITEMS.filter((item) => (state.playerBuildingInventory[item.id] ?? 0) > 0).length,
        totalItems: Object.values(state.playerBuildingInventory).reduce((sum, quantity) => sum + quantity, 0),
        purchasable: ITEMS.map((item) => warehouseQuote(state, item.id)).filter((quote) => quote.availableQuantity > 0),
        allCatStockQuote: catStockPurchaseQuote(state),
        bulkUnlockedSellQuote: warehouseBulkSellQuote(state),
      },
      playerBuildingInventory: state.playerBuildingInventory,
      buildingPlacement: {
        itemId: placingBuildingItemId,
        lastAttempt: placementFeedback,
        blockedTileRules: ["locked parcel", "cat", "building", "landmark", "resource center"],
      },
      landmarkEngineering: {
        blueprints: LANDMARK_DEFINITIONS.map((definition) => ({
          id: definition.id,
          name: definition.name,
          emoji: definition.emoji,
          radius: definition.radius,
          blueprintPriceCents: definition.blueprintPriceCents,
          unlocked: state.unlockedLandmarkIds.includes(definition.id),
          discoveredMaterials: definition.materials.filter((material) => state.discoveredItems.includes(material.itemId)).length,
          materialCount: definition.materials.length,
          materials: definition.materials.map((material) => ({ ...material, stored: state.playerBuildingInventory[material.itemId] ?? 0 })),
          description: definition.description,
        })),
        deployed: state.landmarks,
        placement: { landmarkId: placingLandmarkId, lastAttempt: landmarkFeedback },
      },
    },
    logistics: state.logisticsStatus,
    market: {
      nextDecisionReviewMs: null,
      broadcastMode: "global-immediate",
      broadcasts: [...state.marketBroadcasts].slice(-64).reverse(),
      openOrders: state.demandOrders.filter((order) => order.status === "open").map((order) => ({
        id: order.id,
        itemId: order.itemId,
        buyerCatId: order.buyerCatId,
        destinationCatId: order.destinationCatId,
        maxDeliveredCents: order.maxDeliveredCents,
        reservedCents: order.reservedCents,
        committedSellerCatId: order.committedSellerCatId ?? null,
        quotedSellerCents: order.quotedSellerCents ?? null,
        quotedRouteCatIds: order.quotedRouteCatIds ?? [],
        quotedFeesByCatId: order.quotedFeesByCatId ?? {},
      })),
      activePlans: state.procurementPlans.filter((plan) => plan.status === "active").map((plan) => ({
        id: plan.id,
        catId: plan.catId,
        itemId: plan.outputItemId,
        phase: plan.phase,
        terminalRevenueCents: plan.terminalRevenueCents,
        bundleCostCents: plan.bundleCostCents,
        financingReserveCents: plan.financingReserveCents,
        alternativeGainCents: plan.alternativeGainCents,
        expectedProfitCents: plan.expectedProfitCents,
        bundleOrderIds: plan.bundleOrderIds,
        blockedReason: plan.blockedReason,
      })),
      activeContracts: state.shipmentContracts.filter((contract) => contract.status !== "delivered").map((contract) => ({
        id: contract.id,
        orderId: contract.orderId,
        itemId: contract.itemId,
        status: contract.status,
        routeCatIds: contract.routeCatIds,
        currentLeg: contract.currentLeg,
        custodianCatId: contract.custodianCatId,
      })),
      recentLifecycle: state.marketEvents.slice(-12),
      discoveryBounties: state.discoveryBounties.map((bounty) => ({
        itemId: bounty.itemId,
        amountCents: bounty.amountCents,
        claimedByCatId: bounty.claimedByCatId,
        paid: bounty.paid,
      })),
      fundingRule: "供应猫逐层给出卖价、路线和运费；直接原料包与最坏借贷费一次性冻结，净收益至少1分才承诺",
    },
    marketChallenge: {
      foundationRange: "前15项基础产业",
      foundationCompleted: ITEMS.slice(0, 15).every((item) => state.discoveredItems.includes(item.id)),
      selectionRule: "净资产增益/作业与运输负担",
      certification: `${certifiedItems.length}/${MARKET_CERTIFICATION_ITEM_IDS.length}`,
      certifiedItems,
      missingItems: missingCertificationItems,
      missingNames: missingCertificationItems.map((id) => ITEM_BY_ID.get(id)?.name ?? id),
      rule: "前10项开局免费，第11–15项由国库购买；所有已解锁配方统一参加资产收益率竞争，没有按目录位置指定的生产目标；第16–20项要求第11–15项全部实际制造过",
    },
    purchasableRecipes: RECIPES.filter((recipe) => canUnlockRecipe(recipe.id, state.unlockedRecipes, craftedItems)).map((recipe) => ({
      recipeId: recipe.id,
      costCents: recipeUnlockCost(recipe.id),
      affordable: state.treasuryCoins >= recipeUnlockCost(recipe.id),
    })),
    speechBubbles: state.floatingEvents.filter((event) => event.kind === "speech").map((event) => ({
      id: event.id,
      catId: event.catId,
      text: event.text,
      lawId: event.lawId ?? null,
      reason: event.reason ?? null,
      itemId: event.itemId ?? null,
      gainCents: event.gainCents ?? null,
      direction: event.direction ?? null,
      destinationCatId: event.destinationCatId ?? null,
      scheduledDelayMs: event.scheduledDelayMs ?? 0,
      startsInMs: Math.max(0, Math.round(event.createdAt - state.simTime)),
      visible: speechEventIsVisible(event, state.simTime),
      remainingMs: state.simTime < event.createdAt
        ? event.duration
        : Math.max(0, Math.round(event.createdAt + event.duration - state.simTime)),
    })),
    laws: state.laws.map((law, priority) => ({ priority, id: law.id, title: law.title, explanation: law.explanation ?? law.summary, capabilities: lawProgramSummary(law.program, law.sourceCode), immutable: true, astHash: law.astHash, status: law.status, hits: law.hitCount, speechTemplates: safeSpeechTemplates(law.speechTemplates) })),
    lawbookRevision: state.lawbookRevision,
    commandAudit: state.commandAudit.slice(-100),
    prices: Object.fromEntries(state.discoveredItems.map((id) => [id, itemPrice(state, id)])),
    cats: state.cats.slice(0, 200).map((cat) => ({
      landmarkEffects: landmarkEffectsAt(state, cat.position),
      id: cat.id,
      selected: cat.id === selectedCatId,
      position: cat.position,
      cashCents: cat.coins,
      debtCents: cat.debtCents,
      liquidation: catLiquidationPreview(state, cat),
      escrowReservedCents: cat.escrowReservedCents,
      netWorthCents: netWorthCents(state, cat, (itemId) => itemPrice(state, itemId)),
      creditAvailableCents: creditAvailableCents(state, cat, (itemId) => itemPrice(state, itemId)),
      inventory: cat.inventory,
      playerPurchaseQuote: catStockPurchaseQuote(state, cat.id),
      action: cat.action ? { type: cat.action.type, itemId: cat.action.itemId, lawId: cat.action.lawId, decisionReason: cat.action.decisionReason ?? null, contractId: cat.action.contractId ?? null, remainingMs: Math.max(0, Math.round(cat.action.endsAt - state.simTime)) } : null,
      speech: state.floatingEvents.find((event) => event.kind === "speech" && event.catId === cat.id) ?? null,
      productionPlan: planForCatPublic(state, cat.id) ?? null,
      ownOrders: state.demandOrders.filter((order) => order.buyerKind === "cat" && order.buyerCatId === cat.id && order.status === "open"),
      buildingOffers: state.buildingOffers.filter((offer) => offer.sellerCatId === cat.id && offer.status === "open"),
      localSignals: signalsForCat(state, cat.id).map((signal) => ({
        orderId: signal.orderId,
        itemId: state.demandOrders.find((order) => order.id === signal.orderId)?.itemId ?? null,
        effectiveBidCents: signal.effectiveBidCents,
        sourceCatId: broadcastsForCat(state, cat.id).find((entry) => entry.kind === "demand-open" && entry.subjectId === signal.orderId)?.sourceCatId ?? null,
      })),
      heardBounties: bountyBroadcastsForCat(state, cat.id),
      heardBuildingOffers: buildingOfferBroadcastsForCat(state, cat.id),
      receivedBroadcasts: broadcastsForCat(state, cat.id).slice(0, 32),
      carrying: readyContractForCat(state, cat.id) ?? null,
      contracts: state.shipmentContracts.filter((contract) => contract.status !== "delivered"
        && contract.routeCatIds.includes(cat.id)).map((contract) => ({
          id: contract.id,
          itemId: contract.itemId,
          status: contract.status,
          routeCatIds: contract.routeCatIds,
          currentLeg: contract.currentLeg,
          custodianCatId: contract.custodianCatId,
        })),
      lastDecision: cat.lastDecision,
      visibleWorkstations: localVisibleCats(state, cat, positionMap, landmarkEffectsAt(state, cat.position).effectiveVisionRadius).filter((entry) => entry.id !== cat.id).map((entry) => ({
        id: entry.id,
        position: entry.position,
        distance: Math.abs(entry.position.x - cat.position.x) + Math.abs(entry.position.y - cat.position.y),
      })),
      localScoreTrace: cat.decisionTrace,
    })),
    stargatesBuilt: state.stargatesBuilt,
    catalogInventory: Object.fromEntries(state.discoveredItems.map((id) => [id, inventoryTotal(state, id)])),
    itemStats: Object.fromEntries(state.discoveredItems.map((id) => [id, state.itemStats[id]])),
  });
}

function catLiquidationPreview(state: GameController["state"], cat: GameController["state"]["cats"][number]) {
  const inventory = { ...cat.inventory };
  for (const [itemId, quantity] of Object.entries(cat.action?.reserved ?? {})) inventory[itemId] = (inventory[itemId] ?? 0) + quantity;
  const stockCents = Object.entries(inventory).reduce((sum, [itemId, quantity]) => (
    sum + Math.max(0, quantity) * externalNetCentsAt(state, itemId, (id) => itemPrice(state, id), cat)
  ), 0);
  const assetsCents = cat.coins + stockCents;
  return { assetsCents, debtRepaidCents: cat.debtCents, treasuryDeltaCents: assetsCents - cat.debtCents };
}
