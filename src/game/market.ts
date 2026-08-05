import {
  CATALOG_ANALYSIS,
  DEPLOYABLE_BUILDING_IDS,
  ITEMS,
  ITEM_BY_ID,
  RECIPES,
  RECIPE_BY_ID,
  RECIPE_BY_OUTPUT,
  itemDependencyDistance,
} from "./catalog";
import { difficultyProfile, effectiveRecipeInputs } from "./difficulty";
import { resourceItemAt, siteFailure } from "./logistics";
import { landmarkEffectsAt } from "./landmarks";
import type {
  CatAction,
  CatState,
  DemandOrder,
  Direction,
  DiscoveryBounty,
  GameState,
  ItemId,
  MarketBroadcast,
  MarketBroadcastKind,
  OrderSignal,
  ProcurementPlan,
  ShipmentContract,
} from "./types";
import { recordProductionPlan } from "./productionHistory";
import { positionKey } from "./world";
import { recordWarehousePurchase } from "./warehouse";
import { ephemeralLawPolicy } from "./ephemeralLawPolicy";

// Broadcasts are immediate. This interval only wakes idle cats for a periodic
// market review, so one normal action duration is sufficient.
export const MARKET_SIGNAL_INTERVAL_MS = 5_000;
export const MAX_SIGNALS_PER_CAT = ITEMS.length;
// Order information is a direct global broadcast. The only visibility bound
// is the total observation budget; physical goods still move one adjacent-cat
// hop at a time. Keeping a separate two-orders-per-item cap silently hid valid
// lower bids and prevented parallel suppliers from accepting them.
export const MAX_SIGNALS_PER_ITEM = MAX_SIGNALS_PER_CAT;
export const BASE_CREDIT_CENTS = 2_500;
export const LOAN_RATE = 0.02;
const MAX_CARRIER_FEE_CENTS = 25;
const MIN_PLAN_PROFIT_CENTS = 1;


const DIRECTIONS: Array<[Direction, number, number]> = [
  ["north", 0, -1],
  ["east", 1, 0],
  ["south", 0, 1],
  ["west", -1, 0],
];

function stableIdCompare(left: string, right: string): number {
  const leftMatch = left.match(/^(.*?)(\d+)$/);
  const rightMatch = right.match(/^(.*?)(\d+)$/);
  if (leftMatch && rightMatch && leftMatch[1] === rightMatch[1]) {
    const numeric = Number(leftMatch[2]) - Number(rightMatch[2]);
    if (numeric !== 0) return numeric;
  }
  return left.localeCompare(right);
}

export function recordSystemLawHit(state: GameState, lawId: string): void {
  const law = state.laws.find((entry) => entry.id === lawId && entry.status === "active");
  if (law) law.hitCount += 1;
}

export function createDiscoveryBounties(
  difficulty: GameState["difficulty"] = 2,
  _laws: GameState["laws"] = [],
): DiscoveryBounty[] {
  const multiplier = difficultyProfile(difficulty).bountyMultiplier;
  return RECIPES.map((recipe) => {
    return {
      itemId: recipe.output,
      amountCents: Math.round((CATALOG_ANALYSIS.basePrices[recipe.output] ?? 1) * 100 * multiplier),
      claimedByCatId: null,
      paid: false,
    };
  });
}

function publishMarketBroadcast(
  state: GameState,
  input: Omit<MarketBroadcast, "id" | "publishedAt">,
): MarketBroadcast {
  const broadcast: MarketBroadcast = {
    ...input,
    id: `broadcast-${state.nextMarketBroadcastIndex++}`,
    publishedAt: state.simTime,
  };
  // Production events have unique subjects, so scanning and reallocating the
  // whole broadcast log cannot remove anything. Stable subjects are replaced
  // in place; this keeps global broadcasts cheap during accelerated tests.
  if (broadcast.kind === "production-event") {
    state.marketBroadcasts.push(broadcast);
  } else {
    const existing = state.marketBroadcasts.findIndex((entry) => entry.subjectId === broadcast.subjectId);
    if (existing >= 0) state.marketBroadcasts[existing] = broadcast;
    else state.marketBroadcasts.push(broadcast);
  }
  state.dirtyDecisions = true;
  return broadcast;
}

export function publishProductionBroadcast(state: GameState, catId: string, itemId: ItemId): void {
  publishMarketBroadcast(state, {
    kind: "production-event",
    subjectId: `production:${itemId}:${state.simTime}:${state.nextMarketBroadcastIndex}`,
    itemId,
    sourceCatId: catId,
    amountCents: 1,
    reason: null,
  });
  publishMarketBroadcast(state, {
    kind: "production-total",
    subjectId: `production-total:${itemId}`,
    itemId,
    sourceCatId: catId,
    amountCents: state.itemStats[itemId]?.crafted ?? 0,
    reason: null,
  });
}

export function publishWarehouseBroadcast(state: GameState, sourceCatId: string, itemId: ItemId): void {
  if (!state.cats.some((cat) => cat.id === sourceCatId)) return;
  publishMarketBroadcast(state, {
    kind: "warehouse-stock",
    subjectId: `warehouse:${itemId}`,
    itemId,
    sourceCatId,
    amountCents: state.playerBuildingInventory[itemId] ?? 0,
    reason: "玩家仓库由交易参与猫即时广播",
  });
}

function latestBroadcast(state: GameState, subjectId: string, kinds: readonly MarketBroadcastKind[]): MarketBroadcast | undefined {
  for (let index = state.marketBroadcasts.length - 1; index >= 0; index -= 1) {
    const entry = state.marketBroadcasts[index];
    if (entry.subjectId === subjectId && kinds.includes(entry.kind)) return entry;
  }
  return undefined;
}

export function broadcastsForCat(state: GameState, _catId: string): MarketBroadcast[] {
  return [...state.marketBroadcasts].reverse();
}

export function publishBountySignal(state: GameState, itemId: ItemId, status: "open" | "closed", sourceCatId?: string): void {
  const source = state.cats.find((cat) => cat.id === sourceCatId) ?? state.cats[0];
  const bounty = state.discoveryBounties.find((entry) => entry.itemId === itemId);
  if (!source || !bounty) return;
  publishMarketBroadcast(state, {
    kind: status === "open" ? "bounty-open" : "bounty-closed",
    subjectId: `bounty:${itemId}`,
    itemId,
    sourceCatId: source.id,
    amountCents: effectiveBountyAmountCents(state, itemId, source),
    reason: status === "closed" ? "首次发现悬赏已经结案" : null,
  });
}

export function ensureBountyBroadcasts(state: GameState): void {
  const unlockedOutputs = new Set(state.unlockedRecipes.map((id) => RECIPE_BY_ID.get(id)?.output).filter(Boolean));
  for (const bounty of state.discoveryBounties) {
    if (bounty.paid || !unlockedOutputs.has(bounty.itemId)) continue;
    const latest = latestBroadcast(state, `bounty:${bounty.itemId}`, ["bounty-open", "bounty-closed"]);
    if (!latest) publishBountySignal(state, bounty.itemId, "open");
  }
}

export function ensureMarketBroadcasts(state: GameState): void {
  ensureBountyBroadcasts(state);
  for (const order of state.demandOrders) {
    const latest = latestBroadcast(state, order.id, ["demand-open", "demand-contracted", "demand-cancelled"]);
    if (latest) continue;
    const source = state.cats.find((cat) => cat.id === order.destinationCatId) ?? state.cats[0];
    if (!source) continue;
    publishMarketBroadcast(state, {
      kind: order.status === "open" ? "demand-open" : order.status === "contracted" ? "demand-contracted" : "demand-cancelled",
      subjectId: order.id,
      itemId: order.itemId,
      sourceCatId: source.id,
      amountCents: order.maxDeliveredCents,
      reason: order.closeReason,
    });
  }
  for (const offer of state.buildingOffers) {
    const latest = latestBroadcast(state, offer.id, ["building-offer-open", "building-offer-closed"]);
    if (latest) continue;
    const source = state.cats.find((cat) => cat.id === offer.sellerCatId) ?? state.cats[0];
    if (!source) continue;
    publishMarketBroadcast(state, {
      kind: offer.status === "open" ? "building-offer-open" : "building-offer-closed",
      subjectId: offer.id,
      itemId: offer.itemId,
      sourceCatId: source.id,
      amountCents: offer.askCents,
      reason: offer.closeReason,
    });
  }
  const relay = state.cats[0];
  if (!relay) return;
  for (const { id: item } of ITEMS) {
    const crafted = state.itemStats[item]?.crafted ?? 0;
    const production = latestBroadcast(state, `production-total:${item}`, ["production-total"]);
    if (crafted > 0 && production?.amountCents !== crafted) {
      publishMarketBroadcast(state, {
        kind: "production-total",
        subjectId: `production-total:${item}`,
        itemId: item,
        sourceCatId: relay.id,
        amountCents: crafted,
        reason: "存档统计由首只猫重新广播",
      });
    }
    const stock = state.playerBuildingInventory[item] ?? 0;
    const warehouse = latestBroadcast(state, `warehouse:${item}`, ["warehouse-stock"]);
    if ((stock > 0 || warehouse) && warehouse?.amountCents !== stock) publishWarehouseBroadcast(state, relay.id, item);
  }
}

export function bountyBroadcastsForCat(state: GameState, _catId: string): MarketBroadcast[] {
  const latestByItem = new Map<ItemId, MarketBroadcast>();
  for (let index = state.marketBroadcasts.length - 1; index >= 0; index -= 1) {
    const broadcast = state.marketBroadcasts[index];
    if (broadcast.kind !== "bounty-open" && broadcast.kind !== "bounty-closed") continue;
    if (!latestByItem.has(broadcast.itemId)) latestByItem.set(broadcast.itemId, broadcast);
  }
  const cat = state.cats.find((entry) => entry.id === _catId) ?? state.cats[0];
  return [...latestByItem.values()]
    .filter((entry) => entry.kind === "bounty-open")
    .map((entry) => ({
      ...entry,
      amountCents: effectiveBountyAmountCents(state, entry.itemId, cat),
    }));
}

/**
 * Discovery bounties keep their immutable catalog baseline in GameState. A
 * law may only provide a temporary multiplier through the runtime overlay.
 */
export function effectiveBountyAmountCents(state: GameState, itemId: ItemId, cat = state.cats[0]): number {
  const bounty = state.discoveryBounties.find((entry) => entry.itemId === itemId);
  if (!bounty) return 0;
  const policy = ephemeralLawPolicy(state, cat);
  if (policy.bountyMultiplierSet !== true) return Math.max(0, Math.round(bounty.amountCents));
  const defaultMultiplier = Math.max(1, difficultyProfile(state.difficulty).bountyMultiplier);
  return Math.max(0, Math.round(bounty.amountCents * policy.bountyMultiplier / defaultMultiplier));
}

export function buildingOfferBroadcastsForCat(state: GameState, _catId: string): MarketBroadcast[] {
  const latestByOffer = new Map<string, MarketBroadcast>();
  for (let index = state.marketBroadcasts.length - 1; index >= 0; index -= 1) {
    const broadcast = state.marketBroadcasts[index];
    if (broadcast.kind !== "building-offer-open" && broadcast.kind !== "building-offer-closed") continue;
    if (!latestByOffer.has(broadcast.subjectId)) latestByOffer.set(broadcast.subjectId, broadcast);
  }
  return [...latestByOffer.values()].filter((entry) => entry.kind === "building-offer-open");
}

export function buildingOfferReservedQuantity(state: GameState, catId: string, itemId: ItemId): number {
  return state.buildingOffers.filter((offer) => offer.status === "open"
    && offer.sellerCatId === catId && offer.itemId === itemId).length;
}

export function externalNetCents(_state: GameState, itemId: ItemId, priceOf: (itemId: ItemId) => number): number {
  return Math.max(0, priceOf(itemId));
}

/** Net liquidation value at a cat's current site, including landmark sale bonus. */
export function externalNetCentsAt(state: GameState, itemId: ItemId, priceOf: (itemId: ItemId) => number, cat: CatState): number {
  const gross = Math.ceil(priceOf(itemId) * (1 + landmarkEffectsAt(state, cat.position).saleValueBonus));
  return Math.max(0, gross);
}

export function netWorthCents(state: GameState, cat: CatState, priceOf: (itemId: ItemId) => number): number {
  const inventoryValue = Object.entries(cat.inventory).reduce((sum, [itemId, quantity]) => (
    sum + Math.max(0, quantity) * externalNetCents(state, itemId, priceOf)
  ), 0);
  const inTransit = state.shipmentContracts.reduce((sum, contract) => (
    contract.status !== "delivered" && contract.buyerKind === "cat" && contract.buyerCatId === cat.id
      ? sum + Math.min(contract.escrowCents, externalNetCents(state, contract.itemId, priceOf))
      : sum
  ), 0);
  return cat.coins + inventoryValue + inTransit - cat.debtCents;
}

export function creditLimitCents(state: GameState, cat: CatState, priceOf: (itemId: ItemId) => number): number {
  const policy = ephemeralLawPolicy(state, cat);
  return policy.creditBaseCents
    + landmarkEffectsAt(state, cat.position).creditBonusCents
    + Math.round(Math.max(0, netWorthCents(state, cat, priceOf)) * policy.creditNetWorthFactor);
}

export function creditAvailableCents(state: GameState, cat: CatState, priceOf: (itemId: ItemId) => number): number {
  return Math.max(0, creditLimitCents(state, cat, priceOf) - cat.debtCents);
}

export function buyingPowerCents(state: GameState, cat: CatState, priceOf: (itemId: ItemId) => number): number {
  return Math.max(0, cat.coins + creditAvailableCents(state, cat, priceOf) - cat.escrowReservedCents);
}

export function applyPrivateIncome(cat: CatState, amountCents: number): void {
  let remaining = Math.max(0, Math.floor(amountCents));
  const repaid = Math.min(cat.debtCents, remaining);
  cat.debtCents -= repaid;
  remaining -= repaid;
  cat.coins += remaining;
}

function pushLifecycle(
  state: GameState,
  order: DemandOrder,
  kind: "contracted" | "cancelled",
  reason: string,
  sourceCatId?: string,
): void {
  state.marketEvents.push({
    id: `market-event-${state.nextMarketEventIndex++}`,
    orderId: order.id,
    kind,
    createdAt: state.simTime,
    reason,
  });
  state.marketEvents = state.marketEvents.slice(-64);
  const source = state.cats.find((cat) => cat.id === sourceCatId)
    ?? state.cats.find((cat) => cat.id === order.destinationCatId)
    ?? state.cats[0];
  if (source) {
    publishMarketBroadcast(state, {
      kind: kind === "contracted" ? "demand-contracted" : "demand-cancelled",
      subjectId: order.id,
      itemId: order.itemId,
      sourceCatId: source.id,
      amountCents: order.maxDeliveredCents,
      reason,
    });
  }
}

function releaseReservation(state: GameState, order: DemandOrder): void {
  if (order.buyerKind === "cat") {
    const buyer = state.cats.find((cat) => cat.id === order.buyerCatId);
    if (buyer) buyer.escrowReservedCents = Math.max(0, buyer.escrowReservedCents - order.reservedCents);
  } else {
    state.treasuryCoins += order.reservedCents;
  }
}

export function cancelDemandOrder(state: GameState, orderId: string, reason: string): boolean {
  const order = state.demandOrders.find((entry) => entry.id === orderId);
  if (!order || order.status !== "open") return false;
  order.status = "cancelled";
  order.closedAt = state.simTime;
  order.closeReason = reason;
  releaseReservation(state, order);
  pushLifecycle(state, order, "cancelled", reason, order.destinationCatId);
  state.dirtyDecisions = true;
  return true;
}

export function openDemandOrder(
  state: GameState,
  input: Omit<DemandOrder, "id" | "createdAt" | "status" | "closedAt" | "closeReason">,
  priceOf: (itemId: ItemId) => number,
): DemandOrder | null {
  if (!ITEM_BY_ID.has(input.itemId) || input.maxDeliveredCents <= 0) return null;
  if (input.buyerKind === "cat") {
    const buyer = state.cats.find((cat) => cat.id === input.buyerCatId);
    if (!buyer || buyingPowerCents(state, buyer, priceOf) < input.reservedCents) return null;
    buyer.escrowReservedCents += input.reservedCents;
  } else {
    if (state.treasuryCoins < input.reservedCents) return null;
    state.treasuryCoins -= input.reservedCents;
  }
  const order: DemandOrder = {
    ...input,
    id: `order-${state.nextDemandOrderIndex++}`,
    createdAt: state.simTime,
    status: "open",
    closedAt: null,
    closeReason: null,
  };
  state.demandOrders.push(order);
  publishMarketBroadcast(state, {
    kind: "demand-open",
    subjectId: order.id,
    itemId: order.itemId,
    sourceCatId: order.destinationCatId,
    amountCents: order.maxDeliveredCents,
    reason: null,
  });
  return order;
}

function signalSort(left: OrderSignal, right: OrderSignal): number {
  return right.effectiveBidCents - left.effectiveBidCents
    || left.hops - right.hops
    || stableIdCompare(left.orderId, right.orderId)
    || left.routeCatIds.join("/").localeCompare(right.routeCatIds.join("/"));
}

function trimSignalCache(state: GameState, signals: OrderSignal[]): OrderSignal[] {
  const perItem = new Map<string, number>();
  const kept: OrderSignal[] = [];
  for (const signal of [...signals].sort(signalSort)) {
    const key = `${signal.catId}:${signal.orderId}`;
    if (kept.some((entry) => `${entry.catId}:${entry.orderId}` === key)) continue;
    const orderItem = state.demandOrders.find((order) => order.id === signal.orderId)?.itemId ?? signal.orderId;
    const itemKey = `${signal.catId}:${orderItem}`;
    const count = perItem.get(itemKey) ?? 0;
    if (count >= MAX_SIGNALS_PER_ITEM) continue;
    const catCount = kept.filter((entry) => entry.catId === signal.catId).length;
    if (catCount >= MAX_SIGNALS_PER_CAT) continue;
    perItem.set(itemKey, count + 1);
    kept.push(signal);
  }
  return kept;
}

export function propagateOrderSignals(_state: GameState): boolean {
  // Kept as a compatibility hook for older callers. Information broadcasts
  // are global and immediate; only physical shipments traverse cat chains.
  return false;
}

export function signalsForCat(state: GameState, _catId: string): OrderSignal[] {
  const latestByOrder = new Map<string, MarketBroadcast>();
  for (let index = state.marketBroadcasts.length - 1; index >= 0; index -= 1) {
    const broadcast = state.marketBroadcasts[index];
    if (!broadcast.kind.startsWith("demand-")) continue;
    if (!latestByOrder.has(broadcast.subjectId)) latestByOrder.set(broadcast.subjectId, broadcast);
  }
  const openIds = new Set([...latestByOrder.values()].filter((entry) => entry.kind === "demand-open").map((entry) => entry.subjectId));
  return trimSignalCache(state, state.demandOrders
    .filter((order) => order.status === "open" && openIds.has(order.id))
    .map((order) => ({
      orderId: order.id,
      catId: "*",
      routeCatIds: [order.destinationCatId],
      hops: 0,
      estimatedFreightCents: 0,
      effectiveBidCents: order.maxDeliveredCents,
      receivedAt: order.createdAt,
    }))).sort(signalSort);
}

function planForCat(state: GameState, catId: string): ProcurementPlan | undefined {
  return state.procurementPlans.find((plan) => plan.catId === catId && plan.status === "active");
}

function estimatedInputCost(state: GameState, recipeId: string, priceOf: (itemId: ItemId) => number): number {
  const recipe = RECIPE_BY_ID.get(recipeId);
  if (!recipe) return Number.POSITIVE_INFINITY;
  return effectiveRecipeInputs(recipe, state.difficulty).reduce((sum, input) => (
    sum + input.quantity * externalNetCents(state, input.itemId, priceOf)
  ), 0);
}

/**
 * Read-only compatibility estimate for inspectors and older callers. Real
 * plans never fund orders from this estimate: they atomically lock a named
 * supplier, route, freight schedule and whole-basket financing certificate.
 */
export function productionOrderBidCents(
  state: GameState,
  _recipeId: string,
  inputItemId: ItemId,
  priceOf: (itemId: ItemId) => number,
): number {
  // Compatibility estimate for inspectors. Plans use a firm seller/route
  // quote and never commit money from this estimate.
  return externalNetCents(state, inputItemId, priceOf) + MIN_PLAN_PROFIT_CENTS;
}

export function productionOrderBudgetCents(
  state: GameState,
  recipeId: string,
  priceOf: (itemId: ItemId) => number,
): number {
  const recipe = RECIPE_BY_ID.get(recipeId);
  if (!recipe) return 0;
  return effectiveRecipeInputs(recipe, state.difficulty).reduce((sum, input) => (
    sum + input.quantity * productionOrderBidCents(state, recipe.id, input.itemId, priceOf)
  ), 0);
}

export function hasPriceSensitiveJobDemand(state: GameState, recipeId: string): boolean {
  const recipe = RECIPE_BY_ID.get(recipeId);
  return Boolean(recipe && state.unlockedRecipes.includes(recipe.id));
}

function maximumLoanFeeCents(principalCents: number): number {
  return principalCents > 0 ? Math.max(1, Math.ceil(principalCents * LOAN_RATE)) : 0;
}

interface QuoteAllocations {
  stock: Map<string, number>;
  production: Map<string, ItemId>;
  financing: Map<string, number>;
  visitingCats: Set<string>;
}

interface FirmInputQuote {
  itemId: ItemId;
  sellerCatId: string;
  sellerPriceCents: number;
  routeCatIds: string[];
  feesByCatId: Record<string, number>;
  deliveredCents: number;
  financingReserveCents: number;
  allocations: QuoteAllocations;
  supplyBundle?: FundedBundleCertificate;
}

interface FundedBundleCertificate {
  quotes: FirmInputQuote[];
  ownedInputCostCents: number;
  deliveredInputCostCents: number;
  bundleCostCents: number;
  financingReserveCents: number;
  reservationCents: number;
  alternativeGainCents: number;
  terminalRevenueCents: number;
  expectedProfitCents: number;
}

function freshQuoteAllocations(): QuoteAllocations {
  return { stock: new Map(), production: new Map(), financing: new Map(), visitingCats: new Set() };
}

function cloneQuoteAllocations(source: QuoteAllocations): QuoteAllocations {
  return {
    stock: new Map(source.stock),
    production: new Map(source.production),
    financing: new Map(source.financing),
    visitingCats: new Set(source.visitingCats),
  };
}

function overwriteQuoteAllocations(target: QuoteAllocations, source: QuoteAllocations): void {
  target.stock = new Map(source.stock);
  target.production = new Map(source.production);
  target.financing = new Map(source.financing);
}

function routeSettlement(
  state: GameState,
  seller: CatState,
  destination: CatState,
  priceOf: (itemId: ItemId) => number,
): { routeCatIds: string[]; feesByCatId: Record<string, number>; freightCents: number } | null {
  const routeCatIds = findTransportRoute(state, seller.id, destination.id);
  if (!routeCatIds) return null;
  const intermediates = routeCatIds.slice(1, -1)
    .map((id) => state.cats.find((cat) => cat.id === id))
    .filter((cat): cat is CatState => Boolean(cat));
  if (intermediates.some((cat) => outstandingCarrierLegs(state, cat.id) >= 2)) return null;
  const feesByCatId = Object.fromEntries(intermediates.map((cat) => [cat.id, carrierFeeCents(state, cat, priceOf)]));
  return {
    routeCatIds,
    feesByCatId,
    freightCents: Object.values(feesByCatId).reduce((sum, fee) => sum + fee, 0),
  };
}

function alternativeActionGainCents(
  _state: GameState,
  _cat: CatState,
  _excludedRecipeId: string,
  _priceOf: (itemId: ItemId) => number,
): number {
  // Preference laws define which of the non-loss candidates the cat values.
  // A merely hypothetical, law-rejected action is not a contractual burden and
  // therefore is not charged again here. Locked carrier/terminal commitments
  // are already priced into their firm quotes.
  return 0;
}

function quoteInputBundle(
  state: GameState,
  buyer: CatState,
  recipe: NonNullable<ReturnType<typeof RECIPE_BY_ID.get>>,
  priceOf: (itemId: ItemId) => number,
  allocations: QuoteAllocations,
): Omit<FundedBundleCertificate, "alternativeGainCents" | "terminalRevenueCents" | "expectedProfitCents"> | null {
  const quotes: FirmInputQuote[] = [];
  let ownedInputCostCents = 0;
  for (const input of effectiveRecipeInputs(recipe, state.difficulty)) {
    const ownStockKey = `${buyer.id}:${input.itemId}`;
    const alreadyAllocated = allocations.stock.get(ownStockKey) ?? 0;
    const owned = Math.min(
      input.quantity,
      Math.max(0, unofferedOwnedQuantity(state, buyer, input.itemId) - alreadyAllocated),
    );
    if (owned > 0) allocations.stock.set(ownStockKey, alreadyAllocated + owned);
    ownedInputCostCents += owned * externalNetCentsAt(state, input.itemId, priceOf, buyer);
    for (let unit = owned; unit < input.quantity; unit += 1) {
      const quote = firmQuoteForInput(state, buyer, input.itemId, priceOf, allocations);
      if (!quote) return null;
      quotes.push(quote);
    }
  }
  const deliveredInputCostCents = quotes.reduce((sum, quote) => sum + quote.deliveredCents, 0);
  const financingReserveCents = quotes.reduce((sum, quote) => sum + quote.financingReserveCents, 0);
  return {
    quotes,
    ownedInputCostCents,
    deliveredInputCostCents,
    bundleCostCents: ownedInputCostCents + deliveredInputCostCents,
    financingReserveCents,
    reservationCents: deliveredInputCostCents + financingReserveCents,
  };
}

function firmQuoteForInput(
  state: GameState,
  destination: CatState,
  itemId: ItemId,
  priceOf: (itemId: ItemId) => number,
  allocations: QuoteAllocations,
): FirmInputQuote | null {
  const candidates: FirmInputQuote[] = [];
  // Existing unreserved stock is both firmer and never more expensive than
  // recursively commissioning the same cat to recreate that unit. Resolve
  // this common hot path before exploring the recipe tree.
  for (const seller of [...state.cats].sort((left, right) => left.createdIndex - right.createdIndex)) {
    if (seller.id === destination.id) continue;
    const stockKey = `${seller.id}:${itemId}`;
    const allocatedStock = allocations.stock.get(stockKey) ?? 0;
    if (unreservedOwnedQuantity(state, seller, itemId) <= allocatedStock) continue;
    const settlement = routeSettlement(state, seller, destination, priceOf);
    if (!settlement) continue;
    const next = cloneQuoteAllocations(allocations);
    next.stock.set(stockKey, allocatedStock + 1);
    const sellerPriceCents = externalNetCentsAt(state, itemId, priceOf, seller) + MIN_PLAN_PROFIT_CENTS;
    const deliveredCents = sellerPriceCents + settlement.freightCents;
    candidates.push({
      itemId,
      sellerCatId: seller.id,
      sellerPriceCents,
      routeCatIds: settlement.routeCatIds,
      feesByCatId: settlement.feesByCatId,
      deliveredCents,
      financingReserveCents: maximumLoanFeeCents(deliveredCents),
      allocations: next,
    });
  }
  const bestStockDeliveredCents = candidates.reduce((best, quote) => Math.min(best, quote.deliveredCents), Number.POSITIVE_INFINITY);
  for (const seller of [...state.cats].sort((left, right) => left.createdIndex - right.createdIndex)) {
    if (seller.id === destination.id) continue;
    const settlement = routeSettlement(state, seller, destination, priceOf);
    if (!settlement) continue;
    const stockKey = `${seller.id}:${itemId}`;
    const allocatedStock = allocations.stock.get(stockKey) ?? 0;
    if (unreservedOwnedQuantity(state, seller, itemId) > allocatedStock) continue;
    const productionLowerBound = externalNetCentsAt(state, itemId, priceOf, seller)
      + MIN_PLAN_PROFIT_CENTS + settlement.freightCents;
    if (productionLowerBound >= bestStockDeliveredCents) continue;
    const recipe = RECIPE_BY_OUTPUT.get(itemId);
    if (!recipe || !localRecipeIsUsable(state, seller, itemId) || allocations.visitingCats.has(seller.id)) continue;
    const active = planForCat(state, seller.id);
    if (active) continue;
    // A workstation may quote several sequential units of the same output.
    // It still cannot promise two different active recipes at once.  Delivery
    // settlement reserves those same-item promises in stable order, so the
    // first completed unit can no longer be mutually blocked by later units.
    const allocatedOutput = allocations.production.get(seller.id);
    if (allocatedOutput && allocatedOutput !== itemId) continue;
    if (state.demandOrders.some((order) => order.status === "open"
      && order.committedSellerCatId === seller.id && order.itemId !== itemId)) continue;

    const next = cloneQuoteAllocations(allocations);
    next.production.set(seller.id, itemId);
    next.visitingCats.add(seller.id);
    const bundle = quoteInputBundle(state, seller, recipe, priceOf, next);
    next.visitingCats.delete(seller.id);
    const previouslyAllocatedFinancing = next.financing.get(seller.id) ?? 0;
    if (!bundle || buyingPowerCents(state, seller, priceOf)
      < previouslyAllocatedFinancing + bundle.reservationCents) continue;
    next.financing.set(seller.id, previouslyAllocatedFinancing + bundle.reservationCents);
    const alternativeGainCents = alternativeActionGainCents(state, seller, recipe.id, priceOf);
    const sellerPriceCents = Math.max(
      externalNetCentsAt(state, itemId, priceOf, seller) + MIN_PLAN_PROFIT_CENTS,
      bundle.bundleCostCents + bundle.financingReserveCents + alternativeGainCents + MIN_PLAN_PROFIT_CENTS,
    );
    const deliveredCents = sellerPriceCents + settlement.freightCents;
    candidates.push({
      itemId,
      sellerCatId: seller.id,
      sellerPriceCents,
      routeCatIds: settlement.routeCatIds,
      feesByCatId: settlement.feesByCatId,
      deliveredCents,
      financingReserveCents: maximumLoanFeeCents(deliveredCents),
      allocations: next,
      supplyBundle: {
        ...bundle,
        alternativeGainCents,
        terminalRevenueCents: sellerPriceCents,
        expectedProfitCents: sellerPriceCents
          - bundle.bundleCostCents - bundle.financingReserveCents - alternativeGainCents,
      },
    });
  }
  const selected = candidates.sort((left, right) => (
    left.deliveredCents - right.deliveredCents
      || (state.cats.find((cat) => cat.id === left.sellerCatId)?.createdIndex ?? Number.MAX_SAFE_INTEGER)
        - (state.cats.find((cat) => cat.id === right.sellerCatId)?.createdIndex ?? Number.MAX_SAFE_INTEGER)
      || left.sellerCatId.localeCompare(right.sellerCatId)
  ))[0];
  if (!selected) return null;
  overwriteQuoteAllocations(allocations, selected.allocations);
  return selected;
}

function bundleFundingCertificate(
  state: GameState,
  cat: CatState,
  recipe: NonNullable<ReturnType<typeof RECIPE_BY_ID.get>>,
  terminalRevenueCents: number,
  priceOf: (itemId: ItemId) => number,
): FundedBundleCertificate | null {
  const allocations = freshQuoteAllocations();
  allocations.visitingCats.add(cat.id);
  const inputs = quoteInputBundle(state, cat, recipe, priceOf, allocations);
  if (!inputs || buyingPowerCents(state, cat, priceOf) < inputs.reservationCents) return null;
  const alternativeGainCents = alternativeActionGainCents(state, cat, recipe.id, priceOf);
  const expectedProfitCents = terminalRevenueCents
    - inputs.bundleCostCents
    - inputs.financingReserveCents
    - alternativeGainCents;
  if (expectedProfitCents < MIN_PLAN_PROFIT_CENTS) return null;
  return { ...inputs, alternativeGainCents, terminalRevenueCents, expectedProfitCents };
}

function createPlan(
  state: GameState,
  cat: CatState,
  outputItemId: ItemId,
  terminalOrderId: string | null,
  funding: FundedBundleCertificate,
  reason: ProcurementPlan["reason"],
  createdByBehaviorLawId: string,
  priceOf: (itemId: ItemId) => number,
  bountyCents = 0,
): ProcurementPlan | null {
  const recipe = RECIPE_BY_OUTPUT.get(outputItemId);
  if (!recipe || !state.unlockedRecipes.includes(recipe.id) || siteFailure(state, cat, recipe)) return null;
  // One workstation may finance exactly one production plan. Side work is an
  // action-level choice and must never create a second reservation bundle.
  if (planForCat(state, cat.id)) return null;
  if (funding.reservationCents > buyingPowerCents(state, cat, priceOf)) return null;
  if (terminalOrderId) {
    const terminal = state.demandOrders.find((order) => order.id === terminalOrderId && order.status === "open");
    if (!terminal || terminal.committedSellerCatId !== cat.id) return null;
    if (state.procurementPlans.some((plan) => plan.status !== "cancelled" && plan.terminalOrderId === terminalOrderId)) return null;
  }
  const transaction = {
    procurementPlanLength: state.procurementPlans.length,
    demandOrderLength: state.demandOrders.length,
    broadcastLength: state.marketBroadcasts.length,
    nextProcurementPlanIndex: state.nextProcurementPlanIndex,
    nextDemandOrderIndex: state.nextDemandOrderIndex,
    nextMarketBroadcastIndex: state.nextMarketBroadcastIndex,
    dirtyDecisions: state.dirtyDecisions,
    productionHistory: structuredClone(state.productionHistory),
    escrowByCatId: new Map(state.cats.map((entry) => [entry.id, entry.escrowReservedCents])),
  };
  const rollback = (): null => {
    state.procurementPlans.splice(transaction.procurementPlanLength);
    state.demandOrders.splice(transaction.demandOrderLength);
    state.marketBroadcasts.splice(transaction.broadcastLength);
    state.nextProcurementPlanIndex = transaction.nextProcurementPlanIndex;
    state.nextDemandOrderIndex = transaction.nextDemandOrderIndex;
    state.nextMarketBroadcastIndex = transaction.nextMarketBroadcastIndex;
    state.dirtyDecisions = transaction.dirtyDecisions;
    state.productionHistory = transaction.productionHistory;
    for (const entry of state.cats) {
      entry.escrowReservedCents = transaction.escrowByCatId.get(entry.id) ?? entry.escrowReservedCents;
    }
    return null;
  };
  const planId = `plan-${state.nextProcurementPlanIndex}`;
  const orders: DemandOrder[] = funding.quotes.map((quote, index) => ({
    id: `order-${state.nextDemandOrderIndex + index}`,
    buyerKind: "cat",
    buyerCatId: cat.id,
    destinationCatId: cat.id,
    itemId: quote.itemId,
    maxDeliveredCents: quote.deliveredCents,
    reservedCents: quote.deliveredCents + quote.financingReserveCents,
    planId,
    createdAt: state.simTime,
    status: "open",
    closedAt: null,
    closeReason: null,
    committedSellerCatId: quote.sellerCatId,
    quotedSellerCents: quote.sellerPriceCents,
    quotedRouteCatIds: [...quote.routeCatIds],
    quotedFeesByCatId: { ...quote.feesByCatId },
    quoteFinancingReserveCents: quote.financingReserveCents,
    quoteRevision: state.lawbookRevision,
  }));
  const plan: ProcurementPlan = {
    id: planId,
    catId: cat.id,
    outputItemId,
    recipeId: recipe.id,
    terminalOrderId,
    expectedRevenueCents: funding.terminalRevenueCents,
    bountyCents: reason === "bounty" ? Math.max(0, Math.round(bountyCents)) : 0,
    createdAt: state.simTime,
    createdByBehaviorLawId,
    status: "active",
    reason,
    phase: orders.length > 0 ? "funded" : "ready",
    terminalRevenueCents: funding.terminalRevenueCents,
    alternativeGainCents: funding.alternativeGainCents,
    bundleCostCents: funding.bundleCostCents,
    financingReserveCents: funding.financingReserveCents,
    expectedProfitCents: funding.expectedProfitCents,
    budgetSlackCents: funding.expectedProfitCents,
    bundleOrderIds: orders.map((order) => order.id),
    blockedReason: orders.length > 0 ? "等待整包原料合同送达" : null,
    quoteRevision: state.lawbookRevision,
  };
  state.nextProcurementPlanIndex += 1;
  state.nextDemandOrderIndex += orders.length;
  cat.escrowReservedCents += funding.reservationCents;
  state.procurementPlans.push(plan);
  state.demandOrders.push(...orders);
  for (const order of orders) {
    publishMarketBroadcast(state, {
      kind: "demand-open",
      subjectId: order.id,
      itemId: order.itemId,
      sourceCatId: cat.id,
      amountCents: order.maxDeliveredCents,
      reason: "整包融资后锁定的可靠到货报价",
    });
  }
  for (let index = 0; index < funding.quotes.length; index += 1) {
    const quote = funding.quotes[index];
    if (!quote.supplyBundle) continue;
    const supplier = state.cats.find((entry) => entry.id === quote.sellerCatId);
    if (!supplier || state.procurementPlans.some((entry) => entry.status === "active"
      && entry.terminalOrderId === orders[index].id)) return rollback();
    const existingSupplierPlan = planForCat(state, supplier.id);
    if (existingSupplierPlan) {
      // One atomic basket may reserve several sequential units from the same
      // supplier. Only the first unit becomes its active plan; after delivery,
      // the still-open committed order creates the next plan normally.
      const belongsToThisBasket = Boolean(existingSupplierPlan.terminalOrderId
        && orders.some((order) => order.id === existingSupplierPlan.terminalOrderId));
      if (belongsToThisBasket && existingSupplierPlan.outputItemId === quote.itemId) continue;
      return rollback();
    }
    const supplierPlan = createPlan(
      state,
      supplier,
      quote.itemId,
      orders[index].id,
      quote.supplyBundle,
      "order",
      createdByBehaviorLawId,
      priceOf,
      0,
    );
    if (!supplierPlan) return rollback();
  }
  recordProductionPlan(state, plan, orders);
  return plan;
}

function cancelPlan(state: GameState, plan: ProcurementPlan, reason: string): void {
  plan.status = "cancelled";
  if (plan.reason === "bounty") {
    const bounty = state.discoveryBounties.find((entry) => entry.itemId === plan.outputItemId && !entry.paid);
    if (bounty?.claimedByCatId === plan.catId) bounty.claimedByCatId = null;
  }
  for (const order of state.demandOrders.filter((entry) => entry.planId === plan.id && entry.status === "open")) {
    cancelDemandOrder(state, order.id, reason);
  }
  if (plan.terminalOrderId) {
    const terminal = state.demandOrders.find((entry) => entry.id === plan.terminalOrderId && entry.status === "open");
    if (terminal?.committedSellerCatId === plan.catId) {
      terminal.committedSellerCatId = null;
      terminal.quotedSellerCents = undefined;
      terminal.quotedRouteCatIds = undefined;
      terminal.quotedFeesByCatId = undefined;
      terminal.quoteFinancingReserveCents = undefined;
      terminal.quoteRevision = undefined;
    }
  }
}

function ensurePlanOrders(state: GameState, plan: ProcurementPlan, _priceOf: (itemId: ItemId) => number): void {
  const cat = state.cats.find((entry) => entry.id === plan.catId);
  const recipe = RECIPE_BY_ID.get(plan.recipeId);
  if (!cat || !recipe || siteFailure(state, cat, recipe)) {
    cancelPlan(state, plan, "生产位置或配方已经失效");
    return;
  }
  const bundleOrders = (plan.bundleOrderIds ?? [])
    .map((id) => state.demandOrders.find((order) => order.id === id))
    .filter((order): order is DemandOrder => Boolean(order));
  if (bundleOrders.length !== (plan.bundleOrderIds ?? []).length
    || bundleOrders.some((order) => order.status === "cancelled")) {
    cancelPlan(state, plan, "可靠报价中的原料订单已经失效");
    return;
  }
  const ready = effectiveRecipeInputs(recipe, state.difficulty)
    .every((input) => availableInputQuantityForPlan(state, cat, plan, input.itemId) >= input.quantity);
  plan.phase = ready
    ? "ready"
    : bundleOrders.some((order) => order.status === "contracted") ? "procuring" : "funded";
  plan.blockedReason = ready ? null : "等待整包原料合同送达";
}

function localRecipeIsUsable(state: GameState, cat: CatState, itemId: ItemId): boolean {
  const recipe = RECIPE_BY_OUTPUT.get(itemId);
  return Boolean(recipe
    && state.unlockedRecipes.includes(recipe.id)
    && !siteFailure(state, cat, recipe)
    && (recipe.inputs.length > 0 || resourceItemAt(state, cat.position) === itemId));
}

export function findTransportRoute(state: GameState, sellerCatId: string, destinationCatId: string): string[] | null {
  if (sellerCatId === destinationCatId) return [sellerCatId];
  const catsById = new Map(state.cats.map((cat) => [cat.id, cat]));
  const positionMap = new Map(state.cats.map((cat) => [positionKey(cat.position), cat]));
  if (!catsById.has(sellerCatId) || !catsById.has(destinationCatId)) return null;
  const queue: string[] = [sellerCatId];
  const previous = new Map<string, string | null>([[sellerCatId, null]]);
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const current = catsById.get(currentId)!;
    const neighbors = DIRECTIONS.map(([, dx, dy], directionIndex) => ({
      cat: positionMap.get(`${current.position.x + dx},${current.position.y + dy}`),
      directionIndex,
    })).filter((entry): entry is { cat: CatState; directionIndex: number } => Boolean(entry.cat))
      .sort((left, right) => left.directionIndex - right.directionIndex || left.cat.createdIndex - right.cat.createdIndex);
    for (const { cat } of neighbors) {
      if (previous.has(cat.id)) continue;
      previous.set(cat.id, currentId);
      if (cat.id === destinationCatId) {
        const route = [destinationCatId];
        let cursor: string | null = currentId;
        while (cursor) {
          route.push(cursor);
          cursor = previous.get(cursor) ?? null;
        }
        return route.reverse();
      }
      queue.push(cat.id);
    }
  }
  return null;
}

export interface ProductionOpportunity {
  itemId: ItemId;
  recipeId: string;
  reason: ProcurementPlan["reason"];
  terminalOrderId: string | null;
  finishedGoodValueCents: number;
  bountyCents: number;
  conservativeBountyValueCents: number;
  orderRevenueCents: number;
  ingredientOpportunityCostCents: number;
  procurementAndTransportCostCents: number;
  financingCostCents: number;
  coordinationRiskCostCents: number;
  expectedRevenueCents: number;
  netAssetGainCents: number;
  burdenUnits: number;
  assetGainRate: number;
  fundingCertificate?: FundedBundleCertificate;
}

export interface ProductionScoreAdjustment {
  actionType: "craft" | "pass" | "sell" | "*";
  itemId: ItemId | "*";
  multiplier: number;
  bonus: number;
}

export interface ProductionOpportunityDiagnostic {
  itemId: ItemId;
  catId: string;
  unlocked: boolean;
  siteFailure: string | null;
  locallyUsable: boolean;
  bountyBroadcastOpen: boolean;
  bountyClaimedByCatId: string | null;
  buyingPowerCents: number;
  requiredWorkingCapitalCents: number;
  inventoryOpportunity: ProductionOpportunity | null;
  bountyOpportunity: ProductionOpportunity | null;
  rejectionReasons: string[];
}

interface OpportunityTerms {
  reason: ProcurementPlan["reason"];
  terminalOrderId: string | null;
  bountyCents?: number;
  orderGrossCents?: number;
  outboundTransportCostCents?: number;
  outboundTransportBurden?: number;
}

/**
 * Compare every locally executable production plan on one economic scale.
 * Catalog position and foundation-list membership are deliberately absent: a cat
 * values the finished good, a still-available discovery bounty and an order
 * premium, then subtracts consumed assets, procurement/transport friction and
 * expected borrowing cost. The remainder is divided by embodied work and
 * transport burden so a later recipe only wins when it is genuinely better.
 */
function evaluateProductionOpportunity(
  state: GameState,
  cat: CatState,
  recipe: NonNullable<ReturnType<typeof RECIPE_BY_ID.get>>,
  priceOf: (itemId: ItemId) => number,
  terms: OpportunityTerms,
): ProductionOpportunity | null {
  const inputs = effectiveRecipeInputs(recipe, state.difficulty);
  const finishedGoodValueCents = externalNetCentsAt(state, recipe.output, priceOf, cat);
  const bountyCents = Math.max(0, terms.bountyCents ?? 0);
  const conservativeBountyValueCents = bountyCents;
  const orderRevenueCents = Math.max(0, terms.orderGrossCents ?? 0);
  const expectedRevenueCents = terms.reason === "order"
    ? orderRevenueCents
    : finishedGoodValueCents + conservativeBountyValueCents;
  const ingredientOpportunityCostCents = inputs.reduce((sum, input) => (
    sum + input.quantity * externalNetCentsAt(state, input.itemId, priceOf, cat)
  ), 0);
  const missingInputUnits = inputs.reduce((sum, input) => (
    sum + Math.max(0, input.quantity - unofferedOwnedQuantity(state, cat, input.itemId))
  ), 0);
  const procurementAndTransportCostCents = missingInputUnits;
  const financingCostCents = 0;
  const coordinationRiskCostCents = 0;
  const netAssetGainCents = expectedRevenueCents - ingredientOpportunityCostCents;
  const burdenUnits = Math.max(1,
    (CATALOG_ANALYSIS.workUnits[recipe.output] ?? 1)
      + missingInputUnits
      + Math.max(0, terms.outboundTransportBurden ?? 0));
  return {
    itemId: recipe.output,
    recipeId: recipe.id,
    reason: terms.reason,
    terminalOrderId: terms.terminalOrderId,
    finishedGoodValueCents,
    bountyCents,
    conservativeBountyValueCents,
    orderRevenueCents,
    ingredientOpportunityCostCents,
    procurementAndTransportCostCents,
    financingCostCents,
    coordinationRiskCostCents,
    expectedRevenueCents,
    netAssetGainCents,
    burdenUnits,
    assetGainRate: netAssetGainCents / burdenUnits,
  };
}

/** Read-only QA/inspector evidence for opportunities filtered before ranking. */
export function productionOpportunityDiagnosticForCat(
  state: GameState,
  cat: CatState,
  priceOf: (itemId: ItemId) => number,
  itemId: ItemId,
): ProductionOpportunityDiagnostic {
  const recipe = RECIPE_BY_OUTPUT.get(itemId);
  const unlocked = Boolean(recipe && state.unlockedRecipes.includes(recipe.id));
  const failure = recipe ? siteFailure(state, cat, recipe) : "recipe-not-found";
  const locallyUsable = Boolean(recipe && localRecipeIsUsable(state, cat, itemId));
  const bounty = state.discoveryBounties.find((entry) => entry.itemId === itemId && !entry.paid);
  const bountyBroadcastOpen = bountyBroadcastsForCat(state, cat.id).some((entry) => entry.itemId === itemId);
  const buyingPower = buyingPowerCents(state, cat, priceOf);
  const inventoryOpportunity = recipe && locallyUsable
    ? evaluateProductionOpportunity(state, cat, recipe, priceOf, { reason: "external-sale", terminalOrderId: null })
    : null;
  const bountyOpportunity = recipe && locallyUsable && bounty && bountyBroadcastOpen
    && (bounty.claimedByCatId === null || bounty.claimedByCatId === cat.id)
    ? evaluateProductionOpportunity(state, cat, recipe, priceOf, {
      reason: "bounty",
      terminalOrderId: null,
      bountyCents: effectiveBountyAmountCents(state, itemId, cat),
    })
    : null;
  const terminalRevenue = bountyOpportunity?.expectedRevenueCents ?? inventoryOpportunity?.expectedRevenueCents;
  const certificate = recipe && locallyUsable && terminalRevenue !== undefined
    ? bundleFundingCertificate(state, cat, recipe, terminalRevenue, priceOf)
    : null;
  const requiredCapital = certificate?.reservationCents ?? Number.POSITIVE_INFINITY;
  const rejectionReasons: string[] = [];
  if (!recipe) rejectionReasons.push("recipe-not-found");
  if (recipe && !unlocked) rejectionReasons.push("recipe-locked");
  if (failure) rejectionReasons.push(`site:${failure}`);
  if (recipe?.inputs.length === 0 && resourceItemAt(state, cat.position) !== itemId) rejectionReasons.push("wrong-resource-site");
  if (requiredCapital > buyingPower) rejectionReasons.push(`working-capital:${requiredCapital - buyingPower}`);
  if (bounty && !bountyBroadcastOpen) rejectionReasons.push("bounty-not-broadcast");
  if (bounty?.claimedByCatId && bounty.claimedByCatId !== cat.id) rejectionReasons.push(`bounty-claimed:${bounty.claimedByCatId}`);
  if (inventoryOpportunity && inventoryOpportunity.netAssetGainCents <= 0) rejectionReasons.push(`inventory-nonprofit:${inventoryOpportunity.netAssetGainCents}`);
  if (bountyOpportunity && bountyOpportunity.netAssetGainCents <= 0) rejectionReasons.push(`bounty-nonprofit:${bountyOpportunity.netAssetGainCents}`);
  if (locallyUsable && !inventoryOpportunity && requiredCapital <= buyingPower) rejectionReasons.push("inventory-opportunity-filtered");
  if (bounty && bountyBroadcastOpen && !bountyOpportunity && requiredCapital <= buyingPower) rejectionReasons.push("bounty-opportunity-filtered");
  return {
    itemId,
    catId: cat.id,
    unlocked,
    siteFailure: failure,
    locallyUsable,
    bountyBroadcastOpen,
    bountyClaimedByCatId: bounty?.claimedByCatId ?? null,
    buyingPowerCents: buyingPower,
    requiredWorkingCapitalCents: requiredCapital,
    inventoryOpportunity,
    bountyOpportunity,
    rejectionReasons,
  };
}

function opportunitySort(left: ProductionOpportunity, right: ProductionOpportunity): number {
  return right.assetGainRate - left.assetGainRate
    || right.netAssetGainCents - left.netAssetGainCents
    || left.itemId.localeCompare(right.itemId)
    || left.reason.localeCompare(right.reason)
    || stableIdCompare(left.terminalOrderId ?? "", right.terminalOrderId ?? "");
}

function adjustedOpportunityScore(
  opportunity: ProductionOpportunity,
  adjustments: ReadonlyArray<ProductionScoreAdjustment>,
): number {
  let score = opportunity.assetGainRate;
  // A regulation may change the relative value of ordinary stocking work as
  // well as bounties and paid orders. It still cannot create money, goods or a
  // buyer: the resulting plan uses the same inventory, credit and logistics.
  for (const adjustment of adjustments) {
    if (adjustment.actionType !== "craft" && adjustment.actionType !== "*") continue;
    if (adjustment.itemId !== "*" && adjustment.itemId !== opportunity.itemId) continue;
    const multiplier = Number.isFinite(adjustment.multiplier)
      ? Math.max(0, Math.min(100, adjustment.multiplier))
      : 1;
    const bonus = Number.isFinite(adjustment.bonus)
      ? Math.max(-1_000_000, Math.min(1_000_000, adjustment.bonus))
      : 0;
    score = score * multiplier + bonus;
  }
  return score;
}

function rankProductionOpportunities(
  opportunities: ProductionOpportunity[],
  adjustments: ReadonlyArray<ProductionScoreAdjustment>,
): ProductionOpportunity[] {
  if (adjustments.length === 0) return opportunities;
  return [...opportunities].sort((left, right) => (
    adjustedOpportunityScore(right, adjustments) - adjustedOpportunityScore(left, adjustments)
    || opportunitySort(left, right)
  ));
}

function ensureReliableQuoteForOrder(
  state: GameState,
  order: DemandOrder,
  priceOf: (itemId: ItemId) => number,
): boolean {
  if (order.status !== "open") return false;
  if (order.committedSellerCatId && order.quotedSellerCents !== undefined && order.quotedRouteCatIds) return true;
  const destination = state.cats.find((cat) => cat.id === order.destinationCatId);
  if (!destination) return false;
  const quote = firmQuoteForInput(state, destination, order.itemId, priceOf, freshQuoteAllocations());
  if (!quote || quote.deliveredCents > order.maxDeliveredCents) return false;
  order.committedSellerCatId = quote.sellerCatId;
  order.quotedSellerCents = quote.sellerPriceCents;
  order.quotedRouteCatIds = [...quote.routeCatIds];
  order.quotedFeesByCatId = { ...quote.feesByCatId };
  order.quoteFinancingReserveCents = 0;
  order.quoteRevision = state.lawbookRevision;
  publishMarketBroadcast(state, {
    kind: "demand-open",
    subjectId: order.id,
    itemId: order.itemId,
    sourceCatId: order.destinationCatId,
    amountCents: quote.deliveredCents,
    reason: `可靠报价由 ${quote.sellerCatId} 承诺`,
  });
  // Locking a quote is market bookkeeping, not authority to make the seller
  // produce.  A seller without stock will see the committed order during its
  // next shared-law decision and may then create the quoted production plan.
  // Plans created as part of an already-authorized atomic bundle are committed
  // recursively by createPlan() and retain that real law id.
  return true;
}

export function productionOpportunitiesForCat(
  state: GameState,
  cat: CatState,
  priceOf: (itemId: ItemId) => number,
): ProductionOpportunity[] {
  const opportunities: ProductionOpportunity[] = [];
  const usableRecipes = state.unlockedRecipes.map((id) => RECIPE_BY_ID.get(id))
    .filter((recipe): recipe is NonNullable<typeof recipe> => Boolean(recipe && localRecipeIsUsable(state, cat, recipe.output)));
  const openBountyItems = new Set(bountyBroadcastsForCat(state, cat.id).map((broadcast) => broadcast.itemId));
  const claimedBountyItems = new Set(state.discoveryBounties.filter((bounty) => (
    !bounty.paid && bounty.claimedByCatId !== null
  )).map((bounty) => bounty.itemId));

  for (const recipe of usableRecipes) {
    // A signed open bounty announces that only the first producer receives the
    // discovery premium. Once another cat has claimed it, duplicating the same
    // undiscovered output for speculative inventory has no conservative value.
    // Order-backed production remains available through the order opportunity
    // below, and ordinary inventory production resumes after bounty closure.
    if (claimedBountyItems.has(recipe.output)) continue;
    const inventoryOpportunity = evaluateProductionOpportunity(state, cat, recipe, priceOf, {
      reason: "external-sale",
      terminalOrderId: null,
    });
    if (inventoryOpportunity) opportunities.push(inventoryOpportunity);
  }

  for (const recipe of usableRecipes) {
    if (!openBountyItems.has(recipe.output)) continue;
    const bounty = state.discoveryBounties.find((entry) => entry.itemId === recipe.output && !entry.paid
      && (entry.claimedByCatId === null || entry.claimedByCatId === cat.id));
    if (!bounty) continue;
    const bountyOpportunity = evaluateProductionOpportunity(state, cat, recipe, priceOf, {
      reason: "bounty",
      terminalOrderId: null,
      bountyCents: effectiveBountyAmountCents(state, recipe.output, cat),
    });
    if (bountyOpportunity) opportunities.push(bountyOpportunity);
  }

  for (const order of state.demandOrders.filter((entry) => entry.status === "open"
    && entry.committedSellerCatId === cat.id)) {
    if (order.destinationCatId === cat.id) continue;
    if (state.procurementPlans.some((plan) => plan.status !== "cancelled" && plan.terminalOrderId === order.id)) continue;
    const recipe = usableRecipes.find((entry) => entry.output === order.itemId);
    if (!recipe) continue;
    const route = order.quotedRouteCatIds ?? findTransportRoute(state, cat.id, order.destinationCatId);
    if (!route || route.length < 2) continue;
    const orderOpportunity = evaluateProductionOpportunity(state, cat, recipe, priceOf, {
      reason: "order",
      terminalOrderId: order.id,
      orderGrossCents: order.quotedSellerCents ?? 0,
      outboundTransportCostCents: 0,
      outboundTransportBurden: route.length - 1,
    });
    if (orderOpportunity) opportunities.push(orderOpportunity);
  }

  const profitable = opportunities.filter((entry) => entry.netAssetGainCents > 0 && entry.expectedRevenueCents > 0);
  const committedOrders = profitable.filter((entry) => entry.reason === "order");
  return (committedOrders.length > 0 ? committedOrders : profitable).sort(opportunitySort);
}

function directCraftFundingCandidate(
  state: GameState,
  cat: CatState,
  recipeId: string,
  priceOf: (itemId: ItemId) => number,
): { opportunity: ProductionOpportunity; funding: FundedBundleCertificate } | null {
  const recipe = RECIPE_BY_ID.get(recipeId);
  if (!recipe || !localRecipeIsUsable(state, cat, recipe.output)) return null;
  for (const opportunity of productionOpportunitiesForCat(state, cat, priceOf)
    .filter((entry) => entry.recipeId === recipeId)
    .sort(opportunitySort)) {
    const funding = bundleFundingCertificate(state, cat, recipe, opportunity.expectedRevenueCents, priceOf);
    if (funding) return { opportunity, funding };
  }
  return null;
}

/** Read-only preflight used while the shared law loop selects its first action. */
export function canFinanceDirectCraft(
  state: GameState,
  cat: CatState,
  recipeId: string,
  priceOf: (itemId: ItemId) => number,
): boolean {
  const active = planForCat(state, cat.id);
  if (active) {
    if (active.recipeId === recipeId) return true;
    const recipe = RECIPE_BY_ID.get(recipeId);
    return Boolean(recipe && sideWorkCraftFailure(state, cat, recipe, priceOf) === null);
  }
  return directCraftFundingCandidate(state, cat, recipeId, priceOf) !== null;
}

/**
 * Turn a law's direct craft request into the same fully quoted, non-loss plan
 * used by choose()/earnCoins().  No inventory or recipe rule is bypassed; if
 * the complete basket cannot be financed, this function leaves state intact.
 */
export function ensureDirectCraftPlan(
  state: GameState,
  cat: CatState,
  recipeId: string,
  priceOf: (itemId: ItemId) => number,
  createdByBehaviorLawId: string,
): boolean {
  const active = planForCat(state, cat.id);
  if (active) {
    if (active.recipeId === recipeId) return true;
    const recipe = RECIPE_BY_ID.get(recipeId);
    return Boolean(recipe && sideWorkCraftFailure(state, cat, recipe, priceOf) === null);
  }
  const candidate = directCraftFundingCandidate(state, cat, recipeId, priceOf);
  if (!candidate) return false;
  const { opportunity, funding } = candidate;
  if (opportunity.reason === "bounty" && !claimDiscoveryBounty(state, cat.id, opportunity.itemId)) return false;
  const created = createPlan(
    state,
    cat,
    opportunity.itemId,
    opportunity.terminalOrderId,
    funding,
    opportunity.reason,
    createdByBehaviorLawId,
    priceOf,
    opportunity.bountyCents,
  );
  if (created) return true;
  if (opportunity.reason === "bounty") {
    const bounty = state.discoveryBounties.find((entry) => entry.itemId === opportunity.itemId
      && entry.claimedByCatId === cat.id && !entry.paid);
    if (bounty) bounty.claimedByCatId = null;
  }
  return false;
}

function tryCreateBestProductionPlanForCat(
  state: GameState,
  cat: CatState,
  priceOf: (itemId: ItemId) => number,
  adjustments: ReadonlyArray<ProductionScoreAdjustment>,
  createdByBehaviorLawId: string,
): boolean {
  const ranked = rankProductionOpportunities(productionOpportunitiesForCat(state, cat, priceOf), adjustments);
  for (const opportunity of ranked) {
    // A shared law may deliberately make an otherwise profitable opportunity
    // unattractive for this workstation. Negative/zero scores mean "do not
    // volunteer", rather than merely sorting the job to the end and claiming
    // its one-shot bounty anyway.
    if (opportunity.reason !== "order" && adjustedOpportunityScore(opportunity, adjustments) <= 0) continue;
    const recipe = RECIPE_BY_ID.get(opportunity.recipeId);
    if (!recipe) continue;
    const funding = bundleFundingCertificate(state, cat, recipe, opportunity.expectedRevenueCents, priceOf);
    if (!funding) continue;
    if (opportunity.reason === "bounty" && !claimDiscoveryBounty(state, cat.id, opportunity.itemId)) continue;
    const plan = createPlan(
      state,
      cat,
      opportunity.itemId,
      opportunity.terminalOrderId,
      funding,
      opportunity.reason,
      createdByBehaviorLawId,
      priceOf,
      opportunity.bountyCents,
    );
    if (plan) return true;
    if (opportunity.reason === "bounty") {
      const bounty = state.discoveryBounties.find((entry) => entry.itemId === opportunity.itemId
        && entry.claimedByCatId === cat.id && !entry.paid);
      if (bounty) bounty.claimedByCatId = null;
    }
  }
  return false;
}

function refreshActivePlanEconomics(
  _state: GameState,
  _cat: CatState,
  _plan: ProcurementPlan,
  _priceOf: (itemId: ItemId) => number,
): void {
  // A funded plan is a commitment. Later law/price changes affect only the next
  // plan; they cannot rewrite the frozen revenue or input quote certificate.
}

function outstandingCarrierLegs(state: GameState, catId: string): number {
  return state.shipmentContracts.filter((contract) => contract.status !== "delivered"
    && contract.routeCatIds.slice(1, -1).includes(catId)
    && contract.routeCatIds.indexOf(catId) >= contract.currentLeg).length;
}

export function carrierFeeCents(state: GameState, cat: CatState, priceOf: (itemId: ItemId) => number): number {
  const bestLiquidation = Object.entries(cat.inventory).reduce((best, [itemId, quantity]) => (
    quantity > 0 ? Math.max(best, externalNetCents(state, itemId, priceOf)) : best
  ), 0);
  const base = Math.max(1, Math.min(MAX_CARRIER_FEE_CENTS, Math.floor(bestLiquidation / 100) + 1));
  return Math.ceil(base * (1 + landmarkEffectsAt(state, cat.position).carrierFeeBonus));
}

function promisedOrderOutputQuantity(
  state: GameState,
  catId: string,
  itemId: ItemId,
  exceptOrderId: string | null = null,
): number {
  return state.demandOrders.filter((order) => order.status === "open"
    && order.id !== exceptOrderId
    && order.committedSellerCatId === catId
    && order.itemId === itemId).length;
}

function earlierPromisedOrderOutputQuantity(state: GameState, order: DemandOrder): number {
  return state.demandOrders.filter((entry) => entry.status === "open"
    && entry.committedSellerCatId === order.committedSellerCatId
    && entry.itemId === order.itemId
    && (entry.createdAt < order.createdAt
      || (entry.createdAt === order.createdAt && stableIdCompare(entry.id, order.id) < 0))).length;
}

function availableStockForCommittedOrder(state: GameState, order: DemandOrder): number {
  const seller = state.cats.find((cat) => cat.id === order.committedSellerCatId);
  if (!seller) return 0;
  return Math.max(0, (seller.inventory[order.itemId] ?? 0)
    - activePlanProtectedQuantity(state, seller.id, order.itemId)
    - buildingOfferReservedQuantity(state, seller.id, order.itemId)
    - earlierPromisedOrderOutputQuantity(state, order));
}

function activePlanProtectedQuantity(state: GameState, catId: string, itemId: ItemId): number {
  return state.procurementPlans.filter((plan) => plan.catId === catId && plan.status === "active")
    .reduce((total, plan) => {
      const recipe = RECIPE_BY_ID.get(plan.recipeId);
      return total + (recipe ? effectiveRecipeInputs(recipe, state.difficulty)
        .find((input) => input.itemId === itemId)?.quantity ?? 0 : 0);
    }, 0);
}

export function unreservedOwnedQuantity(state: GameState, cat: CatState, itemId: ItemId): number {
  return Math.max(0, (cat.inventory[itemId] ?? 0) - activePlanProtectedQuantity(state, cat.id, itemId)
    - buildingOfferReservedQuantity(state, cat.id, itemId)
    - promisedOrderOutputQuantity(state, cat.id, itemId));
}

/**
 * A cat blocked on one funded plan may still perform profitable local work,
 * provided the side job neither consumes nor duplicates the plan's protected
 * inputs. It uses only stock that remains after every hard reservation.
 */
export function sideWorkCraftFailure(
  state: GameState,
  cat: CatState,
  recipe: NonNullable<ReturnType<typeof RECIPE_BY_ID.get>>,
  priceOf: (itemId: ItemId) => number,
): string | null {
  const activePlan = planForCat(state, cat.id);
  if (!activePlan) return "没有可并行保留的主计划";
  if (activePlan.recipeId === recipe.id) return "该制作属于主计划";
  const activeRecipe = RECIPE_BY_ID.get(activePlan.recipeId);
  if (activeRecipe && effectiveRecipeInputs(activeRecipe, state.difficulty)
    .some((input) => input.itemId === recipe.output)) {
    return "副业不能重复制造已经锁定采购的计划原料";
  }
  const missing = effectiveRecipeInputs(recipe, state.difficulty)
    .find((input) => unreservedOwnedQuantity(state, cat, input.itemId) < input.quantity);
  if (missing) return `副业可用库存不足 ${missing.itemId}×${missing.quantity}`;
  const action = { type: "craft", recipeId: recipe.id } as const;
  return expectedActionGainCents(state, cat, action, priceOf) < 0
    ? "副业预计降低自身净资产"
    : null;
}

/**
 * Quantity the owning cat can consume for its own production plan.
 * Building offers are hard reservations; plan inputs are not subtracted here
 * because the plan itself is their intended consumer.
 */
export function unofferedOwnedQuantity(state: GameState, cat: CatState, itemId: ItemId): number {
  return Math.max(0, (cat.inventory[itemId] ?? 0)
    - buildingOfferReservedQuantity(state, cat.id, itemId)
    - promisedOrderOutputQuantity(state, cat.id, itemId));
}

/**
 * Inputs usable by one queued plan after preserving the exact requirements of
 * every other active plan owned by the same cat.  This prevents the first job
 * in a queue from consuming cargo financed for the second job merely because
 * both units share the cat's aggregate inventory record.
 */
export function availableInputQuantityForPlan(
  state: GameState,
  cat: CatState,
  plan: ProcurementPlan,
  itemId: ItemId,
): number {
  const reservedForOtherPlans = state.procurementPlans.filter((entry) => entry.catId === cat.id
    && entry.status === "active" && entry.id !== plan.id).reduce((total, entry) => {
      const recipe = RECIPE_BY_ID.get(entry.recipeId);
      return total + (recipe ? effectiveRecipeInputs(recipe, state.difficulty)
        .find((input) => input.itemId === itemId)?.quantity ?? 0 : 0);
    }, 0);
  return Math.max(0, unofferedOwnedQuantity(state, cat, itemId) - reservedForOtherPlans);
}

export function syncBuildingOfferForCat(state: GameState, cat: CatState, priceOf: (itemId: ItemId) => number): void {
  for (const itemId of DEPLOYABLE_BUILDING_IDS) {
    if (state.buildingOffers.some((offer) => offer.status === "open"
      && offer.sellerCatId === cat.id && offer.itemId === itemId)) continue;
    if (unreservedOwnedQuantity(state, cat, itemId) < 1) continue;
    const offer = {
      id: `building-offer-${state.nextBuildingOfferIndex++}`,
      sellerCatId: cat.id,
      itemId,
      askCents: Math.ceil(priceOf(itemId) * difficultyProfile(state.difficulty).buildingAskMultiplier),
      createdAt: state.simTime,
      status: "open",
      closedAt: null,
      closeReason: null,
    } satisfies GameState["buildingOffers"][number];
    state.buildingOffers.push(offer);
    publishMarketBroadcast(state, {
      kind: "building-offer-open",
      subjectId: offer.id,
      itemId: offer.itemId,
      sourceCatId: cat.id,
      amountCents: offer.askCents,
      reason: null,
    });
  }
}

export function syncBuildingOffers(state: GameState, priceOf: (itemId: ItemId) => number): void {
  for (const cat of [...state.cats].sort((a, b) => a.createdIndex - b.createdIndex)) {
    syncBuildingOfferForCat(state, cat, priceOf);
  }
}

export function buyBuildingOffer(state: GameState, offerId: string): { ok: boolean; error?: string } {
  const offer = state.buildingOffers.find((entry) => entry.id === offerId);
  if (!offer || offer.status !== "open") return { ok: false, error: "商品报价已失效" };
  const seller = state.cats.find((cat) => cat.id === offer.sellerCatId);
  if (!seller || (seller.inventory[offer.itemId] ?? 0) < 1) {
    offer.status = "cancelled";
    offer.closedAt = state.simTime;
    const source = seller ?? state.cats[0];
    if (source) publishMarketBroadcast(state, {
      kind: "building-offer-closed",
      subjectId: offer.id,
      itemId: offer.itemId,
      sourceCatId: source.id,
      amountCents: offer.askCents,
      reason: "seller-no-longer-owns-item",
    });
    offer.closeReason = "卖方不再持有商品";
    return { ok: false, error: "卖方不再持有该商品" };
  }
  if (state.treasuryCoins < offer.askCents) return { ok: false, error: `国库还差 ${offer.askCents - state.treasuryCoins} 分` };
  state.treasuryCoins -= offer.askCents;
  seller.inventory[offer.itemId] -= 1;
  if (seller.inventory[offer.itemId] <= 0) delete seller.inventory[offer.itemId];
  applyPrivateIncome(seller, offer.askCents);
  state.playerBuildingInventory[offer.itemId] = (state.playerBuildingInventory[offer.itemId] ?? 0) + 1;
  recordWarehousePurchase(state, offer.itemId, 1);
  publishWarehouseBroadcast(state, seller.id, offer.itemId);
  offer.status = "purchased";
  offer.closedAt = state.simTime;
  publishMarketBroadcast(state, {
    kind: "building-offer-closed",
    subjectId: offer.id,
    itemId: offer.itemId,
    sourceCatId: seller.id,
    amountCents: offer.askCents,
    reason: "purchased-by-player",
  });
  offer.closeReason = "玩家收购并存入仓库";
  state.dirtyDecisions = true;
  return { ok: true };
}

function fundContract(state: GameState, order: DemandOrder, totalCents: number, priceOf: (itemId: ItemId) => number): boolean {
  if (totalCents > order.maxDeliveredCents) return false;
  if (order.buyerKind === "treasury") {
    if (totalCents > order.reservedCents) return false;
    state.treasuryCoins += order.reservedCents - totalCents;
    return true;
  }
  const buyer = state.cats.find((cat) => cat.id === order.buyerCatId);
  if (!buyer) return false;
  const cash = Math.min(buyer.coins, totalCents);
  const borrowed = totalCents - cash;
  const financingFee = borrowed > 0 ? maximumLoanFeeCents(borrowed) : 0;
  const otherReservations = Math.max(0, buyer.escrowReservedCents - order.reservedCents);
  const remainingCapacity = buyer.coins + creditAvailableCents(state, buyer, priceOf) - otherReservations;
  if (totalCents + financingFee > remainingCapacity || totalCents + financingFee > order.reservedCents) return false;
  buyer.escrowReservedCents = otherReservations;
  buyer.coins -= cash;
  if (borrowed > 0) {
    buyer.debtCents += borrowed + financingFee;
    recordSystemLawHit(state, "starter-law-private-credit");
  }
  return true;
}

function closeAsContracted(state: GameState, order: DemandOrder, sellerCatId: string): void {
  order.status = "contracted";
  order.closedAt = state.simTime;
  order.closeReason = "已成交并转为运输合同";
  pushLifecycle(state, order, "contracted", order.closeReason ?? "contracted", sellerCatId);
}

export function acceptProfitableOrdersForCat(state: GameState, seller: CatState, priceOf: (itemId: ItemId) => number): void {
  if (seller.action) return;
  const promisedOrderIds = new Set(state.procurementPlans.filter((plan) => plan.catId === seller.id
    && plan.status === "completed" && plan.terminalOrderId !== null).map((plan) => plan.terminalOrderId!));
  const visibleSignals = signalsForCat(state, seller.id);
  const visibleOrderIds = new Set(visibleSignals.map((signal) => signal.orderId));
  const promisedSignals = state.demandOrders.filter((order) => (
    order.status === "open" && promisedOrderIds.has(order.id) && !visibleOrderIds.has(order.id)
  )).map((order) => ({
    orderId: order.id,
    catId: "*",
    routeCatIds: [order.destinationCatId],
    hops: 0,
    estimatedFreightCents: 0,
    effectiveBidCents: order.maxDeliveredCents,
    receivedAt: order.createdAt,
  }));
  const signals = [...visibleSignals, ...promisedSignals].sort((left, right) => (
    Number(promisedOrderIds.has(right.orderId)) - Number(promisedOrderIds.has(left.orderId))
    || left.receivedAt - right.receivedAt
    || stableIdCompare(left.orderId, right.orderId)
  ));
  for (const signal of signals) {
      const order = state.demandOrders.find((entry) => entry.id === signal.orderId && entry.status === "open");
      if (!order || !ensureReliableQuoteForOrder(state, order, priceOf)
        || order.committedSellerCatId !== seller.id) continue;
      const buildingOrder = order ? state.buildingOrders.find((entry) => entry.demandOrderId === order.id) : undefined;
      const localBuildingSale = Boolean(buildingOrder && order?.destinationCatId === seller.id);
      const availableForOrder = order ? availableStockForCommittedOrder(state, order) : 0;
      if (availableForOrder < 1) continue;
      const route = order.quotedRouteCatIds ?? findTransportRoute(state, seller.id, order.destinationCatId);
      if (!route || (route.length < 2 && !localBuildingSale)) continue;
      const intermediates = route.slice(1, -1).map((id) => state.cats.find((cat) => cat.id === id)).filter((cat): cat is CatState => Boolean(cat));
      if (intermediates.some((cat) => outstandingCarrierLegs(state, cat.id) >= 2)) continue;
      const sellerPriceCents = order.quotedSellerCents ?? 0;
      const feesByCatId = order.quotedFeesByCatId ?? {};
      const total = sellerPriceCents + Object.values(feesByCatId).reduce((sum, fee) => sum + fee, 0);
      if (sellerPriceCents <= 0 || total > order.maxDeliveredCents || !fundContract(state, order, total, priceOf)) continue;
      const contract: ShipmentContract = {
        id: `contract-${state.nextContractIndex++}`,
        orderId: order.id,
        itemId: order.itemId,
        sellerCatId: seller.id,
        buyerKind: order.buyerKind,
        buyerCatId: order.buyerCatId,
        destinationCatId: order.destinationCatId,
        routeCatIds: route,
        currentLeg: 0,
        custodianCatId: seller.id,
        sellerPriceCents,
        feesByCatId,
        escrowCents: total,
        acceptedAt: state.simTime,
        deliveredAt: null,
        status: "awaiting-pickup",
      };
      seller.inventory[order.itemId] -= 1;
      if (seller.inventory[order.itemId] <= 0) delete seller.inventory[order.itemId];
      if (localBuildingSale) {
        contract.status = "delivered";
        contract.deliveredAt = state.simTime;
        contract.escrowCents = 0;
        applyPrivateIncome(seller, sellerPriceCents);
      }
      state.shipmentContracts.push(contract);
      if (buildingOrder) {
        buildingOrder.contractId = contract.id;
        buildingOrder.budgetCents = total;
      }
      closeAsContracted(state, order, seller.id);
    break;
  }
}

export function acceptProfitableOrders(state: GameState, priceOf: (itemId: ItemId) => number): void {
  const oldestReadyOrderBySeller = new Map<string, number>();
  for (const order of state.demandOrders) {
    if (order.status !== "open" || !order.committedSellerCatId
      || availableStockForCommittedOrder(state, order) < 1) continue;
    oldestReadyOrderBySeller.set(order.committedSellerCatId, Math.min(
      oldestReadyOrderBySeller.get(order.committedSellerCatId) ?? Number.POSITIVE_INFINITY,
      order.createdAt,
    ));
  }
  for (const seller of [...state.cats].sort((a, b) => (
    (oldestReadyOrderBySeller.get(a.id) ?? Number.POSITIVE_INFINITY)
      - (oldestReadyOrderBySeller.get(b.id) ?? Number.POSITIVE_INFINITY)
      || a.createdIndex - b.createdIndex
  ))) {
    acceptProfitableOrdersForCat(state, seller, priceOf);
  }
}

export function refreshCatMarket(
  state: GameState,
  cat: CatState,
  priceOf: (itemId: ItemId) => number,
  adjustments: ReadonlyArray<ProductionScoreAdjustment> = [],
  createdByBehaviorLawId = "direct-market-test",
): void {
  for (const order of state.demandOrders.filter((entry) => entry.status === "open" && !entry.committedSellerCatId)) {
    ensureReliableQuoteForOrder(state, order, priceOf);
  }
  let plan = planForCat(state, cat.id);
  if (plan?.terminalOrderId) {
    const stillBroadcast = signalsForCat(state, cat.id).some((signal) => signal.orderId === plan?.terminalOrderId);
    if (!stillBroadcast) {
      cancelPlan(state, plan, "下游订单已经消失");
      plan = undefined;
    }
  }
  if (plan && siteFailure(state, cat, RECIPE_BY_ID.get(plan.recipeId)!)) {
    cancelPlan(state, plan, "本工位不再满足生产位置要求");
    plan = undefined;
  }
  if (plan?.reason === "external-sale" && !cat.action) {
    const opportunities = rankProductionOpportunities(
      productionOpportunitiesForCat(state, cat, priceOf),
      adjustments,
    );
    const current = opportunities.find((entry) => entry.reason === "external-sale"
      && entry.itemId === plan?.outputItemId);
    const best = opportunities[0];
    // Speculative inventory work has no customer commitment. A selfish cat may
    // therefore abandon it between actions when a strictly better bounty or
    // paid order appears. Locked actions and binding shipment contracts remain
    // untouched; only still-open procurement orders are refunded/cancelled.
    if (best && (!current
      || adjustedOpportunityScore(best, adjustments) > adjustedOpportunityScore(current, adjustments))
      && (best.itemId !== plan.outputItemId || best.reason !== plan.reason)) {
      cancelPlan(state, plan, `发现更高净资产增益率机会：${best.itemId}`);
      plan = undefined;
    }
  }
  if (!plan) {
    tryCreateBestProductionPlanForCat(state, cat, priceOf, adjustments, createdByBehaviorLawId);
    plan = planForCat(state, cat.id);
  }
  if (plan) {
    refreshActivePlanEconomics(state, cat, plan, priceOf);
    ensurePlanOrders(state, plan, priceOf);
  }
  syncBuildingOfferForCat(state, cat, priceOf);
}

export function completeProcurementPlan(state: GameState, catId: string, itemId: ItemId): number {
  const activePlan = state.procurementPlans.find((entry) => entry.catId === catId && entry.outputItemId === itemId && entry.status === "active");
  if (activePlan) {
    activePlan.status = "completed";
    for (const order of state.demandOrders.filter((entry) => entry.planId === activePlan.id && entry.status === "open")) {
      cancelDemandOrder(state, order.id, "生产计划已经完成");
    }
  }
  const bounty = state.discoveryBounties.find((entry) => entry.itemId === itemId && !entry.paid && entry.claimedByCatId === catId);
  if (!bounty) return 0;
  bounty.paid = true;
  publishBountySignal(state, itemId, "closed", catId);
  for (const obsolete of state.procurementPlans.filter((entry) => entry.status === "active"
    && entry.reason === "bounty" && entry.outputItemId === itemId)) {
    cancelPlan(state, obsolete, "首次发现悬赏已经由其他生产者完成");
  }
  recordSystemLawHit(state, "starter-law-discovery-bounty");
  const completedPlan = state.procurementPlans.find((entry) => entry.catId === catId
    && entry.outputItemId === itemId && entry.reason === "bounty"
    && entry.status === "completed");
  return completedPlan?.bountyCents ?? effectiveBountyAmountCents(state, itemId, state.cats.find((cat) => cat.id === catId));
}

export function claimDiscoveryBounty(state: GameState, catId: string, itemId: ItemId): boolean {
  const bounty = state.discoveryBounties.find((entry) => entry.itemId === itemId && !entry.paid);
  if (!bounty) return false;
  if (bounty.claimedByCatId === null) bounty.claimedByCatId = catId;
  return bounty.claimedByCatId === catId;
}

export interface MarketRepairSummary {
  repairedContractIds: string[];
  cancelledOrderIds: string[];
  cancelledPlanIds: string[];
  affectedCatIds: string[];
  recoveredCargo: Array<{ contractId: string; itemId: ItemId; recipient: string }>;
  refundedEscrowCents: number;
}

function emptyMarketRepairSummary(): MarketRepairSummary {
  return {
    repairedContractIds: [],
    cancelledOrderIds: [],
    cancelledPlanIds: [],
    affectedCatIds: [],
    recoveredCargo: [],
    refundedEscrowCents: 0,
  };
}

function routeFailure(state: GameState, routeCatIds: readonly string[], expectedStart: string, expectedEnd: string): string | null {
  if (routeCatIds.length < 1) return "运输路线为空";
  if (routeCatIds[0] !== expectedStart) return "运输路线起点与卖方不一致";
  if (routeCatIds.at(-1) !== expectedEnd) return "运输路线终点与目的地不一致";
  if (new Set(routeCatIds).size !== routeCatIds.length) return "运输路线形成循环";
  const routeCats = routeCatIds.map((catId) => state.cats.find((cat) => cat.id === catId));
  if (routeCats.some((cat) => !cat)) return "运输路线引用了已不存在的猫";
  for (let index = 0; index < routeCats.length - 1; index += 1) {
    if (!directionBetween(routeCats[index]!, routeCats[index + 1]!)) return "运输路线包含不相邻工位";
  }
  return null;
}

function shipmentContractFailure(state: GameState, contract: ShipmentContract): string | null {
  const order = state.demandOrders.find((entry) => entry.id === contract.orderId);
  if (!order || order.status !== "contracted") return "合同没有对应的已成交订单";
  if (order.itemId !== contract.itemId || order.destinationCatId !== contract.destinationCatId) return "合同与订单内容不一致";
  if (contract.buyerKind !== order.buyerKind || contract.buyerCatId !== order.buyerCatId) return "合同买方与订单不一致";
  if (contract.buyerKind === "cat" && !state.cats.some((cat) => cat.id === contract.buyerCatId)) return "合同买方已不存在";
  const routeError = routeFailure(state, contract.routeCatIds, contract.sellerCatId, contract.destinationCatId);
  if (routeError) return routeError;
  if (!Number.isInteger(contract.currentLeg) || contract.currentLeg < 0 || contract.currentLeg >= contract.routeCatIds.length - 1) {
    return "合同当前运输段无效";
  }
  if (contract.routeCatIds[contract.currentLeg] !== contract.custodianCatId) return "合同托管猫与当前运输段不一致";
  if (!Number.isFinite(contract.escrowCents) || contract.escrowCents < 0) return "合同保证金无效";
  return null;
}

function markPlanCancelled(summary: MarketRepairSummary, plan: ProcurementPlan, reason: string, state: GameState): void {
  if (plan.status !== "active") return;
  summary.cancelledPlanIds.push(plan.id);
  summary.affectedCatIds.push(plan.catId);
  cancelPlan(state, plan, reason);
}

function closeContractOrderAfterFailure(
  state: GameState,
  order: DemandOrder | undefined,
  reason: string,
  summary: MarketRepairSummary,
): void {
  if (!order || order.status === "cancelled") return;
  order.status = "cancelled";
  order.closedAt = state.simTime;
  order.closeReason = reason;
  summary.cancelledOrderIds.push(order.id);
  pushLifecycle(state, order, "cancelled", reason, order.destinationCatId);
}

function recoverContractCargo(
  state: GameState,
  contract: ShipmentContract,
  summary: MarketRepairSummary,
): void {
  const seller = state.cats.find((cat) => cat.id === contract.sellerCatId);
  const buyer = contract.buyerKind === "cat"
    ? state.cats.find((cat) => cat.id === contract.buyerCatId)
    : undefined;
  const custodian = state.cats.find((cat) => cat.id === contract.custodianCatId);

  // Before the first completed hop the seller has not been paid, so the item
  // remains the seller's property. Afterwards it belongs to the funded buyer.
  if (contract.currentLeg === 0 && seller) {
    seller.inventory[contract.itemId] = (seller.inventory[contract.itemId] ?? 0) + 1;
    summary.recoveredCargo.push({ contractId: contract.id, itemId: contract.itemId, recipient: seller.id });
    summary.affectedCatIds.push(seller.id);
    return;
  }
  if (contract.buyerKind === "treasury") {
    state.playerBuildingInventory[contract.itemId] = (state.playerBuildingInventory[contract.itemId] ?? 0) + 1;
    publishWarehouseBroadcast(state, custodian?.id ?? seller?.id ?? state.cats[0]?.id ?? "", contract.itemId);
    summary.recoveredCargo.push({ contractId: contract.id, itemId: contract.itemId, recipient: "treasury-warehouse" });
    return;
  }
  const recipient = buyer ?? custodian ?? seller ?? state.cats[0];
  if (!recipient) return;
  recipient.inventory[contract.itemId] = (recipient.inventory[contract.itemId] ?? 0) + 1;
  summary.recoveredCargo.push({ contractId: contract.id, itemId: contract.itemId, recipient: recipient.id });
  summary.affectedCatIds.push(recipient.id);
}

function unwindBrokenContract(
  state: GameState,
  contract: ShipmentContract,
  reason: string,
  summary: MarketRepairSummary,
): void {
  recoverContractCargo(state, contract, summary);
  const refund = Math.max(0, Math.floor(contract.escrowCents));
  if (refund > 0) {
    if (contract.buyerKind === "treasury") {
      state.treasuryCoins += refund;
    } else {
      const buyer = state.cats.find((cat) => cat.id === contract.buyerCatId);
      if (buyer) {
        applyPrivateIncome(buyer, refund);
        summary.affectedCatIds.push(buyer.id);
      } else {
        state.treasuryCoins += refund;
      }
    }
  }
  summary.refundedEscrowCents += refund;
  contract.escrowCents = 0;

  for (const cat of state.cats) {
    if (cat.action?.contractId !== contract.id) continue;
    cat.action = null;
    cat.lastDecision = `运输合同异常解约：${reason}`;
    summary.affectedCatIds.push(cat.id);
  }

  const order = state.demandOrders.find((entry) => entry.id === contract.orderId);
  closeContractOrderAfterFailure(state, order, `运输合同异常解约：${reason}`, summary);
  if (order?.planId) {
    const buyerPlan = state.procurementPlans.find((plan) => plan.id === order.planId);
    if (buyerPlan) markPlanCancelled(summary, buyerPlan, `原料合同失效：${reason}`, state);
  }
  for (const supplierPlan of state.procurementPlans.filter((plan) => plan.terminalOrderId === contract.orderId)) {
    markPlanCancelled(summary, supplierPlan, `下游合同失效：${reason}`, state);
  }
  state.buildingOrders = state.buildingOrders.filter((orderEntry) => orderEntry.contractId !== contract.id);
  summary.repairedContractIds.push(contract.id);
}

function openOrderQuoteFailure(state: GameState, order: DemandOrder): string | null {
  if (order.buyerKind === "cat" && !state.cats.some((cat) => cat.id === order.buyerCatId)) return "订单买方已不存在";
  if (!state.cats.some((cat) => cat.id === order.destinationCatId)) return "订单目的地已不存在";
  if (!order.committedSellerCatId) return null;
  if (order.quotedSellerCents === undefined || !order.quotedRouteCatIds) return "订单可靠报价不完整";
  return routeFailure(state, order.quotedRouteCatIds, order.committedSellerCatId, order.destinationCatId);
}

function clearBrokenOpenQuote(state: GameState, order: DemandOrder, reason: string, summary: MarketRepairSummary): void {
  const ownerPlan = order.planId ? state.procurementPlans.find((plan) => plan.id === order.planId) : undefined;
  if (ownerPlan?.status === "active") {
    markPlanCancelled(summary, ownerPlan, `整包订单报价失效：${reason}`, state);
    return;
  }
  for (const supplierPlan of state.procurementPlans.filter((plan) => plan.status === "active" && plan.terminalOrderId === order.id)) {
    markPlanCancelled(summary, supplierPlan, `承诺订单报价失效：${reason}`, state);
  }
  order.committedSellerCatId = null;
  order.quotedSellerCents = undefined;
  order.quotedRouteCatIds = undefined;
  order.quotedFeesByCatId = undefined;
  order.quoteFinancingReserveCents = undefined;
  order.quoteRevision = undefined;
  publishMarketBroadcast(state, {
    kind: "demand-open",
    subjectId: order.id,
    itemId: order.itemId,
    sourceCatId: order.destinationCatId,
    amountCents: order.maxDeliveredCents,
    reason: `旧报价已清除：${reason}`,
  });
  state.dirtyDecisions = true;
}

function cancelInvalidActivePlans(state: GameState, summary: MarketRepairSummary): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const plan of state.procurementPlans.filter((entry) => entry.status === "active")) {
      const ownerExists = state.cats.some((cat) => cat.id === plan.catId);
      const bundleOrders = (plan.bundleOrderIds ?? []).map((id) => state.demandOrders.find((order) => order.id === id));
      const terminal = plan.terminalOrderId
        ? state.demandOrders.find((order) => order.id === plan.terminalOrderId)
        : undefined;
      const contractedWithoutCargo = bundleOrders.some((order) => order?.status === "contracted"
        && !state.shipmentContracts.some((contract) => contract.orderId === order.id));
      const reason = !ownerExists
        ? "生产计划工位已不存在"
        : bundleOrders.some((order) => !order || order.status === "cancelled")
          ? "生产计划引用的原料订单已失效"
          : contractedWithoutCargo
            ? "已成交原料订单缺少托管货物"
            : plan.terminalOrderId && (!terminal || terminal.status !== "open")
              ? "生产计划的下游订单已失效"
              : null;
      if (!reason) continue;
      markPlanCancelled(summary, plan, reason, state);
      changed = true;
    }
  }
}

function cancelPlanCycles(state: GameState, summary: MarketRepairSummary): void {
  const activePlans = state.procurementPlans.filter((plan) => plan.status === "active");
  const supplierPlanByOrder = new Map(activePlans
    .filter((plan) => plan.terminalOrderId)
    .map((plan) => [plan.terminalOrderId!, plan]));
  const edges = new Map(activePlans.map((plan) => [plan.id, (plan.bundleOrderIds ?? [])
    .map((orderId) => supplierPlanByOrder.get(orderId)?.id)
    .filter((id): id is string => Boolean(id))]));
  const visited = new Set<string>();
  const stack: string[] = [];
  const inStack = new Set<string>();
  const cyclicIds = new Set<string>();
  const visit = (planId: string): void => {
    if (inStack.has(planId)) {
      const start = stack.indexOf(planId);
      for (const id of stack.slice(Math.max(0, start))) cyclicIds.add(id);
      return;
    }
    if (visited.has(planId)) return;
    visited.add(planId);
    inStack.add(planId);
    stack.push(planId);
    for (const next of edges.get(planId) ?? []) visit(next);
    stack.pop();
    inStack.delete(planId);
  };
  for (const plan of activePlans) visit(plan.id);
  for (const plan of activePlans.filter((entry) => cyclicIds.has(entry.id))) {
    markPlanCancelled(summary, plan, "生产采购计划形成循环等待，已释放订单并重新决策", state);
  }
}

function cancelDuplicateActivePlans(state: GameState, summary: MarketRepairSummary): void {
  const plansByCat = new Map<string, ProcurementPlan[]>();
  for (const plan of state.procurementPlans.filter((entry) => entry.status === "active")) {
    const plans = plansByCat.get(plan.catId) ?? [];
    plans.push(plan);
    plansByCat.set(plan.catId, plans);
  }
  for (const plans of plansByCat.values()) {
    if (plans.length < 2) continue;
    plans.sort((left, right) => left.createdAt - right.createdAt || stableIdCompare(left.id, right.id));
    for (const duplicate of plans.slice(1)) {
      markPlanCancelled(summary, duplicate, `同一工位已有更早的活动计划 ${plans[0].id}，重复账单已释放`, state);
    }
  }
}

/**
 * Repair persisted/runtime market references without minting or deleting cargo.
 * Broken contracts are an exceptional technical failure: remaining escrow is
 * returned, the single contract-held item is restored to its legal owner, and
 * dependent plans are cancelled so ordinary law decisions can quote again.
 */
export function repairBrokenMarketReferences(state: GameState): MarketRepairSummary {
  const summary = emptyMarketRepairSummary();
  const brokenContracts = state.shipmentContracts
    .filter((contract) => contract.status !== "delivered")
    .map((contract) => ({ contract, reason: shipmentContractFailure(state, contract) }))
    .filter((entry): entry is { contract: ShipmentContract; reason: string } => Boolean(entry.reason));
  for (const { contract, reason } of brokenContracts) unwindBrokenContract(state, contract, reason, summary);
  if (brokenContracts.length > 0) {
    const repairedIds = new Set(brokenContracts.map((entry) => entry.contract.id));
    state.shipmentContracts = state.shipmentContracts.filter((contract) => !repairedIds.has(contract.id));
  }

  for (const order of state.demandOrders.filter((entry) => entry.status === "open")) {
    const failure = openOrderQuoteFailure(state, order);
    if (!failure) continue;
    if ((order.buyerKind === "cat" && !state.cats.some((cat) => cat.id === order.buyerCatId))
      || !state.cats.some((cat) => cat.id === order.destinationCatId)) {
      cancelDemandOrder(state, order.id, failure);
      summary.cancelledOrderIds.push(order.id);
      continue;
    }
    clearBrokenOpenQuote(state, order, failure, summary);
  }

  cancelInvalidActivePlans(state, summary);
  cancelDuplicateActivePlans(state, summary);
  cancelPlanCycles(state, summary);
  cancelInvalidActivePlans(state, summary);
  if (summary.repairedContractIds.length > 0 || summary.cancelledOrderIds.length > 0 || summary.cancelledPlanIds.length > 0) {
    state.dirtyDecisions = true;
  }
  summary.repairedContractIds = [...new Set(summary.repairedContractIds)];
  summary.cancelledOrderIds = [...new Set(summary.cancelledOrderIds)];
  summary.cancelledPlanIds = [...new Set(summary.cancelledPlanIds)];
  summary.affectedCatIds = [...new Set(summary.affectedCatIds)].filter((catId) => state.cats.some((cat) => cat.id === catId));
  return summary;
}

export function cancelContractsReferencingCat(state: GameState, catId: string): MarketRepairSummary {
  const summary = emptyMarketRepairSummary();
  const affected = state.shipmentContracts.filter((contract) => contract.status !== "delivered" && (
    contract.routeCatIds.includes(catId)
    || contract.sellerCatId === catId
    || contract.buyerCatId === catId
    || contract.destinationCatId === catId
    || contract.custodianCatId === catId
  ));
  for (const contract of affected) unwindBrokenContract(state, contract, `工位 ${catId} 已被移除`, summary);
  const affectedIds = new Set(affected.map((contract) => contract.id));
  state.shipmentContracts = state.shipmentContracts.filter((contract) => !affectedIds.has(contract.id));
  summary.affectedCatIds = [...new Set(summary.affectedCatIds)];
  if (affected.length > 0) state.dirtyDecisions = true;
  return summary;
}

export function readyContractForCat(state: GameState, catId: string): ShipmentContract | undefined {
  return state.shipmentContracts.filter((contract) => contract.status !== "delivered"
    && shipmentContractFailure(state, contract) === null
    && contract.routeCatIds[contract.currentLeg] === catId
    && contract.custodianCatId === catId)
    .sort((a, b) => a.acceptedAt - b.acceptedAt || stableIdCompare(a.id, b.id))[0];
}

function directionBetween(from: CatState, to: CatState): Direction | null {
  const dx = to.position.x - from.position.x;
  const dy = to.position.y - from.position.y;
  return DIRECTIONS.find(([, offsetX, offsetY]) => offsetX === dx && offsetY === dy)?.[0] ?? null;
}

export function contractActionForCat(state: GameState, cat: CatState): Exclude<CatAction, null> | null {
  const contract = readyContractForCat(state, cat.id);
  if (!contract) return null;
  const next = state.cats.find((entry) => entry.id === contract.routeCatIds[contract.currentLeg + 1]);
  const direction = next ? directionBetween(cat, next) : null;
  if (!next || !direction) return null;
  return { type: "pass", direction, itemId: contract.itemId };
}

export function contractForAction(state: GameState, cat: CatState, action: Exclude<CatAction, null>): ShipmentContract | undefined {
  if (action.type !== "pass") return undefined;
  const contract = readyContractForCat(state, cat.id);
  if (!contract || contract.itemId !== action.itemId) return undefined;
  const next = state.cats.find((entry) => entry.id === contract.routeCatIds[contract.currentLeg + 1]);
  return next && directionBetween(cat, next) === action.direction ? contract : undefined;
}

export function expectedActionGainCents(
  state: GameState,
  cat: CatState,
  action: Exclude<CatAction, null>,
  priceOf: (itemId: ItemId) => number,
): number {
  if (action.type === "pass") {
    const contract = contractForAction(state, cat, action);
    if (!contract) return -1;
    return contract.currentLeg === 0 ? contract.sellerPriceCents : contract.feesByCatId[cat.id] ?? 1;
  }
  const recipe = RECIPE_BY_ID.get(action.recipeId);
  if (!recipe) return -1;
  const plan = planForCat(state, cat.id);
  if (plan && plan.recipeId === recipe.id && plan.phase === "ready") {
    return Math.max(MIN_PLAN_PROFIT_CENTS, plan.expectedProfitCents ?? MIN_PLAN_PROFIT_CENTS);
  }
  const heardOrder = signalsForCat(state, cat.id)
    .map((signal) => state.demandOrders.find((order) => order.id === signal.orderId && order.status === "open"))
    .filter((order): order is DemandOrder => Boolean(order && itemDependencyDistance(recipe.output, order.itemId) >= 0))
    .sort((left, right) => right.maxDeliveredCents - left.maxDeliveredCents || stableIdCompare(left.id, right.id))[0];
  if (heardOrder) {
    const targetRecipe = RECIPE_BY_OUTPUT.get(heardOrder.itemId);
    return Math.max(1, heardOrder.maxDeliveredCents - estimatedInputCost(state, targetRecipe?.id ?? "", priceOf));
  }
  const output = externalNetCents(state, recipe.output, priceOf);
  const inputs = effectiveRecipeInputs(recipe, state.difficulty).reduce((sum, input) => sum + input.quantity * externalNetCents(state, input.itemId, priceOf), 0);
  return output - inputs;
}

export function planForCatPublic(state: GameState, catId: string): ProcurementPlan | undefined {
  return planForCat(state, catId);
}

export function settleContractLeg(state: GameState, contractId: string): { delivered: boolean; recipientCatId: string | null; itemId: ItemId } | null {
  const contract = state.shipmentContracts.find((entry) => entry.id === contractId && entry.status !== "delivered");
  if (!contract) return null;
  if (shipmentContractFailure(state, contract)) {
    repairBrokenMarketReferences(state);
    return null;
  }
  const senderId = contract.routeCatIds[contract.currentLeg];
  const sender = state.cats.find((cat) => cat.id === senderId);
  if (sender) {
    const income = contract.currentLeg === 0 ? contract.sellerPriceCents : contract.feesByCatId[sender.id] ?? 1;
    applyPrivateIncome(sender, income);
    contract.escrowCents = Math.max(0, contract.escrowCents - income);
  }
  contract.currentLeg += 1;
  const recipientId = contract.routeCatIds[contract.currentLeg] ?? null;
  if (!recipientId) return null;
  contract.custodianCatId = recipientId;
  const delivered = contract.currentLeg === contract.routeCatIds.length - 1;
  if (delivered) {
    contract.status = "delivered";
    contract.deliveredAt = state.simTime;
    const recipient = state.cats.find((cat) => cat.id === recipientId);
    if (contract.buyerKind === "cat" && recipient) {
      recipient.inventory[contract.itemId] = (recipient.inventory[contract.itemId] ?? 0) + 1;
    }
  } else {
    contract.status = "in-transit";
  }
  return { delivered, recipientCatId: recipientId, itemId: contract.itemId };
}
