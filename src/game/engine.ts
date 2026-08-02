import {
  canUnlockRecipe,
  CATALOG_ANALYSIS,
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
  TUTORIAL_RECIPE_IDS,
} from "./catalog";
import { DEFAULT_DIFFICULTY, difficultyProfile, effectiveRecipeInputs, normalizeDifficulty } from "./difficulty";
import { createStarterScenario } from "./starterScenario";
import { executeLawSource } from "./lawInterpreter";
import { chooseAdjustedLocalAction, chooseWeightedLocalAction, localVisibleCats, planLocalLogistics, type LocalScoreAdjustment } from "./localPlanner";
import { resourceItemAt, resourceItemsAt, siteFailure } from "./logistics";
import {
  applyPrivateIncome,
  bountyBroadcastsForCat,
  broadcastsForCat,
  buildingOfferBroadcastsForCat,
  buyBuildingOffer as purchaseBuildingOffer,
  cancelDemandOrder,
  claimDiscoveryBounty,
  completeProcurementPlan,
  contractActionForCat,
  contractForAction,
  createDiscoveryBounties,
  creditAvailableCents,
  expectedActionGainCents,
  externalNetCents,
  ensureBountyBroadcasts,
  ensureMarketBroadcasts,
  MARKET_SIGNAL_INTERVAL_MS,
  netWorthCents,
  openDemandOrder,
  planForCatPublic,
  readyContractForCat,
  recordSystemLawHit,
  refreshCatMarket,
  settleContractLeg,
  signalsForCat,
  unreservedOwnedQuantity,
  unofferedOwnedQuantity,
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
  const simulationSpeed = Number.isFinite(options.simulationSpeed)
    ? Math.max(1, Math.floor(options.simulationSpeed ?? 1))
    : 1;
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
  }];
  const laws = starter?.laws ?? [];
  const resourceNodes = structuredClone(starterWorld.resourceNodes);
  const state: GameState = {
    schemaVersion: 6,
    difficulty,
    catalogVersion: CATALOG_VERSION,
    worldSeed,
    simTime: 0,
    paused: false,
    cats,
    nextCatIndex: cats.length,
    unlockedParcels: [{ x: 0, y: 0 }],
    resourceNodes,
    buildings: [],
    buildingOffers: [],
    playerBuildingInventory: {},
    nextBuildingOfferIndex: 0,
    buildingOrders: [],
    nextBuildingIndex: 0,
    nextBuildingOrderIndex: 0,
    logisticsStatus: [],
    procurementPlans: [],
    demandOrders: [],
    orderSignals: [],
    marketBroadcasts: [],
    shipmentContracts: [],
    discoveryBounties: createDiscoveryBounties(difficulty),
    marketEvents: [],
    nextProcurementPlanIndex: 0,
    nextDemandOrderIndex: 0,
    nextMarketBroadcastIndex: 0,
    nextContractIndex: 0,
    nextMarketEventIndex: 0,
    nextMarketTickAt: Math.max(1, MARKET_SIGNAL_INTERVAL_MS / simulationSpeed),
    simulationSpeed,
    laws,
    lawHistory: laws.map((law) => structuredClone(law)),
    enactmentCount: 0,
    treasuryCoins: profile.initialTreasuryCents,
    totalSales: 0,
    discoveredItems: [],
    unlockedRecipes: [...INTRO_RECIPE_IDS],
    itemStats: emptyStats(),
    floatingEvents: [],
    stargatesBuilt: 0,
    milestoneAt: null,
    dirtyDecisions: true,
  };
  ensureMarketBroadcasts(state);
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
  };
  state.nextCatIndex += 1;
  state.cats.push(cat);
  state.dirtyDecisions = true;
  return cat;
}

export function buildObservation(state: GameState, cat: CatState, map = catMap(state)): CatObservation {
  const neighbors = {} as CatObservation["neighbors"];
  for (const [direction, offset] of Object.entries(DIRECTION_OFFSETS) as Array<[Direction, Position]>) {
    const neighbor = map.get(`${cat.position.x + offset.x},${cat.position.y + offset.y}`);
    neighbors[direction] = neighbor ? {
      position: { ...neighbor.position },
      inventory: { ...neighbor.inventory },
    } : null;
  }
  const heardOrders = signalsForCat(state, cat.id).slice(0, 32).map((signal) => {
    const order = state.demandOrders.find((entry) => entry.id === signal.orderId)!;
    const broadcast = broadcastsForCat(state, cat.id).find((entry) => entry.kind === "demand-open" && entry.subjectId === signal.orderId);
    return { id: signal.orderId, itemId: order.itemId, effectiveBidCents: signal.effectiveBidCents, sourceCatId: broadcast?.sourceCatId ?? order.destinationCatId };
  });
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
      netWorthCents: netWorthCents(state, cat, (itemId) => itemPrice(state, itemId)),
      creditAvailableCents: creditAvailableCents(state, cat, (itemId) => itemPrice(state, itemId)),
    },
    heardOrders,
    heardBounties,
    heardBuildingOffers,
    broadcasts: broadcastsForCat(state, cat.id).slice(0, 64),
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
    const servesPlan = Boolean(plan && itemDependencyDistance(entry.output, plan.outputItemId) >= 0);
    const servesHeardOrder = signalsForCat(state, cat.id).some((signal) => state.demandOrders.some((order) => (
      order.id === signal.orderId && itemDependencyDistance(entry.output, order.itemId) >= 0
    )));
    const heardBounty = bountyBroadcastsForCat(state, cat.id).some((broadcast) => broadcast.itemId === entry.output);
    const bountyLedger = state.discoveryBounties.find((bounty) => bounty.itemId === entry.output && !bounty.paid);
    const servesBounty = heardBounty && Boolean(bountyLedger
      && (bountyLedger.claimedByCatId === null || bountyLedger.claimedByCatId === cat.id));
    if (!servesPlan && !servesHeardOrder && !servesBounty) return "没有盈利生产计划、已知订单或首次发现悬赏";
    const missing = effectiveRecipeInputs(entry, state.difficulty).find((input) => unofferedOwnedQuantity(state, cat, input.itemId) < input.quantity);
    if (missing) return `缺少 ${missing.itemId}×${missing.quantity}`;
    return expectedActionGainCents(state, cat, action, (itemId) => itemPrice(state, itemId)) < 0
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
  if (unreservedOwnedQuantity(state, cat, action.itemId) < 1) return `没有可用的 ${action.itemId}`;
  return expectedActionGainCents(state, cat, action, (itemId) => itemPrice(state, itemId)) < 0
    ? "预计降低自身净资产"
    : null;
}

function beginAction(state: GameState, cat: CatState, action: Exclude<CatAction, null>, lawId: string): void {
  const reserved: Record<ItemId, number> = {};
  let itemId: ItemId;
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
  } else {
    recordSystemLawHit(state, "starter-law-cent-settlement");
    itemId = action.itemId;
    take(cat.inventory, itemId, 1);
    reserved[itemId] = 1;
  }
  const contract = action.type === "pass" ? contractForAction(state, cat, action) : undefined;
  cat.action = {
    type: action.type,
    recipeId: action.type === "craft" ? action.recipeId : undefined,
    direction: action.type === "pass" ? action.direction : undefined,
    itemId,
    startedAt: state.simTime,
    endsAt: state.simTime + Math.max(1, ACTION_DURATION_MS / state.simulationSpeed),
    reserved,
    lawId,
    contractId: contract?.id,
    expectedGainCents: expectedActionGainCents(state, cat, action, (id) => itemPrice(state, id)),
  };
  cat.lastDecision = `${lawId} → ${action.type}:${itemId}`;
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
  if (!DEPLOYABLE_BUILDING_IDS.includes(itemId as typeof DEPLOYABLE_BUILDING_IDS[number])) return "该物品不能放置为建筑";
  if (!Number.isInteger(position.x) || !Number.isInteger(position.y)) return "建筑坐标必须是整数";
  if (!isPositionUnlocked(state.unlockedParcels, position)) return "只能放在已开拓土地";
  if (state.cats.some((cat) => cat.position.x === position.x && cat.position.y === position.y)) return "该格已有猫咪工位";
  if (buildingAt(state, position)) return "该格已有建筑";
  if (resourceAt(state, position) || resourceItemsAt(state, position).length > 0) return "资源中心和采集格不能放建筑";
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
  state.dirtyDecisions = true;
  return { ok: true, building };
}

export function buyBuildingOffer(state: GameState, offerId: string): { ok: boolean; error?: string } {
  return purchaseBuildingOffer(state, offerId);
}

export interface WarehouseQuote {
  itemId: ItemId;
  availableQuantity: number;
  unitPriceCents: number;
}

function warehouseDirectPrice(state: GameState, itemId: ItemId): number {
  return Math.ceil(itemPrice(state, itemId) * difficultyProfile(state.difficulty).buildingAskMultiplier);
}

export function warehouseQuote(state: GameState, itemId: ItemId): WarehouseQuote {
  if (!ITEM_BY_ID.has(itemId)) return { itemId, availableQuantity: 0, unitPriceCents: 0 };
  const offered = state.buildingOffers.filter((offer) => offer.status === "open" && offer.itemId === itemId
    && state.cats.some((cat) => cat.id === offer.sellerCatId && (cat.inventory[itemId] ?? 0) >= 1));
  const directQuantity = state.cats.reduce((total, cat) => total + unreservedOwnedQuantity(state, cat, itemId), 0);
  const directPrice = warehouseDirectPrice(state, itemId);
  const prices = [...offered.map((offer) => offer.askCents), ...(directQuantity > 0 ? [directPrice] : [])];
  return {
    itemId,
    availableQuantity: offered.length + directQuantity,
    unitPriceCents: prices.length > 0 ? Math.min(...prices) : directPrice,
  };
}

export function buyWarehouseItem(state: GameState, itemId: ItemId): { ok: boolean; error?: string; cost?: number; sellerCatId?: string } {
  if (!ITEM_BY_ID.has(itemId)) return { ok: false, error: "商品不存在" };
  const directPrice = warehouseDirectPrice(state, itemId);
  const candidates: Array<{ kind: "offer" | "direct"; price: number; seller: CatState; offerId?: string }> = [];
  for (const offer of state.buildingOffers.filter((entry) => entry.status === "open" && entry.itemId === itemId)) {
    const seller = state.cats.find((cat) => cat.id === offer.sellerCatId);
    if (seller && (seller.inventory[itemId] ?? 0) >= 1) candidates.push({ kind: "offer", price: offer.askCents, seller, offerId: offer.id });
  }
  for (const seller of state.cats) {
    if (unreservedOwnedQuantity(state, seller, itemId) >= 1) candidates.push({ kind: "direct", price: directPrice, seller });
  }
  candidates.sort((left, right) => left.price - right.price
    || left.seller.createdIndex - right.seller.createdIndex
    || Number(left.kind === "direct") - Number(right.kind === "direct"));
  const selected = candidates[0];
  if (!selected) return { ok: false, error: "猫咪目前没有可出售的现货" };
  if (state.treasuryCoins < selected.price) return { ok: false, error: `国库还差 ${formatMoney(selected.price - state.treasuryCoins)}` };
  if (selected.kind === "offer") {
    const result = purchaseBuildingOffer(state, selected.offerId!);
    return result.ok ? { ok: true, cost: selected.price, sellerCatId: selected.seller.id } : result;
  }
  state.treasuryCoins -= selected.price;
  take(selected.seller.inventory, itemId, 1);
  applyPrivateIncome(selected.seller, selected.price);
  state.playerBuildingInventory[itemId] = (state.playerBuildingInventory[itemId] ?? 0) + 1;
  recordSystemLawHit(state, "starter-law-cent-settlement");
  state.dirtyDecisions = true;
  return { ok: true, cost: selected.price, sellerCatId: selected.seller.id };
}

function resolveBuildingOrders(state: GameState): void {
  const completed: string[] = [];
  for (const order of [...state.buildingOrders].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    const cat = state.cats.find((entry) => entry.id === order.targetCatId);
    if (!cat || resourceAt(state, cat.position) || buildingAt(state, cat.position)) continue;
    const contract = order.contractId ? state.shipmentContracts.find((entry) => entry.id === order.contractId) : undefined;
    if (!contract || contract.status !== "delivered") continue;
    state.playerBuildingInventory[order.itemId] = (state.playerBuildingInventory[order.itemId] ?? 0) + 1;
    completed.push(order.id);
    addFloating(state, cat.id, `${ITEM_BY_ID.get(order.itemId)?.emoji ?? "🏗️"} 已送入建筑库`, "gain");
  }
  if (completed.length) state.buildingOrders = state.buildingOrders.filter((order) => !completed.includes(order.id));
}

export function decideIdleCats(state: GameState): void {
  resolveBuildingOrders(state);
  for (const cat of [...state.cats].sort((a, b) => a.createdIndex - b.createdIndex)) {
    refreshCatMarket(state, cat, (itemId) => itemPrice(state, itemId));
  }
  resolveBuildingOrders(state);
  const spatialPlan = planLocalLogistics(state, (itemId) => itemPrice(state, itemId));
  const spatialMap = catMap(state);
  state.logisticsStatus = spatialPlan.status;
  for (const cat of [...state.cats].sort((a, b) => a.createdIndex - b.createdIndex)) {
    if (cat.action) continue;
    const trace = spatialPlan.traces.get(cat.id) ?? [];
    let action: Exclude<CatAction, null> | undefined = contractActionForCat(state, cat) ?? undefined;
    let lawId = action ? "binding-contract" : "local-greedy";
    const observation = buildObservation(state, cat, spatialMap);
    const law = state.laws.find((entry) => entry.status === "active" && entry.category === "behavior");
    if (law && !action) {
      const scoreAdjustments: LocalScoreAdjustment[] = [];
      const chooseAdjusted = () => scoreAdjustments.length === 0
        ? spatialPlan.assignments.get(cat.id) ?? null
        : chooseAdjustedLocalAction(state, cat, (itemId) => itemPrice(state, itemId), scoreAdjustments);
      const result = executeLawSource(law.sourceCode, observation, 200, {
        canCraft: (recipeId) => {
          const candidate: Exclude<CatAction, null> = { type: "craft", recipeId };
          return validateAction(state, cat, candidate, spatialMap) === null;
        },
        earnCoins: chooseAdjusted,
        weighted: (craftWeight, passWeight, sellWeight) => chooseWeightedLocalAction(
          state,
          cat,
          (itemId) => itemPrice(state, itemId),
          { craft: craftWeight, pass: passWeight, sell: sellWeight },
        ),
        adjust: (actionType, itemId, multiplier, bonus) => {
          if (!["craft", "pass", "sell", "*"].includes(actionType)) return;
          scoreAdjustments.push({
            actionType: actionType as LocalScoreAdjustment["actionType"],
            itemId,
            multiplier,
            bonus,
          });
        },
        choose: chooseAdjusted,
      });
      if (result.error) {
        law.invalidCount += 1;
        law.consecutiveFaults += 1;
        trace.push(`《${law.title}》异常：${result.error}`);
        if (law.consecutiveFaults >= 3) {
          law.status = "quarantined";
          trace.push(`《${law.title}》连续异常，已隔离`);
        }
      } else if (result.action) {
        const invalid = validateAction(state, cat, result.action, spatialMap);
        if (invalid) {
        law.invalidCount += 1;
        law.consecutiveFaults += 1;
        trace.push(`《${law.title}》跳过：${invalid}`);
        } else {
          law.hitCount += 1;
          law.consecutiveFaults = 0;
          action = result.action;
          lawId = law.id;
          trace.push(`《${law.title}》命中全体共享逻辑`);
        }
      }
    }
    action ??= spatialPlan.assignments.get(cat.id);
    cat.decisionTrace = trace.slice(-8);
    if (!action) {
      cat.lastDecision = trace[0] ?? "没有可执行的赚钱动作";
      continue;
    }
    const invalid = validateAction(state, cat, action, spatialMap);
    if (invalid) {
      cat.lastDecision = invalid;
      cat.decisionTrace = [...trace, invalid].slice(-8);
      continue;
    }
    beginAction(state, cat, action, lawId);
  }
  state.dirtyDecisions = false;
}

function canCraftRecipe(inventory: Record<ItemId, number>, recipeId: string, difficulty: GameState["difficulty"]): boolean {
  const entry = RECIPE_BY_ID.get(recipeId);
  return Boolean(entry && effectiveRecipeInputs(entry, difficulty).every((input) => (inventory[input.itemId] ?? 0) >= input.quantity));
}

function planTowardRecipe(state: GameState, inventory: Record<ItemId, number>, recipeId: string, visiting = new Set<string>()): CatAction {
  if (visiting.has(recipeId) || !state.unlockedRecipes.includes(recipeId)) return null;
  const entry = RECIPE_BY_ID.get(recipeId);
  if (!entry) return null;
  if (canCraftRecipe(inventory, recipeId, state.difficulty)) return { type: "craft", recipeId };
  visiting.add(recipeId);
  for (const input of effectiveRecipeInputs(entry, state.difficulty)) {
    if ((inventory[input.itemId] ?? 0) >= input.quantity) continue;
    const source = RECIPE_BY_OUTPUT.get(input.itemId);
    if (!source) continue;
    const action = planTowardRecipe(state, inventory, source.id, visiting);
    if (action) return action;
  }
  return null;
}

export function chooseCoinAction(state: GameState, cat: CatState): CatAction {
  const introTarget = nextUndiscoveredIntroRecipe(state);
  if (introTarget) return planTowardRecipe(state, cat.inventory, introTarget.id);
  const unlocked = state.unlockedRecipes
    .map((id) => RECIPE_BY_ID.get(id))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  const advanced = unlocked.filter((entry) => entry.inputs.length > 0);
  if (advanced.length === 0) {
    const bases = unlocked.filter((entry) => entry.inputs.length === 0);
    const target = bases[cat.createdIndex % Math.max(1, bases.length)];
    if (!target) return null;
    if ((cat.inventory[target.output] ?? 0) > 0) return { type: "sell", itemId: target.output };
    return { type: "craft", recipeId: target.id };
  }

  advanced.sort((left, right) => {
    const leftPrice = itemPrice(state, left.output);
    const rightPrice = itemPrice(state, right.output);
    const leftRate = leftPrice / (CATALOG_ANALYSIS.workUnits[left.output] + 1);
    const rightRate = rightPrice / (CATALOG_ANALYSIS.workUnits[right.output] + 1);
    return rightRate - leftRate || rightPrice - leftPrice || left.id.localeCompare(right.id);
  });
  const target = advanced[0];
  if ((cat.inventory[target.output] ?? 0) > 0) return { type: "sell", itemId: target.output };
  const action = planTowardRecipe(state, cat.inventory, target.id);
  if (action) return action;
  const sellable = Object.keys(cat.inventory)
    .filter((id) => (cat.inventory[id] ?? 0) > 0 && ITEM_BY_ID.has(id))
    .sort((left, right) => itemPrice(state, right) - itemPrice(state, left))[0];
  return sellable ? { type: "sell", itemId: sellable } : null;
}

function nextUndiscoveredIntroRecipe(state: GameState) {
  return TUTORIAL_RECIPE_IDS
    .map((id) => RECIPE_BY_ID.get(id))
    .find((entry) => entry
      && state.unlockedRecipes.includes(entry.id)
      && !state.discoveredItems.includes(entry.output));
}

export function activePriceLaw(state: GameState, itemId: ItemId): LawVersion | undefined {
  return state.laws.find((law) => law.status === "active" && law.category === "price" && law.priceMultiplier !== null
    && (law.priceItemId === "*" || law.priceItemId === itemId));
}

export function itemPrice(state: GameState, itemId: ItemId): number {
  const base = CATALOG_ANALYSIS.basePrices[itemId] ?? 1;
  const law = activePriceLaw(state, itemId);
  return Math.max(1, Math.ceil(base * 100 * (law?.priceMultiplier ?? 1)));
}

export function formatMoney(cents: number): string {
  return `${(Math.max(0, cents) / 100).toFixed(2)} 🪙`;
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
  const definition = ITEM_BY_ID.get(command.itemId)!;
  if (command.type === "craft") {
    give(cat.inventory, command.itemId, 1);
    state.itemStats[command.itemId].crafted += 1;
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
      for (const [itemId, quantity] of Object.entries(command.reserved)) give(cat.inventory, itemId, quantity);
      cat.lastDecision = "运输合同异常，物品已退回";
    }
  } else {
    const value = itemPrice(state, command.itemId);
    const priceLaw = activePriceLaw(state, command.itemId);
    if (priceLaw) priceLaw.hitCount += 1;
    const taxLaw = state.laws.find((law) => law.status === "active" && law.category === "tax" && law.taxRate !== null);
    const rate = taxLaw?.taxRate ?? 0;
    const tax = rate > 0 ? Math.min(value, Math.ceil(value * rate)) : 0;
    const personalIncome = value - tax;
    applyPrivateIncome(cat, personalIncome);
    state.treasuryCoins += tax;
    state.totalSales += value;
    state.itemStats[command.itemId].sold += 1;
    state.itemStats[command.itemId].revenue += value;
    const saleText = tax === 0 ? `+${formatMoney(value)}` : personalIncome === 0 ? `税 ${formatMoney(tax)}` : `+${formatMoney(personalIncome)} · 税${formatMoney(tax)}`;
    addFloating(state, cat.id, saleText, "sale");
  }
  state.dirtyDecisions = true;
}

export function advanceGame(state: GameState, milliseconds: number): void {
  if (state.paused || !Number.isFinite(milliseconds) || milliseconds <= 0) return;
  const target = state.simTime + milliseconds;
  if (state.dirtyDecisions) decideIdleCats(state);
  while (true) {
    const nextAction = state.cats.reduce((time, cat) => cat.action && cat.action.endsAt < time ? cat.action.endsAt : time, Number.POSITIVE_INFINITY);
    const next = Math.min(nextAction, state.nextMarketTickAt);
    if (next > target) break;
    state.simTime = next;
    const map = catMap(state);
    const completing = state.cats.filter((cat) => cat.action?.endsAt === next).sort((a, b) => a.createdIndex - b.createdIndex);
    for (const cat of completing) resolveAction(state, cat, map);
    const marketTick = state.nextMarketTickAt === next;
    if (marketTick) {
      state.nextMarketTickAt += Math.max(1, MARKET_SIGNAL_INTERVAL_MS / state.simulationSpeed);
    }
    if (completing.length > 0 || marketTick) decideIdleCats(state);
  }
  state.simTime = target;
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
    sourceCode: draft.sourceCode,
    astHash: draft.astHash,
    examples: draft.examples,
    warnings: draft.warnings,
    enactedAt: state.simTime,
    category: draft.category,
    taxRate: draft.category === "tax" ? draft.taxRate : null,
    priceItemId: draft.category === "price" ? draft.priceItemId : null,
    priceMultiplier: draft.category === "price" ? draft.priceMultiplier : null,
    hitCount: 0,
    invalidCount: 0,
    consecutiveFaults: 0,
    status: "active",
  };
  if (draft.category === "behavior") {
    for (const previous of state.laws.filter((entry) => entry.category === "behavior" && entry.status === "active")) {
      previous.status = "repealed";
      state.lawHistory.push(structuredClone(previous));
    }
    state.laws = state.laws.filter((entry) => entry.category !== "behavior");
    insertionIndex = 0;
  }
  state.laws.splice(Math.max(0, Math.min(insertionIndex, state.laws.length)), 0, law);
  state.lawHistory.push(structuredClone(law));
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
  state.dirtyDecisions = true;
  return { ok: true };
}

export function setPaused(state: GameState, paused: boolean): void {
  state.paused = paused;
}

export function inventoryTotal(state: GameState, itemId: ItemId): number {
  return state.cats.reduce((total, cat) => total + (cat.inventory[itemId] ?? 0), 0);
}
