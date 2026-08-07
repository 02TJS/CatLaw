import {
  canUnlockRecipe,
  CATALOG_VERSION,
  DEPLOYABLE_BUILDING_IDS,
  INTRO_RECIPE_IDS,
  ITEM_BY_ID,
  ITEMS,
  RECIPE_BY_ID,
  RECIPE_BY_OUTPUT,
  itemDependencyDistance,
  missingProductionCertifications,
  recipePrerequisiteIds,
  recipeUnlockCost,
} from "./catalog";
import { SAVE_SCHEMA_VERSION } from "./saveSchema";
import { DEFAULT_DIFFICULTY, difficultyProfile, effectiveRecipeInputs, normalizeDifficulty } from "./difficulty";
import { createStarterScenario } from "./starterScenario";
import { executeLawSource, MAX_LAW_EXECUTION_STEPS } from "./lawInterpreter";
import { freshLawPolicy, runSharedLawLoop, SHARED_BEHAVIOR_HASH } from "./lawProgram";
import { clearEphemeralLawPolicy, invalidateEphemeralLawPolicies, setEphemeralLawPolicy } from "./ephemeralLawPolicy";
import { chooseAdjustedLocalDecision, localVisibleCats, planLocalLogistics, type LocalScoreAdjustment } from "./localPlanner";
import {
  DEFAULT_SPEECH_FREQUENCY,
  DEFAULT_LAW_SPEECH_TEMPLATES,
  fillSpeechTemplate,
  formatSpeechAction,
  formatSpeechGain,
  normalizeSpeechFrequency,
  safeSpeechTemplates,
  speechCapacityForFrequency,
  SPEECH_COOLDOWN_MS,
  SPEECH_DURATION_MS,
  speechEventIsQueuedOrVisible,
  speechEventIsVisible,
  speechRoll,
} from "./speech";
import { resourceItemAt, resourceItemsAt, siteFailure } from "./logistics";
import {
  actionSpeedReductionAt,
  buyLandmarkBlueprint,
  createLandmarkSpatialIndex,
  dismantleLandmark,
  landmarkDisplayName,
  landmarkEffectsAt,
  landmarkPlacementFailure,
  normalizeLandmarkNames,
  placeLandmark,
  placeNamedLandmark,
  renameLandmark,
  type LandmarkSpatialIndex,
} from "./landmarks";
import {
  applyPrivateIncome,
  acceptProfitableOrders,
  availableInputQuantityForPlan,
  bountyBroadcastsForCat,
  broadcastsForCat,
  buildingOfferBroadcastsForCat,
  buyBuildingOffer as purchaseBuildingOffer,
  cancelContractsReferencingCat,
  cancelDemandOrder,
  canFinanceDirectCraft,
  claimDiscoveryBounty,
  completeProcurementPlan,
  contractActionForCat,
  contractForAction,
  createDiscoveryBounties,
  creditAvailableCents,
  expectedActionGainCents,
  externalNetCentsAt,
  ensureBountyBroadcasts,
  ensureDirectCraftPlan,
  ensureMarketBroadcasts,
  netWorthCents,
  openDemandOrder,
  planForCatPublic,
  publishProductionBroadcast,
  publishWarehouseBroadcast,
  readyContractForCat,
  repairBrokenMarketReferences,
  refreshCatMarket,
  settleContractLeg,
  sideWorkCraftFailure,
  signalsForCat,
} from "./market";
import type {
  CatAction,
  CatObservation,
  CatState,
  BuildingOrder,
  DeployedBuilding,
  Direction,
  GameState,
  ItemId,
  ItemStats,
  LawDraft,
  LawVersion,
  MarketBroadcast,
  Position,
  RecipeDefinition,
  DifficultyLevel,
} from "./types";
import {
  BASE_RESOURCE_ITEM_IDS,
  DEFAULT_WORLD_SEED,
  frontierParcels,
  generateParcelResourceNodes,
  isAdjacentToUnlocked,
  isParcelUnlocked,
  isPositionUnlocked,
  normalizeWorldSeed,
  parcelCost,
  parcelForPosition,
  parcelKey,
  positionKey,
} from "./world";
import { consumeWarehousePurchase } from "./warehouse";
import { acknowledgeAchievement as acknowledgeAchievementRecord, unlockProductionAchievements } from "./achievements";
import { recordCraftCompletion } from "./productionHistory";
import { formatMoney, itemPrice } from "./marketPricing";
import { advanceSimulationPipeline, type SimulationPipelineOperations } from "./simulationPipeline";
import { normalizeInternalSimulationRate } from "./domainUnits";
import {
  compactGameStateHistory,
  compactLawHistory,
  grossProductionValuePerMinute,
  recordWealthHistorySample,
} from "./gameHistory";

export { formatMoney, itemPrice } from "./marketPricing";
export {
  catWealthScoreCents,
  CLOSED_MARKET_HISTORY_LIMIT,
  compactGameStateHistory,
  grossProductionValuePerMinute,
  LAW_HISTORY_LIMIT,
  normalizeWealthHistory,
  recordWealthHistorySample,
  WEALTH_HISTORY_MAX_WINDOW_MS,
  WEALTH_HISTORY_SAMPLE_INTERVAL_MS,
} from "./gameHistory";

export {
  buyAllCatStock,
  buyAllCatStockAndSell,
  buyCatItem,
  buyWarehouseItem,
  catStockPurchaseQuote,
  sellAllUnlockedWarehouseItems,
  sellWarehouseItem,
  toggleWarehouseItemLock,
  warehouseBulkSellQuote,
  warehouseQuote,
  warehouseSellPrice,
} from "./marketTransactions";
export type {
  CatStockPurchaseLine,
  CatStockPurchaseQuote,
  WarehouseBulkSellLine,
  WarehouseBulkSellQuote,
  WarehouseQuote,
} from "./marketTransactions";

export const ACTION_DURATION_MS = 5_000;
export const REPEAL_COST = 500;

const DIRECTION_OFFSETS: Record<Direction, Position> = {
  north: { x: 0, y: -1 },
  east: { x: 1, y: 0 },
  south: { x: 0, y: 1 },
  west: { x: -1, y: 0 },
};

const emptyStats = (): Record<ItemId, ItemStats> => Object.fromEntries(ITEMS.map((entry) => [entry.id, {
  crafted: 0,
  passed: 0,
  sold: 0,
  revenue: 0,
}]));

export function createInitialState(options: { withStarter?: boolean; worldSeed?: number; simulationSpeed?: number; difficulty?: DifficultyLevel } = {}): GameState {
  const withStarter = options.withStarter ?? true;
  const simulationSpeed = normalizeInternalSimulationRate(options.simulationSpeed);
  const worldSeed = normalizeWorldSeed(options.worldSeed ?? DEFAULT_WORLD_SEED);
  const difficulty = normalizeDifficulty(options.difficulty ?? DEFAULT_DIFFICULTY);
  const profile = difficultyProfile(difficulty);
  const starterWorld = createStarterScenario(worldSeed, difficulty);
  const starter = withStarter ? starterWorld : null;
  const cats = starter?.cats ?? [{
    id: "cat-0",
    createdIndex: 0,
    position: { x: 0, y: 0 },
    inventory: {},
    coins: 0,
    debtCents: 0,
    escrowReservedCents: 0,
    action: null,
    lastDecision: "等待第一条法",
    decisionTrace: [],
    decisionSerial: 0,
    lastSpeechAt: null,
  }];
  const laws = starter?.laws ?? [];
  const resourceNodes = structuredClone(starterWorld.resourceNodes);
  const state: GameState = {
    schemaVersion: SAVE_SCHEMA_VERSION,
    difficulty,
    catalogVersion: CATALOG_VERSION,
    worldSeed,
    simTime: 0,
    paused: false,
    speechFrequency: DEFAULT_SPEECH_FREQUENCY,
    cats,
    nextCatIndex: cats.length,
    unlockedParcels: [{ x: 0, y: 0 }],
    resourceNodes,
    nextPlayerResourceIndex: 0,
    buildings: [],
    landmarks: [],
    unlockedLandmarkIds: [],
    nextLandmarkIndex: 0,
    buildingOffers: [],
    playerBuildingInventory: {},
    playerWarehousePurchases: {},
    lockedWarehouseItemIds: [],
    nextBuildingOfferIndex: 0,
    buildingOrders: [],
    nextBuildingIndex: 0,
    nextBuildingOrderIndex: 0,
    logisticsStatus: [],
    procurementPlans: [],
    demandOrders: [],
    marketBroadcasts: [],
    shipmentContracts: [],
    discoveryBounties: createDiscoveryBounties(difficulty, laws),
    marketEvents: [],
    nextProcurementPlanIndex: 0,
    nextDemandOrderIndex: 0,
    nextMarketBroadcastIndex: 0,
    nextContractIndex: 0,
    nextMarketEventIndex: 0,
    simulationSpeed,
    laws,
    lawHistory: laws.map((law) => structuredClone(law)),
    enactmentCount: 0,
    treasuryCoins: profile.initialTreasuryCents,
    totalSales: 0,
    discoveredItems: [],
    unlockedRecipes: [...INTRO_RECIPE_IDS],
    itemStats: emptyStats(),
    totalProductionValueCents: 0,
    achievements: [],
    productionHistory: { byCat: {}, flows: [] },
    wealthHistory: [],
    recentProductionEvents: [],
    floatingEvents: [],
    stargatesBuilt: 0,
    milestoneAt: null,
    dirtyDecisions: false,
    lawbookRevision: 0,
    commandAudit: [],
  };
  for (const cat of state.cats) beginWait(state, cat, "入场等待");
  ensureMarketBroadcasts(state);
  recordWealthHistorySample(state, true);
  return state;
}

export { parcelCost, parcelForPosition, positionKey };

function catMap(state: GameState): Map<string, CatState> {
  return new Map(state.cats.map((cat) => [positionKey(cat.position), cat]));
}

export function resourceAt(state: GameState, position: Position) {
  return state.resourceNodes.find((node) => node.position.x === position.x && node.position.y === position.y);
}

export function harvestResourceAt(state: GameState, position: Position): ItemId | undefined {
  return resourceItemAt(state, position);
}

export function buildingAt(state: GameState, position: Position): DeployedBuilding | undefined {
  return state.buildings.find((building) => building.position.x === position.x && building.position.y === position.y);
}

export {
  buyLandmarkBlueprint,
  dismantleLandmark,
  landmarkEffectsAt,
  landmarkPlacementFailure,
  normalizeLandmarkNames,
  placeLandmark,
  placeNamedLandmark,
  renameLandmark,
};

export const PLAYER_RESOURCE_CREATION_COST = 50;

export function resourcePlacementFailure(state: GameState, itemId: ItemId, position: Position): string | null {
  if (!BASE_RESOURCE_ITEM_IDS.includes(itemId as typeof BASE_RESOURCE_ITEM_IDS[number])) return "只能创建六种基础资源";
  if (!Number.isInteger(position.x) || !Number.isInteger(position.y)) return "资源坐标必须是整数";
  if (!isPositionUnlocked(state.unlockedParcels, position)) return "只能放在已开拓土地";
  if (state.cats.some((cat) => positionKey(cat.position) === positionKey(position))) return "该格已有猫咪工位";
  if (state.resourceNodes.some((node) => positionKey(node.position) === positionKey(position))) return "该格已有资源中心";
  if (state.buildings.some((building) => positionKey(building.position) === positionKey(position))) return "该格已有工业建筑";
  if (state.landmarks.some((landmark) => positionKey(landmark.position) === positionKey(position))) return "该格已有地标";
  if ((state.playerBuildingInventory[itemId] ?? 0) < PLAYER_RESOURCE_CREATION_COST) return `仓库需要 ${PLAYER_RESOURCE_CREATION_COST} 份${ITEM_BY_ID.get(itemId)?.name ?? itemId}`;
  return null;
}

export function createPlayerResource(
  state: GameState,
  itemId: ItemId,
  position: Position,
): { ok: boolean; error?: string; resource?: GameState["resourceNodes"][number] } {
  const failure = resourcePlacementFailure(state, itemId, position);
  if (failure) return { ok: false, error: failure };
  const resource = {
    id: `resource-player-${state.nextPlayerResourceIndex++}`,
    itemId,
    position: { ...position },
  };
  state.playerBuildingInventory[itemId] -= PLAYER_RESOURCE_CREATION_COST;
  consumeWarehousePurchase(state, itemId, PLAYER_RESOURCE_CREATION_COST);
  if (state.playerBuildingInventory[itemId] <= 0) delete state.playerBuildingInventory[itemId];
  state.resourceNodes.push(resource);
  state.dirtyDecisions = true;
  return { ok: true, resource };
}

export function removeResource(state: GameState, resourceId: string): { ok: boolean; error?: string } {
  const index = state.resourceNodes.findIndex((node) => node.id === resourceId);
  if (index < 0) return { ok: false, error: "资源中心不存在" };
  state.resourceNodes.splice(index, 1);
  state.dirtyDecisions = true;
  return { ok: true };
}

export function recipeSiteFailure(state: GameState, cat: CatState, recipe: RecipeDefinition): string | null {
  return siteFailure(state, cat, recipe);
}

export function expandParcel(state: GameState, parcel: Position): { ok: boolean; error?: string; cost?: number } {
  if (!Number.isInteger(parcel.x) || !Number.isInteger(parcel.y)) return { ok: false, error: "地块坐标必须是整数" };
  if (isParcelUnlocked(state.unlockedParcels, parcel)) return { ok: false, error: "地块已经开拓" };
  if (!isAdjacentToUnlocked(state.unlockedParcels, parcel)) return { ok: false, error: "只能开拓与现有土地四邻相接的地块" };
  const cost = parcelCost(parcel, state.difficulty);
  if (state.treasuryCoins < cost) return { ok: false, error: `国库需要 ${formatMoney(cost)}` };
  state.treasuryCoins -= cost;
  state.unlockedParcels.push({ ...parcel });
  state.unlockedParcels.sort((a, b) => Math.abs(a.x) + Math.abs(a.y) - Math.abs(b.x) - Math.abs(b.y) || a.y - b.y || a.x - b.x);
  state.resourceNodes.push(...generateParcelResourceNodes(state.worldSeed, parcel));
  state.dirtyDecisions = true;
  return { ok: true, cost };
}

export function purchasableParcels(state: GameState) {
  return frontierParcels(state.unlockedParcels).map((parcel) => ({
    ...parcel,
    cost: parcelCost(parcel, state.difficulty),
    affordable: state.treasuryCoins >= parcelCost(parcel, state.difficulty),
  }));
}

export function placeCat(state: GameState, position: Position): CatState | null {
  if (!Number.isInteger(position.x) || !Number.isInteger(position.y)) return null;
  if (!isPositionUnlocked(state.unlockedParcels, position)) return null;
  if (resourceAt(state, position)) return null;
  if (buildingAt(state, position)) return null;
  if (state.landmarks.some((landmark) => positionKey(landmark.position) === positionKey(position))) return null;
  if (state.cats.some((cat) => cat.position.x === position.x && cat.position.y === position.y)) return null;
  const cat: CatState = {
    id: `cat-${state.nextCatIndex}`,
    createdIndex: state.nextCatIndex,
    position: { ...position },
    inventory: {},
    coins: 0,
    debtCents: 0,
    escrowReservedCents: 0,
    action: null,
    lastDecision: "新猫等待决策",
    decisionTrace: [],
    decisionSerial: 0,
    lastSpeechAt: null,
  };
  state.nextCatIndex += 1;
  state.cats.push(cat);
  beginWait(state, cat, "新猫入场等待");
  return cat;
}

export interface CatRemovalResult {
  ok: boolean;
  error?: string;
  settledCents?: number;
  debtRepaidCents?: number;
  treasuryDeltaCents?: number;
}

export interface CatLiquidationPreview {
  assetsCents: number;
  stockCents: number;
  debtRepaidCents: number;
  treasuryDeltaCents: number;
}

/** Read-only liquidation quote used by the inspector and right-click audit. */
export function catLiquidationPreview(state: GameState, cat: CatState): CatLiquidationPreview {
  const inventory = { ...cat.inventory };
  if (cat.action && !cat.action.contractId) {
    for (const [itemId, quantity] of Object.entries(cat.action.reserved ?? {})) {
      inventory[itemId] = (inventory[itemId] ?? 0) + quantity;
    }
  }
  const stockCents = Object.entries(inventory).reduce((sum, [itemId, quantity]) => (
    sum + Math.max(0, quantity) * externalNetCentsAt(state, itemId, (id) => itemPrice(state, id), cat)
  ), 0);
  const assetsCents = cat.coins + stockCents;
  const debtRepaidCents = Math.max(0, cat.debtCents);
  return { assetsCents, stockCents, debtRepaidCents, treasuryDeltaCents: assetsCents - debtRepaidCents };
}

/**
 * Atomically liquidate a cat. Realized cash and stock are valued at the
 * current external net price, debt is paid first, and the net settlement is
 * transferred to the player treasury. Open orders and in-flight contracts
 * are cancelled so no remaining state can reference the removed cat.
 */
export function removeCat(state: GameState, catId: string): CatRemovalResult {
  const cat = state.cats.find((entry) => entry.id === catId);
  if (!cat) return { ok: false, error: "cat-not-found" };
  if (state.cats.length <= 1) return { ok: false, error: "keep-one-cat" };

  // Return ingredients/items locked by an unfinished action before valuing stock.
  if (cat.action) {
    if (!cat.action.contractId) {
      for (const [itemId, quantity] of Object.entries(cat.action.reserved ?? {})) give(cat.inventory, itemId, quantity);
    }
    cat.action = null;
  }

  const affectedContractIds = new Set(state.shipmentContracts
    .filter((contract) => (
      contract.routeCatIds.includes(catId)
      || contract.sellerCatId === catId
      || contract.buyerCatId === catId
      || contract.destinationCatId === catId
      || contract.custodianCatId === catId
    ))
    .map((contract) => contract.id));
  const affectedOrderIds = new Set<string>();
  for (const contract of state.shipmentContracts) {
    if (affectedContractIds.has(contract.id)) affectedOrderIds.add(contract.orderId);
  }
  const catPlanIds = new Set(state.procurementPlans.filter((plan) => plan.catId === catId).map((plan) => plan.id));

  // Cancel every open demand involving this cat. cancelDemandOrder releases
  // the buyer's escrow or the treasury reservation before the cat is removed.
  for (const order of [...state.demandOrders]) {
    if (order.buyerCatId === catId || order.destinationCatId === catId || (order.planId !== null && catPlanIds.has(order.planId))) {
      affectedOrderIds.add(order.id);
      if (order.status === "open") cancelDemandOrder(state, order.id, "鐚挭宸插垹闄わ紝璁㈠崟鍙栨秷");
    }
  }

  // Contract cargo is not ordinary inventory. Unwind it through the market's
  // single asset-conserving path before this cat is liquidated.
  const contractRepair = cancelContractsReferencingCat(state, catId);

  const liquidation = catLiquidationPreview(state, cat);
  const liquidatedCents = liquidation.assetsCents;
  const debtRepaidCents = liquidation.debtRepaidCents;
  const treasuryDeltaCents = liquidation.treasuryDeltaCents;
  state.treasuryCoins += treasuryDeltaCents;

  // Remove all secondary records that could retain the cat or its orders.
  state.procurementPlans = state.procurementPlans.filter((plan) => plan.catId !== catId && !affectedOrderIds.has(plan.terminalOrderId ?? ""));
  state.demandOrders = state.demandOrders.filter((order) => (
    order.buyerCatId !== catId && order.destinationCatId !== catId && !affectedOrderIds.has(order.id)
  ));
  state.shipmentContracts = state.shipmentContracts.filter((contract) => !affectedContractIds.has(contract.id));
  const affectedOfferIds = new Set(state.buildingOffers.filter((offer) => offer.sellerCatId === catId).map((offer) => offer.id));
  state.buildingOffers = state.buildingOffers.filter((offer) => !affectedOfferIds.has(offer.id));
  state.buildingOrders = state.buildingOrders.filter((order) => (
    order.targetCatId !== catId && !affectedContractIds.has(order.contractId ?? "")
  ));
  state.marketBroadcasts = state.marketBroadcasts.filter((broadcast) => (
    broadcast.sourceCatId !== catId && !affectedOrderIds.has(broadcast.subjectId) && !affectedOfferIds.has(broadcast.subjectId)
  ));
  state.discoveryBounties.forEach((bounty) => {
    if (bounty.claimedByCatId === catId) bounty.claimedByCatId = null;
  });
  state.logisticsStatus = state.logisticsStatus.filter((entry) => !entry.catIds.includes(catId));
  state.cats = state.cats.filter((entry) => entry.id !== catId);
  const postRemovalRepair = repairBrokenMarketReferences(state);
  for (const affectedId of new Set([...contractRepair.affectedCatIds, ...postRemovalRepair.affectedCatIds])) {
    const affected = state.cats.find((entry) => entry.id === affectedId);
    if (affected && !affected.action) scheduleInternalWait(state, affected, "异常运输合同已解约，等待重新报价");
  }
  state.dirtyDecisions = true;
  const survivor = state.cats[0];
  if (survivor) addFloating(state, survivor.id, `鐚挭娓呯畻 ${treasuryDeltaCents >= 0 ? "+" : "-"}${formatMoney(Math.abs(treasuryDeltaCents))}`, "sale");
  return { ok: true, settledCents: liquidatedCents, debtRepaidCents, treasuryDeltaCents };
}

export function buildObservation(
  state: GameState,
  cat: CatState,
  map = catMap(state),
  landmarkIndex: LandmarkSpatialIndex = createLandmarkSpatialIndex(state),
  broadcastSnapshot?: readonly MarketBroadcast[],
  visibleBroadcastSnapshot?: readonly MarketBroadcast[],
): CatObservation {
  const effects = landmarkEffectsAt(state, cat.position, landmarkIndex);
  const broadcasts = broadcastSnapshot ?? broadcastsForCat(state, cat.id);
  const visibleBroadcasts = visibleBroadcastSnapshot ?? broadcasts.slice(0, 512);
  const neighbors = {} as CatObservation["neighbors"];
  for (const [direction, offset] of Object.entries(DIRECTION_OFFSETS) as Array<[Direction, Position]>) {
    const neighbor = map.get(`${cat.position.x + offset.x},${cat.position.y + offset.y}`);
    neighbors[direction] = neighbor ? {
      position: { ...neighbor.position },
      inventory: { ...neighbor.inventory },
    } : null;
  }
  const orderSummaries = new Map<ItemId, { id: string; itemId: ItemId; effectiveBidCents: number; sourceCatId: string; count: number }>();
  for (const order of state.demandOrders) {
    if (order.status !== "open") continue;
    const previous = orderSummaries.get(order.itemId);
    if (!previous) {
      orderSummaries.set(order.itemId, {
        id: order.id,
        itemId: order.itemId,
        effectiveBidCents: order.maxDeliveredCents,
        sourceCatId: order.destinationCatId,
        count: 1,
      });
    } else {
      previous.count += 1;
      if (order.maxDeliveredCents > previous.effectiveBidCents
        || (order.maxDeliveredCents === previous.effectiveBidCents && order.id.localeCompare(previous.id) < 0)) {
        previous.id = order.id;
        previous.effectiveBidCents = order.maxDeliveredCents;
        previous.sourceCatId = order.destinationCatId;
      }
    }
  }
  const heardOrders = [...orderSummaries.values()].sort((left, right) => (
    right.effectiveBidCents - left.effectiveBidCents || left.itemId.localeCompare(right.itemId)
  ));
  const heardBounties = bountyBroadcastsForCat(state, cat.id).map((broadcast) => ({
    itemId: broadcast.itemId,
    amountCents: broadcast.amountCents,
    sourceCatId: broadcast.sourceCatId,
  }));
  const heardBuildingOffers = buildingOfferBroadcastsForCat(state, cat.id).map((broadcast) => ({
    offerId: broadcast.subjectId,
    itemId: broadcast.itemId,
    askCents: broadcast.amountCents,
    sourceCatId: broadcast.sourceCatId,
  }));
  const carryingAction = contractActionForCat(state, cat);
  const carryingContract = readyContractForCat(state, cat.id);
  return {
    position: { ...cat.position },
    inventory: { ...cat.inventory },
    neighbors,
    nearby: localVisibleCats(state, cat, map).filter((entry) => entry.id !== cat.id).map((entry) => ({
      position: { ...entry.position },
      inventory: { ...entry.inventory },
      distance: Math.abs(entry.position.x - cat.position.x) + Math.abs(entry.position.y - cat.position.y),
      resourceItemId: resourceItemAt(state, entry.position) ?? null,
      resourceItemIds: resourceItemsAt(state, entry.position),
      buildingItemId: buildingAt(state, entry.position)?.itemId ?? null,
    })),
    site: {
      resourceItemId: resourceItemAt(state, cat.position) ?? null,
      resourceItemIds: resourceItemsAt(state, cat.position),
      buildingItemId: buildingAt(state, cat.position)?.itemId ?? null,
    },
    wallet: {
      cashCents: cat.coins,
      debtCents: cat.debtCents,
      netWorthCents: netWorthCents(state, cat, (itemId) => itemPrice(state, itemId, cat)),
      creditAvailableCents: creditAvailableCents(state, cat, (itemId) => itemPrice(state, itemId, cat)),
    },
    heardOrders,
    heardBounties,
    heardBuildingOffers,
    broadcasts: visibleBroadcasts,
    carrying: carryingAction?.type === "pass" && carryingContract
      ? { contractId: carryingContract.id, itemId: carryingContract.itemId, nextDirection: carryingAction.direction }
      : null,
    ownPlan: (() => {
      const plan = planForCatPublic(state, cat.id);
      return plan ? { outputItemId: plan.outputItemId, reason: plan.reason, expectedRevenueCents: plan.expectedRevenueCents } : null;
    })(),
    discoveryBounties: heardBounties.map((bounty) => ({
      itemId: bounty.itemId,
      amountCents: bounty.amountCents,
      claimedBySelf: state.discoveryBounties.some((entry) => entry.itemId === bounty.itemId && entry.claimedByCatId === cat.id),
    })),
    landmarks: state.landmarks.map((landmark) => ({
      id: landmark.id,
      name: landmarkDisplayName(landmark),
      position: { ...landmark.position },
      distance: Math.abs(landmark.position.x - cat.position.x) + Math.abs(landmark.position.y - cat.position.y),
      kind: landmark.landmarkId === null ? "marker" as const : "engineered" as const,
      landmarkId: landmark.landmarkId,
    })).sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name)).slice(0, 128),
    landmarkEffects: effects,
  };
}

function take(inventory: Record<ItemId, number>, itemId: ItemId, quantity: number): boolean {
  if ((inventory[itemId] ?? 0) < quantity) return false;
  inventory[itemId] -= quantity;
  if (inventory[itemId] === 0) delete inventory[itemId];
  return true;
}

function give(inventory: Record<ItemId, number>, itemId: ItemId, quantity: number): void {
  inventory[itemId] = (inventory[itemId] ?? 0) + quantity;
}

function validateAction(state: GameState, cat: CatState, action: Exclude<CatAction, null>, map: Map<string, CatState>): string | null {
  if (action.type === "craft") {
    const entry = RECIPE_BY_ID.get(action.recipeId);
    if (!entry) return `未知配方 ${action.recipeId}`;
    if (!state.unlockedRecipes.includes(action.recipeId)) return `配方尚未解锁 ${action.recipeId}`;
    const siteFailure = recipeSiteFailure(state, cat, entry);
    if (siteFailure) return siteFailure;
    const plan = planForCatPublic(state, cat.id);
    const servesPlan = Boolean(plan && plan.recipeId === entry.id && plan.phase === "ready");
    const servesHeardOrder = signalsForCat(state, cat.id).some((signal) => state.demandOrders.some((order) => (
      order.id === signal.orderId && itemDependencyDistance(entry.output, order.itemId) >= 0
    )));
    const heardBounty = bountyBroadcastsForCat(state, cat.id).some((broadcast) => broadcast.itemId === entry.output);
    const bountyLedger = state.discoveryBounties.find((bounty) => bounty.itemId === entry.output && !bounty.paid);
    const servesBounty = heardBounty && Boolean(bountyLedger
      && (bountyLedger.claimedByCatId === null || bountyLedger.claimedByCatId === cat.id));
    const sideWorkFailure = plan && plan.recipeId !== entry.id
      ? sideWorkCraftFailure(state, cat, entry, (itemId) => itemPrice(state, itemId, cat))
      : null;
    if (!servesPlan) {
      if (!plan) return "没有完成整包融资的盈利生产计划";
      if (sideWorkFailure) return sideWorkFailure;
    }
    const missing = servesPlan ? effectiveRecipeInputs(entry, state.difficulty).find((input) => (
      !plan || availableInputQuantityForPlan(state, cat, plan, input.itemId) < input.quantity
    )) : undefined;
    if (missing) return `缺少 ${missing.itemId}×${missing.quantity}`;
    return expectedActionGainCents(state, cat, action, (itemId) => itemPrice(state, itemId, cat)) < 0
      ? "预计降低自身净资产"
      : null;
  }
  if (!ITEM_BY_ID.has(action.itemId)) return `未知物品 ${action.itemId}`;
  if (action.type === "pass") {
    const offset = DIRECTION_OFFSETS[action.direction];
    if (!offset) return `非法方向 ${String(action.direction)}`;
    if (!map.has(`${cat.position.x + offset.x},${cat.position.y + offset.y}`)) return `${action.direction} 没有邻居`;
    const contract = contractForAction(state, cat, action);
    if (!contract) return "没有对价：传递必须履行已成交运输合同";
    return null;
  }
  return "未知猫咪动作";
}

function validateLawProposedAction(
  state: GameState,
  cat: CatState,
  action: Exclude<CatAction, null>,
  map: Map<string, CatState>,
): string | null {
  if (action.type !== "craft") return validateAction(state, cat, action, map);
  const recipe = RECIPE_BY_ID.get(action.recipeId);
  if (!recipe) return `未知配方 ${action.recipeId}`;
  if (!state.unlockedRecipes.includes(action.recipeId)) return `配方尚未解锁 ${action.recipeId}`;
  const siteFailure = recipeSiteFailure(state, cat, recipe);
  if (siteFailure) return siteFailure;
  const active = planForCatPublic(state, cat.id);
  if (active) {
    if (active.recipeId === recipe.id) return null;
    return sideWorkCraftFailure(state, cat, recipe, (itemId) => itemPrice(state, itemId, cat));
  }
  return canFinanceDirectCraft(state, cat, recipe.id, (itemId) => itemPrice(state, itemId, cat))
    ? null
    : "无法为直接制作取得完整原料包融资证明";
}

function appendAudit(state: GameState, entry: Omit<GameState["commandAudit"][number], "sequence" | "atMs">): void {
  state.commandAudit.push({ ...entry, sequence: (state.commandAudit.at(-1)?.sequence ?? 0) + 1, atMs: state.simTime });
  if (state.commandAudit.length > 2_000) state.commandAudit.splice(0, state.commandAudit.length - 2_000);
}

export function recordPlayerCommand(
  state: GameState,
  kind: import("./types").PlayerCommandKind,
  target: string,
  ok: boolean,
  detail?: string,
): void {
  appendAudit(state, { origin: "player-ui", kind, target, ok, detail });
}

function beginWait(state: GameState, cat: CatState, reason: string): void {
  cat.action = {
    type: "wait",
    itemId: "",
    startedAt: state.simTime,
    endsAt: state.simTime + Math.max(1, ACTION_DURATION_MS / state.simulationSpeed),
    reserved: {},
    lawId: "internal-wait",
    speedReduction: 0,
  };
  cat.lastDecision = reason;
  appendAudit(state, { origin: "simulation", kind: "action-start", target: cat.id, ok: true, detail: "wait" });
}

export function scheduleInternalWait(state: GameState, cat: CatState, reason = "存档载入等待"): void {
  beginWait(state, cat, reason);
}

function beginAction(
  state: GameState,
  cat: CatState,
  action: Exclude<CatAction, null>,
  lawId: string,
  decisionReason: string,
): void {
  const reserved: Record<ItemId, number> = {};
  let itemId = "" as ItemId;
  if (action.type === "craft") {
    const entry = RECIPE_BY_ID.get(action.recipeId)!;
    itemId = entry.output;
    claimDiscoveryBounty(state, cat.id, itemId);
    for (const input of effectiveRecipeInputs(entry, state.difficulty)) {
      take(cat.inventory, input.itemId, input.quantity);
      reserved[input.itemId] = input.quantity;
    }
  } else if (action.type === "pass") {
    itemId = action.itemId;
    const contract = contractForAction(state, cat, action)!;
    if (contract.currentLeg === 0) reserved[itemId] = 1;
  }
  const contract = action.type === "pass" ? contractForAction(state, cat, action) : undefined;
  const speedReduction = actionSpeedReductionAt(state, cat.position, action.type);
  const baseDuration = Math.max(2_000, ACTION_DURATION_MS * (1 - speedReduction));
  const expectedGainCents = expectedActionGainCents(state, cat, action, (id) => itemPrice(state, id, cat));
  const outputValueCents = action.type === "craft"
    ? itemPrice(state, itemId, cat)
    : undefined;
  cat.action = {
    type: action.type,
    recipeId: action.type === "craft" ? action.recipeId : undefined,
    direction: action.type === "pass" ? action.direction : undefined,
    itemId,
    startedAt: state.simTime,
    endsAt: state.simTime + Math.max(1, baseDuration / state.simulationSpeed),
    reserved,
    lawId,
    contractId: contract?.id,
    expectedGainCents,
    outputValueCents,
    decisionReason,
    speedReduction,
  };
  cat.decisionSerial = (cat.decisionSerial ?? 0) + 1;
  cat.lastDecision = `${lawId} → ${action.type}:${itemId}`;
  maybeAddDecisionSpeech(state, cat, lawId, decisionReason);
  appendAudit(state, { origin: "simulation", kind: "action-start", target: cat.id, ok: true, detail: `${action.type}:${itemId}` });
}

const SPEECH_DIRECTION_LABELS: Record<Direction, string> = {
  north: "北",
  east: "东",
  south: "南",
  west: "西",
};

function maybeAddDecisionSpeech(state: GameState, cat: CatState, lawId: string, reason: string): void {
  const command = cat.action;
  if (!command || command.type === "wait") return;
  if (cat.lastSpeechAt !== null && cat.lastSpeechAt !== undefined && state.simTime < cat.lastSpeechAt + SPEECH_COOLDOWN_MS) return;
  const queuedOrActiveSpeechCount = state.floatingEvents.filter((event) => speechEventIsQueuedOrVisible(event, state.simTime)).length;
  if (queuedOrActiveSpeechCount >= speechCapacityForFrequency(state.speechFrequency)) return;
  const key = [
    state.worldSeed,
    cat.createdIndex,
    cat.decisionSerial ?? 0,
    lawId,
    command.type,
    command.itemId,
    command.direction ?? "",
  ].join("|");
  const roll = speechRoll(key, state.speechFrequency);
  if (!roll.speaks) return;

  const definition = ITEM_BY_ID.get(command.itemId);
  const item = definition?.name ?? command.itemId;
  const direction = command.direction ? `${SPEECH_DIRECTION_LABELS[command.direction]}边` : "";
  const contract = command.contractId ? state.shipmentContracts.find((entry) => entry.id === command.contractId) : undefined;
  const destinationCatId = contract?.routeCatIds[contract.currentLeg + 1];
  const destinationCat = destinationCatId ? state.cats.find((entry) => entry.id === destinationCatId) : undefined;
  const destination = command.type === "pass"
    ? `${direction || "相邻"}的${destinationCat ? `${destinationCat.createdIndex + 1}号猫` : "下一站"}`
    : "";
  const action = formatSpeechAction(command.type, item, destination);
  const law = state.laws.find((entry) => entry.id === lawId);
  const templates = law ? safeSpeechTemplates(law.speechTemplates) : DEFAULT_LAW_SPEECH_TEMPLATES;
  const text = fillSpeechTemplate(templates[roll.templateIndex], {
    law: law ? `《${law.title}》` : "收益准则",
    reason,
    action,
    item,
    direction,
    gain: formatSpeechGain(command.expectedGainCents ?? 0),
  });
  const scheduledAt = state.simTime + roll.delayMs;
  state.floatingEvents.push({
    id: `speech-${state.simTime}-${cat.id}-${cat.decisionSerial ?? 0}`,
    catId: cat.id,
    text,
    createdAt: scheduledAt,
    duration: SPEECH_DURATION_MS,
    kind: "speech",
    lawId: law?.id ?? lawId,
    reason,
    itemId: command.itemId,
    gainCents: command.expectedGainCents ?? 0,
    direction: command.direction,
    destinationCatId,
    scheduledDelayMs: roll.delayMs,
  });
  cat.lastSpeechAt = scheduledAt;
}

export function queueBuildingOrder(state: GameState, targetCatId: string, itemId: ItemId): { ok: boolean; error?: string; order?: BuildingOrder } {
  if (!DEPLOYABLE_BUILDING_IDS.includes(itemId as typeof DEPLOYABLE_BUILDING_IDS[number])) return { ok: false, error: "该物品不能部署为建筑" };
  const recipe = RECIPE_BY_OUTPUT.get(itemId);
  if (!recipe || !state.unlockedRecipes.includes(recipe.id)) return { ok: false, error: "请先解锁对应建筑配方" };
  const cat = state.cats.find((entry) => entry.id === targetCatId);
  if (!cat) return { ok: false, error: "目标猫不存在" };
  if (resourceAt(state, cat.position)) return { ok: false, error: "资源点工位不能部署建筑" };
  if (buildingAt(state, cat.position)) return { ok: false, error: "该工位已经有建筑" };
  if (state.buildingOrders.some((order) => order.targetCatId === targetCatId)) return { ok: false, error: "该工位已有筹建订单" };
  const budgetCents = itemPrice(state, itemId) * 3;
  const demand = openDemandOrder(state, {
    buyerKind: "treasury",
    buyerCatId: null,
    destinationCatId: targetCatId,
    itemId,
    maxDeliveredCents: budgetCents,
    reservedCents: budgetCents,
    planId: null,
  }, (id) => itemPrice(state, id));
  if (!demand) return { ok: false, error: `国库需要冻结 ${budgetCents} 分` };
  const order: BuildingOrder = {
    id: `building-order-${state.nextBuildingOrderIndex}`,
    itemId,
    targetCatId,
    createdAt: state.simTime,
    demandOrderId: demand.id,
    budgetCents,
  };
  state.nextBuildingOrderIndex += 1;
  state.buildingOrders.push(order);
  state.dirtyDecisions = true;
  return { ok: true, order };
}

export function cancelBuildingOrder(state: GameState, orderId: string): { ok: boolean; error?: string } {
  const index = state.buildingOrders.findIndex((order) => order.id === orderId);
  if (index < 0) return { ok: false, error: "筹建订单不存在" };
  const order = state.buildingOrders[index];
  const demand = order.demandOrderId ? state.demandOrders.find((entry) => entry.id === order.demandOrderId) : undefined;
  if (demand && demand.status === "contracted") return { ok: false, error: "订单已经成交，运输合同不可撤销" };
  if (demand?.status === "open") cancelDemandOrder(state, demand.id, "玩家取消建筑订单");
  state.buildingOrders.splice(index, 1);
  state.dirtyDecisions = true;
  return { ok: true };
}

export function dismantleBuilding(state: GameState, buildingId: string): { ok: boolean; error?: string } {
  const index = state.buildings.findIndex((building) => building.id === buildingId);
  if (index < 0) return { ok: false, error: "建筑不存在" };
  const [building] = state.buildings.splice(index, 1);
  state.playerBuildingInventory[building.itemId] = (state.playerBuildingInventory[building.itemId] ?? 0) + 1;
  state.dirtyDecisions = true;
  return { ok: true };
}

export function buildingPlacementFailure(state: GameState, itemId: ItemId, position: Position): string | null {
  if (state.landmarks.some((landmark) => positionKey(landmark.position) === positionKey(position))) return "该格已有地标";
  if (!DEPLOYABLE_BUILDING_IDS.includes(itemId as typeof DEPLOYABLE_BUILDING_IDS[number])) return "该物品不能放置为建筑";
  if (!Number.isInteger(position.x) || !Number.isInteger(position.y)) return "建筑坐标必须是整数";
  if (!isPositionUnlocked(state.unlockedParcels, position)) return "只能放在已开拓土地";
  if (state.cats.some((cat) => cat.position.x === position.x && cat.position.y === position.y)) return "该格已有猫咪工位";
  if (buildingAt(state, position)) return "该格已有建筑";
  if (resourceAt(state, position)) return "资源中心不能放建筑";
  return null;
}

export function placeOwnedBuilding(state: GameState, itemId: ItemId, position: Position): { ok: boolean; error?: string; building?: DeployedBuilding } {
  if ((state.playerBuildingInventory[itemId] ?? 0) < 1) return { ok: false, error: "玩家建筑库没有该建筑" };
  const failure = buildingPlacementFailure(state, itemId, position);
  if (failure) return { ok: false, error: failure };
  const building: DeployedBuilding = {
    id: `building-${state.nextBuildingIndex++}`,
    itemId,
    position: { ...position },
    deployedAt: state.simTime,
  };
  state.buildings.push(building);
  state.playerBuildingInventory[itemId] -= 1;
  if (state.playerBuildingInventory[itemId] <= 0) delete state.playerBuildingInventory[itemId];
  consumeWarehousePurchase(state, itemId, 1);
  state.dirtyDecisions = true;
  return { ok: true, building };
}

export function buyBuildingOffer(state: GameState, offerId: string): { ok: boolean; error?: string } {
  const result = purchaseBuildingOffer(state, offerId);
  if (result.ok) compactGameStateHistory(state);
  return result;
}



function resolveBuildingOrders(state: GameState): void {
  const completed: string[] = [];
  for (const order of [...state.buildingOrders].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    const cat = state.cats.find((entry) => entry.id === order.targetCatId);
    if (!cat || resourceAt(state, cat.position) || buildingAt(state, cat.position)) continue;
    const contract = order.contractId ? state.shipmentContracts.find((entry) => entry.id === order.contractId) : undefined;
    if (!contract || contract.status !== "delivered") continue;
    state.playerBuildingInventory[order.itemId] = (state.playerBuildingInventory[order.itemId] ?? 0) + 1;
    publishWarehouseBroadcast(state, cat.id, order.itemId);
    completed.push(order.id);
    addFloating(state, cat.id, `${ITEM_BY_ID.get(order.itemId)?.emoji ?? "🏗️"} 已送入建筑库`, "gain");
  }
  if (completed.length) state.buildingOrders = state.buildingOrders.filter((order) => !completed.includes(order.id));
}

export function decideIdleCats(state: GameState, eligibleCatIds?: ReadonlySet<string>): void {
  const marketRepair = repairBrokenMarketReferences(state);
  const repairedEligibility = eligibleCatIds
    ? new Set([...eligibleCatIds, ...marketRepair.affectedCatIds])
    : undefined;
  const broadcastCutoff = state.simTime - 60_000 / state.simulationSpeed;
  state.marketBroadcasts = state.marketBroadcasts.filter((broadcast) => (
    broadcast.kind !== "production-event" || broadcast.publishedAt >= broadcastCutoff
  ));
  resolveBuildingOrders(state);
  acceptProfitableOrders(state, (itemId) => itemPrice(state, itemId));
  const landmarkIndex = createLandmarkSpatialIndex(state);
  const spatialMap = catMap(state);
  const eligible = [...state.cats]
    .filter((cat) => !cat.action && (!repairedEligibility || repairedEligibility.has(cat.id)))
    .sort((a, b) => a.createdIndex - b.createdIndex);
  if (eligible.length === 0) return;

  const activeLaws = state.laws.filter((law) => law.status === "active");
  const activeLawPriority = new Map(activeLaws.map((law) => [law.id, state.laws.indexOf(law)]));
  const broadcastSnapshot = broadcastsForCat(state, "*");
  const visibleBroadcastSnapshot = broadcastSnapshot.slice(0, 512);
  const warehouseCounts = new Map<string, number>();
  const craftedCounts = new Map<string, number>();
  const recentCraftedCounts = new Map<string, number>();
  for (const broadcast of visibleBroadcastSnapshot) {
    if (broadcast.kind === "warehouse-stock" && !warehouseCounts.has(broadcast.itemId)) {
      warehouseCounts.set(broadcast.itemId, broadcast.amountCents);
    } else if (broadcast.kind === "production-total" && !craftedCounts.has(broadcast.itemId)) {
      craftedCounts.set(broadcast.itemId, broadcast.amountCents);
    } else if (broadcast.kind === "production-event") {
      recentCraftedCounts.set(broadcast.itemId, (recentCraftedCounts.get(broadcast.itemId) ?? 0) + 1);
    }
  }
  const marketNeedItems = state.unlockedRecipes
    .map((id) => RECIPE_BY_ID.get(id)?.output)
    .filter((itemId): itemId is ItemId => Boolean(itemId))
    .sort((left, right) => (
      (recentCraftedCounts.get(left) ?? 0) - (recentCraftedCounts.get(right) ?? 0)
        || (state.itemStats[left]?.crafted ?? 0) - (state.itemStats[right]?.crafted ?? 0)
        || left.localeCompare(right)
    ));
  type Policy = {
    adjustments: LocalScoreAdjustment[];
    selectorRequested: boolean;
    selectorLawId: string;
    direct?: { action: Exclude<CatAction, null>; lawId: string };
    trace: string[];
  };
  const policies = new Map<string, Policy>();

  // This is the only law authority. Action, scoring, price, credit and
  // bounty instructions are all emitted by the same real shared for-loop.
  for (const cat of eligible) {
    // A cat's overlay is valid only until that cat receives its next snapshot.
    // Other cats may still have locked values for plans/contracts that are
    // being settled in this same simulation step.
    clearEphemeralLawPolicy(state, cat.id);
    const observation = buildObservation(
      state,
      cat,
      spatialMap,
      landmarkIndex,
      broadcastSnapshot,
      visibleBroadcastSnapshot,
    );
    const runtimePolicy = freshLawPolicy();
    const claimedPolicyKeys = new Set<string>();
    const policy = runSharedLawLoop(activeLaws, (law) => {
      const localAdjustments: LocalScoreAdjustment[] = [];
      let requestedSelector = false;
      let policyTouched = false;
      const requestSelector = () => {
        requestedSelector = true;
        return null;
      };
      const result = executeLawSource(law.sourceCode, observation, MAX_LAW_EXECUTION_STEPS, {
        observationIsSnapshot: true,
        canCraft: (recipeOrItemId) => {
          const recipe = RECIPE_BY_ID.get(recipeOrItemId) ?? RECIPE_BY_OUTPUT.get(recipeOrItemId);
          return Boolean(recipe && validateLawProposedAction(state, cat, { type: "craft", recipeId: recipe.id }, spatialMap) === null);
        },
        earnCoins: requestSelector,
        choose: requestSelector,
        weighted: (craftWeight, passWeight) => {
          requestedSelector = true;
          localAdjustments.push(
            { actionType: "craft", itemId: "*", multiplier: craftWeight, bonus: 0, lawId: law.id, lawPriority: activeLawPriority.get(law.id) },
            { actionType: "pass", itemId: "*", multiplier: passWeight, bonus: 0, lawId: law.id, lawPriority: activeLawPriority.get(law.id) },
          );
          return null;
        },
        adjust: (actionType, itemId, multiplier, bonus) => {
          if (!["craft", "pass", "*"].includes(actionType)) return;
          localAdjustments.push({
            actionType: actionType as LocalScoreAdjustment["actionType"],
            itemId,
            multiplier,
            bonus,
            lawId: law.id,
            lawPriority: activeLawPriority.get(law.id),
          });
        },
        warehouseCount: (itemId) => warehouseCounts.get(itemId) ?? 0,
        crafted: (itemId) => craftedCounts.get(itemId) ?? 0,
        recentCrafted: (itemId) => recentCraftedCounts.get(itemId) ?? 0,
        marketNeed: (rank) => marketNeedItems[rank] ?? "",
        setPrice: (itemId, multiplier) => {
          if ((itemId !== "*" && !ITEM_BY_ID.has(itemId)) || !Number.isFinite(multiplier)) return;
          const key = `price:${itemId}`;
          if (claimedPolicyKeys.has(key)) return;
          claimedPolicyKeys.add(key);
          runtimePolicy.priceMultipliers[itemId] = Math.max(0.1, Math.min(10, multiplier));
          policyTouched = true;
        },
        addPrice: (itemId, cents) => {
          if ((itemId !== "*" && !ITEM_BY_ID.has(itemId)) || !Number.isFinite(cents)) return;
          const key = `price-addition:${itemId}`;
          if (claimedPolicyKeys.has(key)) return;
          claimedPolicyKeys.add(key);
          runtimePolicy.priceAdditionsCents[itemId] = Math.max(-1_000_000, Math.min(1_000_000, Math.round(cents)));
          policyTouched = true;
        },
        setCredit: (baseCents, netWorthFactor) => {
          if (claimedPolicyKeys.has("credit") || !Number.isFinite(baseCents) || !Number.isFinite(netWorthFactor)) return;
          claimedPolicyKeys.add("credit");
          runtimePolicy.creditBaseCents = Math.max(0, Math.min(1_000_000, Math.floor(baseCents)));
          runtimePolicy.creditNetWorthFactor = Math.max(0, Math.min(1, netWorthFactor));
          policyTouched = true;
        },
        setBounty: (multiplier) => {
          if (claimedPolicyKeys.has("bounty") || !Number.isFinite(multiplier)) return;
          claimedPolicyKeys.add("bounty");
          runtimePolicy.bountyMultiplier = Math.max(0, Math.min(10, multiplier));
          runtimePolicy.bountyMultiplierSet = true;
          policyTouched = true;
        },
      });
      return {
        action: result.action,
        error: result.error,
        adjustments: localAdjustments,
        selectorRequested: requestedSelector,
        policyTouched,
      };
    }, (action) => validateLawProposedAction(state, cat, action, spatialMap));
    setEphemeralLawPolicy(state, cat.id, runtimePolicy);
    policies.set(cat.id, policy as Policy);
  }

  const plannerAuthorizedCatIds = new Set<string>();
  for (const cat of eligible) {
    const policy = policies.get(cat.id)!;
    if (policy.direct?.action.type === "craft") {
      const prepared = ensureDirectCraftPlan(
        state,
        cat,
        policy.direct.action.recipeId,
        (itemId) => itemPrice(state, itemId, cat),
        policy.direct.lawId,
      );
      if (prepared) plannerAuthorizedCatIds.add(cat.id);
      else policy.trace.push("直接制作未能建立完整原料包融资计划");
    }
    if (!policy.direct && policy.selectorRequested) {
      plannerAuthorizedCatIds.add(cat.id);
    }
    if (plannerAuthorizedCatIds.has(cat.id)) refreshCatMarket(
      state,
      cat,
      (itemId) => itemPrice(state, itemId, cat),
      policy.adjustments,
      policy.direct?.lawId || policy.selectorLawId,
    );
  }
  resolveBuildingOrders(state);
  const spatialPlan = plannerAuthorizedCatIds.size
    ? planLocalLogistics(state, (itemId, cat) => itemPrice(state, itemId, cat), landmarkIndex)
    : {
      assignments: new Map<string, Exclude<CatAction, null>>(),
      decisions: new Map(),
      traces: new Map<string, string[]>(),
      status: [],
    };
  state.logisticsStatus = spatialPlan.status.filter((entry) => entry.componentId.startsWith("local-")
    && plannerAuthorizedCatIds.has(entry.componentId.slice("local-".length)));

  for (const cat of eligible) {
    const policy = policies.get(cat.id)!;
    const trace = [...policy.trace, ...(spatialPlan.traces.get(cat.id) ?? [])];
    const localDecision = policy.adjustments.length
      ? chooseAdjustedLocalDecision(state, cat, (itemId) => itemPrice(state, itemId, cat), policy.adjustments)
      : spatialPlan.decisions.get(cat.id) ?? null;
    const directInvalid = policy.direct
      ? validateAction(state, cat, policy.direct.action, spatialMap)
      : null;
    const selected = policy.direct && directInvalid === null ? {
      ...policy.direct,
      reason: `《${state.laws.find((law) => law.id === policy.direct?.lawId)?.title ?? "统一法规"}》提出直接动作，并通过非亏损校验`,
    } : plannerAuthorizedCatIds.has(cat.id) && localDecision ? {
      action: localDecision.action,
      lawId: localDecision.attributedLawId || policy.direct?.lawId || policy.selectorLawId,
      reason: localDecision.reason,
    } : null;
    if (!selected?.action) {
      cat.decisionTrace = [...trace, "没有法规提出合法动作，进入内部等待"].slice(-8);
      beginWait(state, cat, "法规决策后等待");
      continue;
    }
    const invalid = validateAction(state, cat, selected.action, spatialMap);
    if (invalid) {
      cat.decisionTrace = [...trace, invalid].slice(-8);
      beginWait(state, cat, `动作失效：${invalid}`);
      continue;
    }
    cat.decisionTrace = trace.slice(-8);
    beginAction(state, cat, selected.action, selected.lawId || "shared-law", selected.reason);
  }
  state.dirtyDecisions = false;
}

export function sharedBehaviorHash(): string {
  return SHARED_BEHAVIOR_HASH;
}

export function acknowledgeAchievement(state: GameState, achievementId: string): boolean {
  return acknowledgeAchievementRecord(state, achievementId);
}

function addFloating(state: GameState, catId: string, text: string, kind: "gain" | "sale" | "milestone"): void {
  state.floatingEvents.push({
    id: `float-${state.simTime}-${catId}-${state.floatingEvents.length}`,
    catId,
    text,
    createdAt: state.simTime,
    duration: kind === "milestone" ? 2_400 : 900,
    kind,
  });
}

function discover(state: GameState, itemId: ItemId): void {
  if (state.discoveredItems.includes(itemId)) return;
  state.discoveredItems.push(itemId);
}

function resolveAction(state: GameState, cat: CatState, map: Map<string, CatState>): void {
  const command = cat.action;
  if (!command) return;
  cat.action = null;
  appendAudit(state, { origin: "simulation", kind: "action-complete", target: cat.id, ok: true, detail: command.type });
  if (command.type === "wait") return;
  const definition = ITEM_BY_ID.get(command.itemId)!;
  if (command.type === "craft") {
    const firstCraft = state.itemStats[command.itemId].crafted === 0;
    const craftValueCents = command.outputValueCents ?? itemPrice(state, command.itemId, cat);
    give(cat.inventory, command.itemId, 1);
    state.itemStats[command.itemId].crafted += 1;
    state.totalProductionValueCents += craftValueCents;
    state.recentProductionEvents.push({
      itemId: command.itemId,
      at: state.simTime,
      catId: cat.id,
      valueCents: craftValueCents,
    });
    unlockProductionAchievements(state, command.itemId, firstCraft, grossProductionValuePerMinute(state));
    recordCraftCompletion(state, cat.id, command.itemId);
    publishProductionBroadcast(state, cat.id, command.itemId);
    discover(state, command.itemId);
    const bounty = completeProcurementPlan(state, cat.id, command.itemId);
    if (bounty > 0) applyPrivateIncome(cat, bounty);
    addFloating(state, cat.id, bounty > 0 ? `+1 ${definition.emoji} · 悬赏 ${formatMoney(bounty)}` : `+1 ${definition.emoji}`, command.itemId === "stargate" ? "milestone" : "gain");
    if (command.itemId === "stargate") {
      state.stargatesBuilt += 1;
      state.milestoneAt = state.simTime;
    }
  } else if (command.type === "pass") {
    const result = command.contractId ? settleContractLeg(state, command.contractId) : null;
    if (result) {
      state.itemStats[command.itemId].passed += 1;
      discover(state, command.itemId);
      if (result.recipientCatId) addFloating(state, result.recipientCatId, result.delivered ? `+1 ${definition.emoji}` : `${definition.emoji} 托运中`, "gain");
    } else {
      // Contract cargo lives in ShipmentContract, never in command.reserved.
      // The market repair path has already restored it to the legal owner.
      cat.lastDecision = "运输合同异常，货物与剩余保证金已完成守恒解约";
    }
  }
}


const SIMULATION_PIPELINE_OPERATIONS: SimulationPipelineOperations = {
  catMap,
  resolveAction,
  pruneEphemeralState,
  decideIdleCats,
  recordWealthHistorySample,
  compactGameStateHistory,
};

export function advanceGame(state: GameState, milliseconds: number): void {
  advanceSimulationPipeline(state, milliseconds, SIMULATION_PIPELINE_OPERATIONS);
}

function pruneEphemeralState(state: GameState): void {
  const recentCutoff = state.simTime - 60_000 / state.simulationSpeed;
  state.recentProductionEvents = state.recentProductionEvents.filter((event) => event.at >= recentCutoff);
  state.marketBroadcasts = state.marketBroadcasts.filter((broadcast) => (
    broadcast.kind !== "production-event" || broadcast.publishedAt >= recentCutoff
  ));
  state.floatingEvents = state.floatingEvents.filter((event) => state.simTime - event.createdAt < event.duration);
}


export function nextEnactmentCost(state: GameState): number {
  return Math.max(0, 500 * (state.enactmentCount + 1 - 5));
}

export function unlockRecipe(state: GameState, recipeId: string): { ok: boolean; error?: string; cost?: number } {
  const recipe = RECIPE_BY_ID.get(recipeId);
  if (!recipe) return { ok: false, error: "配方不存在" };
  if (state.unlockedRecipes.includes(recipeId)) return { ok: false, error: "配方已经解锁" };
  const craftedItems = ITEMS.filter((item) => state.itemStats[item.id]?.crafted > 0).map((item) => item.id);
  const missingCertifications = missingProductionCertifications(recipeId, craftedItems);
  if (missingCertifications.length > 0) {
    const missingNames = missingCertifications.map((id) => ITEM_BY_ID.get(id)?.name ?? id);
    return { ok: false, error: `产业认证未完成：请先实际制造 ${missingNames.join("、")}` };
  }
  if (!canUnlockRecipe(recipeId, state.unlockedRecipes, craftedItems)) {
    const missing = recipePrerequisiteIds(recipeId).filter((id) => !state.unlockedRecipes.includes(id));
    return { ok: false, error: `请先解锁 ${missing.join("、")}` };
  }
  const cost = recipeUnlockCost(recipeId);
  if (state.treasuryCoins < cost) return { ok: false, error: `国库需要 ${formatMoney(cost)}` };
  state.treasuryCoins -= cost;
  state.unlockedRecipes.push(recipeId);
  state.unlockedRecipes.sort((left, right) => {
    const leftIndex = [...RECIPE_BY_ID.keys()].indexOf(left);
    const rightIndex = [...RECIPE_BY_ID.keys()].indexOf(right);
    return leftIndex - rightIndex;
  });
  ensureBountyBroadcasts(state);
  state.dirtyDecisions = true;
  return { ok: true, cost };
}

export function enactLaw(state: GameState, draft: LawDraft, insertionIndex = 0): { ok: boolean; error?: string; law?: LawVersion } {
  if (!draft.validation.syntax || !draft.validation.safety) return { ok: false, error: "草案未通过安全校验" };
  const cost = nextEnactmentCost(state);
  if (state.treasuryCoins < cost) return { ok: false, error: `国库需要 ${formatMoney(cost)}` };
  state.treasuryCoins -= cost;
  state.enactmentCount += 1;
  const law: LawVersion = {
    id: `law-${state.enactmentCount}-${Math.round(state.simTime)}`,
    title: draft.title,
    playerText: draft.playerText,
    summary: draft.summary,
    explanation: draft.explanation?.trim() || draft.summary,
    sourceCode: draft.sourceCode,
    astHash: draft.astHash,
    examples: draft.examples,
    warnings: draft.warnings,
    speechTemplates: safeSpeechTemplates(draft.speechTemplates),
    enactedAt: state.simTime,
    program: structuredClone(draft.program),
    hitCount: 0,
    invalidCount: 0,
    consecutiveFaults: 0,
    status: "active",
  };
  state.laws.splice(Math.max(0, Math.min(insertionIndex, state.laws.length)), 0, law);
  state.lawHistory.push(structuredClone(law));
  compactLawHistory(state);
  state.lawbookRevision += 1;
  invalidateEphemeralLawPolicies(state);
  state.dirtyDecisions = true;
  return { ok: true, law };
}

export function reorderLaw(state: GameState, lawId: string, delta: -1 | 1): boolean {
  const index = state.laws.findIndex((law) => law.id === lawId);
  if (index >= 0 && state.laws[index].locked) return false;
  const target = index + delta;
  if (index < 0 || target < 0 || target >= state.laws.length) return false;
  const [law] = state.laws.splice(index, 1);
  state.laws.splice(target, 0, law);
  state.lawbookRevision += 1;
  invalidateEphemeralLawPolicies(state);
  state.dirtyDecisions = true;
  return true;
}

export function repealLaw(state: GameState, lawId: string): { ok: boolean; error?: string } {
  const index = state.laws.findIndex((law) => law.id === lawId && law.status !== "repealed");
  if (index < 0) return { ok: false, error: "法条不存在" };
  if (state.laws[index].locked) return { ok: false, error: "基础经济法不可废止" };
  if (state.treasuryCoins < REPEAL_COST) return { ok: false, error: `国库废止需要 ${formatMoney(REPEAL_COST)}` };
  state.treasuryCoins -= REPEAL_COST;
  const [law] = state.laws.splice(index, 1);
  law.status = "repealed";
  state.lawHistory.push(structuredClone(law));
  compactLawHistory(state);
  state.lawbookRevision += 1;
  invalidateEphemeralLawPolicies(state);
  state.dirtyDecisions = true;
  return { ok: true };
}

export function setPaused(state: GameState, paused: boolean): void {
  state.paused = paused;
}

export function setSpeechFrequency(state: GameState, frequency: number): number {
  const normalized = normalizeSpeechFrequency(frequency);
  state.speechFrequency = normalized;
  const capacity = speechCapacityForFrequency(normalized);
  const candidates = state.floatingEvents
    .filter((event) => speechEventIsQueuedOrVisible(event, state.simTime))
    .sort((left, right) => {
      const visibleDelta = Number(speechEventIsVisible(right, state.simTime)) - Number(speechEventIsVisible(left, state.simTime));
      return visibleDelta || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
    });
  const retainedSpeechIds = new Set(candidates.slice(0, capacity).map((event) => event.id));
  state.floatingEvents = state.floatingEvents.filter((event) => (
    event.kind !== "speech"
    || (!speechEventIsQueuedOrVisible(event, state.simTime) && capacity > 0)
    || retainedSpeechIds.has(event.id)
  ));
  return normalized;
}

export function inventoryTotal(state: GameState, itemId: ItemId): number {
  return state.cats.reduce((total, cat) => total + (cat.inventory[itemId] ?? 0), 0);
}
