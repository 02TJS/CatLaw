import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { GameController } from "../game/controller";
import { catStockPurchaseQuote, formatMoney, inventoryTotal, itemPrice, purchasableParcels, warehouseQuote, warehouseSellPrice } from "../game/engine";
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
import { LANDMARK_DEFINITIONS, landmarkEffectsAt } from "../game/landmarks";
import { positionKey, resourceHarvestTiles, resourceNodesAtPosition } from "../game/world";
import {
  bountyBroadcastsForCat,
  broadcastsForCat,
  buildingOfferBroadcastsForCat,
  creditAvailableCents,
  externalNetCentsAt,
  hasPriceSensitiveJobDemand,
  netWorthCents,
  planForCatPublic,
  productionOrderBudgetCents,
  readyContractForCat,
  signalsForCat,
} from "../game/market";

const controller = new GameController();

type Panel = "laws" | "catalog" | "buildings" | "cat";

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

export function App() {
  useSyncExternalStore((listener) => controller.subscribe(listener), controller.getRevision, controller.getRevision);
  const [selectedCatId, setSelectedCatId] = useState("cat-0");
  const selectedCatRef = useRef(selectedCatId);
  const [panel, setPanel] = useState<Panel>("laws");
  const [expansionMode, setExpansionMode] = useState(false);
  const [placingBuildingItemId, setPlacingBuildingItemId] = useState<string | null>(null);
  const placingBuildingRef = useRef<string | null>(placingBuildingItemId);
  const [placingLandmarkId, setPlacingLandmarkId] = useState<LandmarkId | null>(null);
  const placingLandmarkRef = useRef<LandmarkId | null>(placingLandmarkId);
  const [placementFeedback, setPlacementFeedback] = useState<PlacementFeedback | null>(null);
  const placementFeedbackRef = useRef<PlacementFeedback | null>(placementFeedback);
  const [landmarkFeedback, setLandmarkFeedback] = useState<LandmarkPlacementFeedback | null>(null);
  const landmarkFeedbackRef = useRef<LandmarkPlacementFeedback | null>(landmarkFeedback);
  const state = controller.state;

  useEffect(() => { selectedCatRef.current = selectedCatId; }, [selectedCatId]);
  useEffect(() => { placingBuildingRef.current = placingBuildingItemId; }, [placingBuildingItemId]);
  useEffect(() => { placingLandmarkRef.current = placingLandmarkId; }, [placingLandmarkId]);
  useEffect(() => { placementFeedbackRef.current = placementFeedback; }, [placementFeedback]);
  useEffect(() => { landmarkFeedbackRef.current = landmarkFeedback; }, [landmarkFeedback]);

  useEffect(() => {
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
    );
    window.__CAT_WORKSHOP__ = {
      reset: (difficulty) => controller.reset(difficulty),
      state: () => controller.state,
      setSpeed: (multiplier) => controller.setSpeed(multiplier),
      removeCat: (catId) => controller.removeCat(catId),
      buyCatItem: (catId, itemId) => controller.buyCatItem(catId, itemId),
      buyAllCatStock: () => controller.buyAllCatStock(),
      buyAllCatStockAndSell: () => controller.buyAllCatStockAndSell(),
      sellWarehouseItem: (itemId, quantity) => controller.sellWarehouseItem(itemId, quantity),
      sellAllUnlockedWarehouseItems: () => controller.sellAllUnlockedWarehouseItems(),
      toggleWarehouseItemLock: (itemId) => controller.toggleWarehouseItemLock(itemId),
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
      controller.destroy();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const working = state.cats.filter((cat) => cat.action).length;
  const personalCoins = state.cats.reduce((sum, cat) => sum + cat.coins, 0);
  const perMinute = state.simTime > 0 ? Math.round(state.totalSales / (state.simTime / 60_000)) : 0;
  const selectedCat = state.cats.find((cat) => cat.id === selectedCatId) ?? state.cats[0];
  const selectedInventoryCount = useMemo(() => selectedCat ? Object.values(selectedCat.inventory).reduce((sum, value) => sum + value, 0) : 0, [selectedCat, state.simTime]);

  return (
    <div className="app-shell" id="game-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">🐾</span>
          <div><strong>猫咪工坊</strong></div>
        </div>
        <div className="metrics">
          <Metric label="国库" value={formatMoney(state.treasuryCoins)} accent />
          <Metric label="猫咪现金" value={formatMoney(personalCoins)} />
          <Metric label="产值" value={`${formatMoney(perMinute)}/分`} />
          <Metric label="工作中" value={`${working}/${state.cats.length}`} />
        </div>
        <button className={`pause-button ${state.paused ? "paused" : ""}`} onClick={() => controller.togglePause()} data-testid="pause-button" title="快捷键 P">
          {state.paused ? "▶ 继续" : "Ⅱ 暂停"}
        </button>
        <div className="speed-controls" role="group" aria-label="运行速度">
          {GameController.SPEED_PRESETS.map((speed, index) => <button
            key={speed}
            className={controller.getSpeedMultiplier() === speed ? "active" : ""}
            onClick={() => controller.setSpeed(speed)}
            data-testid={`speed-${speed}x`}
            title={`快捷键 ${index + 1}`}
          >{speed}x</button>)}
        </div>
        <button className={`expand-button ${expansionMode ? "active" : ""}`} onClick={() => {
          setPlacingBuildingItemId(null);
          setPlacingLandmarkId(null);
          setExpansionMode((value) => !value);
        }} data-testid="expand-mode-button">
          {expansionMode ? "退出开拓" : `开拓 · ${state.unlockedParcels.length}块`}
        </button>
        <select className="difficulty-select" aria-label="难度" data-testid="difficulty-select" value={state.difficulty} onChange={async (event) => {
          const next = Number(event.target.value) as DifficultyLevel;
          if (next === state.difficulty) return;
          if (!window.confirm(`切换到难度 ${next} · ${DIFFICULTY_PROFILES[next].name} 会清空当前工坊，继续吗？`)) return;
          await controller.reset(next);
          setSelectedCatId("cat-0");
          setPanel("laws");
          setExpansionMode(false);
          setPlacingBuildingItemId(null);
          setPlacingLandmarkId(null);
        }}>
          {(Object.values(DIFFICULTY_PROFILES) as DifficultyProfile[]).map((profile) => (
            <option key={profile.level} value={profile.level}>{profile.level} · {profile.name}</option>
          ))}
        </select>
      </header>

      <main className="workspace">
        <section className="canvas-column">
          <GameCanvas
            controller={controller}
            selectedCatId={selectedCatId}
            expansionMode={expansionMode}
            placingBuildingItemId={placingBuildingItemId}
            placingLandmarkId={placingLandmarkId}
            onBuildingPlacementResult={(feedback) => {
              setPlacementFeedback(feedback);
              if (feedback.ok) setPlacingBuildingItemId(null);
            }}
            onLandmarkPlacementResult={(feedback) => {
              setLandmarkFeedback(feedback);
              if (feedback.ok) setPlacingLandmarkId(null);
            }}
            onSelectCat={(id) => { setSelectedCatId(id); setPanel("cat"); }}
          />
          <div className="canvas-hint">{placingLandmarkId ? "地标选址中 · 点击普通空地 · Esc 取消" : placingBuildingItemId ? "建筑放置中 · 点击有效地块 · Esc 取消" : "拖动 · 缩放 · 点击空白处放猫 · F 全屏"}</div>
        </section>

        <aside className="side-panel">
          <nav className="panel-tabs">
            <button className={panel === "laws" ? "active" : ""} onClick={() => setPanel("laws")}>法典</button>
            <button className={panel === "catalog" ? "active" : ""} onClick={() => setPanel("catalog")}>配方图</button>
            <button className={panel === "buildings" ? "active" : ""} onClick={() => { setPanel("buildings"); setLandmarkFeedback(null); }}>仓库</button>
            <button className={panel === "cat" ? "active" : ""} onClick={() => setPanel("cat")}>猫咪</button>
          </nav>
          <div className="panel-content">
            {panel === "laws" && <LawPanel controller={controller} />}
            {panel === "catalog" && <CatalogPanel controller={controller} />}
            {panel === "buildings" && <BuildingPanel
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
          </div>
          <footer className="side-footer">
            <button onClick={async () => {
              if (window.confirm("确定清空整个工坊存档吗？此操作不可撤销。")) {
                await controller.reset(state.difficulty);
                setSelectedCatId("cat-0");
                setExpansionMode(false);
                setPlacingBuildingItemId(null);
                setPlacingLandmarkId(null);
                setPlacementFeedback(null);
                setLandmarkFeedback(null);
              }
            }}>清空存档</button>
          </footer>
        </aside>
      </main>
    </div>
  );
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className={`metric ${accent ? "accent" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

function renderGameToText(
  state: GameController["state"],
  speedMultiplier: number,
  selectedCatId: string,
  placingBuildingItemId: string | null,
  placementFeedback: PlacementFeedback | null,
  placingLandmarkId: LandmarkId | null,
  landmarkFeedback: LandmarkPlacementFeedback | null,
): string {
  const craftedItems = ITEMS.filter((item) => state.itemStats[item.id].crafted > 0).map((item) => item.id);
  const certifiedItems = MARKET_CERTIFICATION_ITEM_IDS.filter((itemId) => state.itemStats[itemId].crafted > 0);
  const missingCertificationItems = MARKET_CERTIFICATION_ITEM_IDS.filter((itemId) => !certifiedItems.includes(itemId));
  const positionMap = new Map(state.cats.map((cat) => [positionKey(cat.position), cat]));
  const sharedLogic = state.laws.find((law) => law.category === "behavior" && law.status === "active");
  return JSON.stringify({
    coordinateSystem: "整数方格；原点(0,0)；x向右增加，y向下增加；只可向四邻传递",
    simTimeMs: Math.round(state.simTime),
    difficulty: DIFFICULTY_PROFILES[state.difficulty],
    paused: state.paused,
    runtimeSpeedMultiplier: speedMultiplier,
    speedShortcuts: { "1": "1x", "2": "2x", "3": "4x", "4": "8x", p: "pause" },
    treasuryCents: state.treasuryCoins,
    personalCashCents: state.cats.reduce((sum, cat) => sum + cat.coins, 0),
    totalDebtCents: state.cats.reduce((sum, cat) => sum + cat.debtCents, 0),
    totalSalesCents: state.totalSales,
    decisionModel: {
      visionRadius: LOCAL_VISION_RADIUS,
      sharedByAllCats: true,
      sharedLogic: sharedLogic ? { title: sharedLogic.title, astHash: sharedLogic.astHash, status: sharedLogic.status } : null,
      fallback: "半径2局部候选贪心",
    },
    activeTaxRate: state.laws.find((law) => law.category === "tax" && law.status === "active")?.taxRate ?? 0,
    discoveredItems: state.discoveredItems,
    unlockedRecipes: state.unlockedRecipes,
    world: {
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
        lockedItemIds: state.lockedWarehouseItemIds,
        fixedSellPricesCents: Object.fromEntries(ITEMS.map((item) => [item.id, warehouseSellPrice(item.id)])),
        sellPriceRule: "catalog base price × 2; unaffected by laws, tax, difficulty, or landmarks",
        distinctItems: ITEMS.filter((item) => (state.playerBuildingInventory[item.id] ?? 0) > 0).length,
        totalItems: Object.values(state.playerBuildingInventory).reduce((sum, quantity) => sum + quantity, 0),
        purchasable: ITEMS.map((item) => warehouseQuote(state, item.id)).filter((quote) => quote.availableQuantity > 0),
        allCatStockQuote: catStockPurchaseQuote(state),
      },
      playerBuildingInventory: state.playerBuildingInventory,
      buildingPlacement: {
        itemId: placingBuildingItemId,
        lastAttempt: placementFeedback,
        blockedTileRules: ["locked parcel", "cat", "building", "resource center", "resource harvest tile"],
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
      nextDecisionReviewMs: Math.max(0, state.nextMarketTickAt - state.simTime),
      broadcastMode: "global-immediate",
      broadcasts: [...state.marketBroadcasts].slice(-64).reverse(),
      openOrders: state.demandOrders.filter((order) => order.status === "open").map((order) => ({
        id: order.id,
        itemId: order.itemId,
        buyerCatId: order.buyerCatId,
        destinationCatId: order.destinationCatId,
        maxDeliveredCents: order.maxDeliveredCents,
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
      priceSensitiveJobDemand: RECIPES.filter((recipe) => hasPriceSensitiveJobDemand(state, recipe.id)).map((recipe) => ({
          recipeId: recipe.id,
          itemId: recipe.output,
          advertisedPriceCents: itemPrice(state, recipe.output),
          allInputsOrderBudgetCents: productionOrderBudgetCents(state, recipe.id, (itemId) => itemPrice(state, itemId)),
          rule: "售价高于基础价的部分按150%传导至现有配料订单；库存与已送达物品不再下单",
        })),
    },
    marketChallenge: {
      tutorialTarget: "前15项商品",
      tutorialCompleted: ITEMS.slice(0, 15).every((item) => state.discoveredItems.includes(item.id)),
      certification: `${certifiedItems.length}/6`,
      certifiedItems,
      missingItems: missingCertificationItems,
      missingNames: missingCertificationItems.map((id) => ITEM_BY_ID.get(id)?.name ?? id),
      rule: "第10–15项用国库购买，解锁后继续教学制造；第16–20项要求第10–15项全部实际制造过",
    },
    purchasableRecipes: RECIPES.filter((recipe) => canUnlockRecipe(recipe.id, state.unlockedRecipes, craftedItems)).map((recipe) => ({
      recipeId: recipe.id,
      costCents: recipeUnlockCost(recipe.id),
      affordable: state.treasuryCoins >= recipeUnlockCost(recipe.id),
    })),
    laws: state.laws.map((law, priority) => ({ priority, id: law.id, title: law.title, category: law.category, taxRate: law.taxRate, priceItemId: law.priceItemId, priceMultiplier: law.priceMultiplier, status: law.status, hits: law.hitCount })),
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
      action: cat.action ? { type: cat.action.type, itemId: cat.action.itemId, contractId: cat.action.contractId ?? null, remainingMs: Math.max(0, Math.round(cat.action.endsAt - state.simTime)) } : null,
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
