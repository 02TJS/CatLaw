import {
  CATALOG_ANALYSIS,
  DEPLOYABLE_BUILDING_IDS,
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
import { positionKey } from "./world";

// Broadcasts are immediate. This interval only wakes idle cats for a periodic
// market review, so one normal action duration is sufficient.
export const MARKET_SIGNAL_INTERVAL_MS = 5_000;
export const MAX_SIGNALS_PER_CAT = 32;
export const MAX_SIGNALS_PER_ITEM = 2;
export const BASE_CREDIT_CENTS = 2_500;
export const LOAN_RATE = 0.02;

const PRICE_SENSITIVE_JOB_RECIPE_IDS = new Set(RECIPES.slice(21, 30).map((recipe) => recipe.id));
const JOB_PRICE_PASS_THROUGH = 1.5;


const DIRECTIONS: Array<[Direction, number, number]> = [
  ["north", 0, -1],
  ["east", 1, 0],
  ["south", 0, 1],
  ["west", -1, 0],
];

export function recordSystemLawHit(state: GameState, lawId: string): void {
  const law = state.laws.find((entry) => entry.id === lawId && entry.status === "active");
  if (law) law.hitCount += 1;
}

export function createDiscoveryBounties(difficulty: GameState["difficulty"] = 2): DiscoveryBounty[] {
  return RECIPES.map((recipe) => {
    return {
      itemId: recipe.output,
      amountCents: Math.round((CATALOG_ANALYSIS.basePrices[recipe.output] ?? 1) * 100 * difficultyProfile(difficulty).bountyMultiplier),
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
  state.marketBroadcasts = state.marketBroadcasts.filter((entry) => entry.subjectId !== broadcast.subjectId);
  state.marketBroadcasts.push(broadcast);
  state.dirtyDecisions = true;
  return broadcast;
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
    amountCents: bounty.amountCents,
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
}

export function bountyBroadcastsForCat(state: GameState, _catId: string): MarketBroadcast[] {
  const latestByItem = new Map<ItemId, MarketBroadcast>();
  for (const broadcast of broadcastsForCat(state, _catId)) {
    if (broadcast.kind !== "bounty-open" && broadcast.kind !== "bounty-closed") continue;
    if (!latestByItem.has(broadcast.itemId)) latestByItem.set(broadcast.itemId, broadcast);
  }
  return [...latestByItem.values()].filter((entry) => entry.kind === "bounty-open");
}

export function buildingOfferBroadcastsForCat(state: GameState, _catId: string): MarketBroadcast[] {
  const latestByOffer = new Map<string, MarketBroadcast>();
  for (const broadcast of broadcastsForCat(state, _catId)) {
    if (broadcast.kind !== "building-offer-open" && broadcast.kind !== "building-offer-closed") continue;
    if (!latestByOffer.has(broadcast.subjectId)) latestByOffer.set(broadcast.subjectId, broadcast);
  }
  return [...latestByOffer.values()].filter((entry) => entry.kind === "building-offer-open");
}

export function buildingOfferReservedQuantity(state: GameState, catId: string, itemId: ItemId): number {
  return state.buildingOffers.filter((offer) => offer.status === "open"
    && offer.sellerCatId === catId && offer.itemId === itemId).length;
}

export function activeTaxRate(state: GameState): number {
  return state.laws.find((law) => law.status === "active" && law.category === "tax" && law.taxRate !== null)?.taxRate ?? 0;
}

export function externalNetCents(state: GameState, itemId: ItemId, priceOf: (itemId: ItemId) => number): number {
  const gross = priceOf(itemId);
  const rate = activeTaxRate(state);
  const tax = rate > 0 ? Math.min(gross, Math.ceil(gross * rate)) : 0;
  return Math.max(0, gross - tax);
}

/** Net liquidation value at a cat's current site, including landmark sale bonus and tax. */
export function externalNetCentsAt(state: GameState, itemId: ItemId, priceOf: (itemId: ItemId) => number, cat: CatState): number {
  const gross = Math.ceil(priceOf(itemId) * (1 + landmarkEffectsAt(state, cat.position).saleValueBonus));
  const rate = activeTaxRate(state);
  const tax = rate > 0 ? Math.min(gross, Math.ceil(gross * rate)) : 0;
  return Math.max(0, gross - tax);
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
  return difficultyProfile(state.difficulty).baseCreditCents
    + landmarkEffectsAt(state, cat.position).creditBonusCents
    + Math.max(0, netWorthCents(state, cat, priceOf));
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
  state.orderSignals = state.orderSignals.filter((signal) => signal.orderId !== order.id);
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
  state.orderSignals.push({
    orderId: order.id,
    catId: "*",
    routeCatIds: [order.destinationCatId],
    hops: 0,
    estimatedFreightCents: 0,
    effectiveBidCents: order.maxDeliveredCents,
    receivedAt: state.simTime,
  });
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
    || left.orderId.localeCompare(right.orderId)
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
  for (const broadcast of broadcastsForCat(state, _catId)) {
    if (!broadcast.kind.startsWith("demand-")) continue;
    if (!latestByOrder.has(broadcast.subjectId)) latestByOrder.set(broadcast.subjectId, broadcast);
  }
  const openIds = new Set([...latestByOrder.values()].filter((entry) => entry.kind === "demand-open").map((entry) => entry.subjectId));
  return trimSignalCache(state, state.orderSignals.filter((signal) => openIds.has(signal.orderId))).sort(signalSort);
}

function planForCat(state: GameState, catId: string): ProcurementPlan | undefined {
  return state.procurementPlans.find((plan) => plan.catId === catId && plan.status === "active");
}

function estimatedInputCost(state: GameState, recipeId: string, priceOf: (itemId: ItemId) => number): number {
  const recipe = RECIPE_BY_ID.get(recipeId);
  if (!recipe) return Number.POSITIVE_INFINITY;
  return effectiveRecipeInputs(recipe, state.difficulty).reduce((sum, input) => sum + input.quantity * (externalNetCents(state, input.itemId, priceOf) + 25), 0);
}

function requiredWorkingCapitalCents(
  state: GameState,
  cat: CatState,
  recipeId: string,
  priceOf: (itemId: ItemId) => number,
): number {
  const recipe = RECIPE_BY_ID.get(recipeId);
  if (!recipe) return Number.POSITIVE_INFINITY;
  return effectiveRecipeInputs(recipe, state.difficulty).reduce((sum, input) => {
    const owned = unofferedOwnedQuantity(state, cat, input.itemId);
    const missing = Math.max(0, input.quantity - owned);
    return sum + missing * productionOrderBidCents(state, recipe.id, input.itemId, priceOf);
  }, 0);
}

/**
 * Existing order-market price formation for material jobs. On difficulty five,
 * goods 22-30 pass an aggressive output-price signal through to the bids for
 * every required input job. This uses ordinary order escrow and cat credit:
 * there is no extra balance, certification or hard gate. A richer cat can
 * still pay, while a modest price signal plus retained/transported stock keeps
 * the supply chain liquid.
 */
export function productionOrderBidCents(
  state: GameState,
  recipeId: string,
  inputItemId: ItemId,
  priceOf: (itemId: ItemId) => number,
): number {
  const recipe = RECIPE_BY_ID.get(recipeId);
  const ordinaryBid = externalNetCents(state, inputItemId, priceOf) + 100;
  if (!recipe || state.difficulty !== 5 || !PRICE_SENSITIVE_JOB_RECIPE_IDS.has(recipe.id)) return ordinaryBid;
  const jobCount = effectiveRecipeInputs(recipe, state.difficulty).reduce((sum, input) => sum + input.quantity, 0);
  const baseOutputCents = (CATALOG_ANALYSIS.basePrices[recipe.output] ?? 1) * 100;
  const advertisedPremiumCents = Math.max(0, priceOf(recipe.output) - baseOutputCents);
  const jobPremiumCents = Math.ceil(advertisedPremiumCents * JOB_PRICE_PASS_THROUGH / Math.max(1, jobCount));
  return ordinaryBid + jobPremiumCents;
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
  return state.difficulty === 5 && PRICE_SENSITIVE_JOB_RECIPE_IDS.has(recipeId);
}

function createPlan(
  state: GameState,
  cat: CatState,
  outputItemId: ItemId,
  terminalOrderId: string | null,
  expectedRevenueCents: number,
  reason: ProcurementPlan["reason"],
): ProcurementPlan | null {
  const recipe = RECIPE_BY_OUTPUT.get(outputItemId);
  if (!recipe || !state.unlockedRecipes.includes(recipe.id) || siteFailure(state, cat, recipe)) return null;
  const plan: ProcurementPlan = {
    id: `plan-${state.nextProcurementPlanIndex++}`,
    catId: cat.id,
    outputItemId,
    recipeId: recipe.id,
    terminalOrderId,
    expectedRevenueCents,
    createdAt: state.simTime,
    status: "active",
    reason,
  };
  state.procurementPlans.push(plan);
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
}

function ensurePlanOrders(state: GameState, plan: ProcurementPlan, priceOf: (itemId: ItemId) => number): void {
  const cat = state.cats.find((entry) => entry.id === plan.catId);
  const recipe = RECIPE_BY_ID.get(plan.recipeId);
  if (!cat || !recipe || siteFailure(state, cat, recipe)) {
    cancelPlan(state, plan, "生产位置或配方失效");
    return;
  }
  for (const input of effectiveRecipeInputs(recipe, state.difficulty)) {
    const maxDeliveredCents = productionOrderBidCents(state, recipe.id, input.itemId, priceOf);
    // Price-law changes never mutate an order in place. Close the old global
    // ID and let the plan publish a fresh one with a newly locked bid.
    for (const stale of state.demandOrders.filter((order) => order.status === "open"
      && order.planId === plan.id && order.itemId === input.itemId
      && (order.maxDeliveredCents !== maxDeliveredCents || order.reservedCents !== maxDeliveredCents))) {
      cancelDemandOrder(state, stale.id, "价格法变化：旧订单作废并重新报价");
    }
    const inbound = state.shipmentContracts.filter((contract) => contract.status !== "delivered"
      && contract.buyerKind === "cat" && contract.buyerCatId === cat.id && contract.itemId === input.itemId).length;
    const open = state.demandOrders.filter((order) => order.status === "open" && order.planId === plan.id && order.itemId === input.itemId).length;
    // A plan protects its inputs from sale and third-party orders, but those
    // same inputs are available to the cat executing that plan. Only public
    // building offers must be excluded when calculating its own shortage.
    const missing = Math.max(0, input.quantity - unofferedOwnedQuantity(state, cat, input.itemId) - inbound - open);
    for (let index = 0; index < missing; index += 1) {
      const created = openDemandOrder(state, {
        buyerKind: "cat",
        buyerCatId: cat.id,
        destinationCatId: cat.id,
        itemId: input.itemId,
        maxDeliveredCents,
        reservedCents: maxDeliveredCents,
        planId: plan.id,
      }, priceOf);
      if (!created) break;
    }
  }
}

const BOUNTY_PRIORITY: ItemId[] = [
  "wood", "stone", "sand", "water", "fiber", "ore", "fire", "metal",
  "plank", "brick", "gear", "thread", "paper", "tools", "glass",
];
const TUTORIAL_BOUNTY_ITEMS = new Set(RECIPES.slice(0, 15).map((recipe) => recipe.output));

function bountyHasPriceGuidance(state: GameState, itemId: ItemId): boolean {
  if (TUTORIAL_BOUNTY_ITEMS.has(itemId)) return true;
  return state.laws.some((law) => law.status === "active" && law.category === "price"
    && (law.priceItemId === itemId || law.priceItemId === "*")
    && (law.priceMultiplier ?? 1) > 1);
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

function tryCreateOrderPlanForCat(state: GameState, cat: CatState, priceOf: (itemId: ItemId) => number): boolean {
  for (const signal of signalsForCat(state, cat.id)) {
    const order = state.demandOrders.find((entry) => entry.id === signal.orderId && entry.status === "open");
    if (!order || order.destinationCatId === cat.id || !localRecipeIsUsable(state, cat, order.itemId)) continue;
    const route = findTransportRoute(state, cat.id, order.destinationCatId);
    if (!route || route.length < 2) continue;
    if (state.procurementPlans.some((plan) => plan.status === "active" && plan.terminalOrderId === order.id)) continue;
    const recipe = RECIPE_BY_OUTPUT.get(order.itemId)!;
    const inputCost = estimatedInputCost(state, recipe.id, priceOf);
    const ask = Math.max(externalNetCents(state, recipe.output, priceOf) + 1, inputCost + 1);
    const estimatedFreight = Math.max(0, route.length - 2);
    if (signal.effectiveBidCents - estimatedFreight < ask) continue;
    if (buyingPowerCents(state, cat, priceOf) < requiredWorkingCapitalCents(state, cat, recipe.id, priceOf)) continue;
    return Boolean(createPlan(state, cat, recipe.output, order.id, ask, "order"));
  }
  return false;
}

function tryCreateBountyPlanForCat(state: GameState, cat: CatState, priceOf: (itemId: ItemId) => number): boolean {
  const priority = new Map(BOUNTY_PRIORITY.map((itemId, index) => [itemId, index]));
  const catalog = new Map(RECIPES.map((recipe, index) => [recipe.output, index]));
  const candidates = bountyBroadcastsForCat(state, cat.id)
    .filter((broadcast) => localRecipeIsUsable(state, cat, broadcast.itemId)
      && bountyHasPriceGuidance(state, broadcast.itemId))
    .sort((left, right) => (priority.get(left.itemId) ?? catalog.get(left.itemId) ?? 999)
      - (priority.get(right.itemId) ?? catalog.get(right.itemId) ?? 999));
  for (const broadcast of candidates) {
    const recipe = RECIPE_BY_OUTPUT.get(broadcast.itemId)!;
    const revenue = externalNetCentsAt(state, recipe.output, priceOf, cat) + broadcast.amountCents;
    if (revenue <= estimatedInputCost(state, recipe.id, priceOf)) continue;
    if (buyingPowerCents(state, cat, priceOf) < requiredWorkingCapitalCents(state, cat, recipe.id, priceOf)) continue;
    if (!claimDiscoveryBounty(state, cat.id, recipe.output)) continue;
    const plan = createPlan(state, cat, recipe.output, null, revenue, "bounty");
    if (!plan) {
      const bounty = state.discoveryBounties.find((entry) => entry.itemId === recipe.output && entry.claimedByCatId === cat.id && !entry.paid);
      if (bounty) bounty.claimedByCatId = null;
      continue;
    }
    return true;
  }
  return false;
}

function tryCreateExternalPlanForCat(state: GameState, cat: CatState, priceOf: (itemId: ItemId) => number): boolean {
  if (Object.values(cat.inventory).some((quantity) => quantity > 0)) return false;
  if (signalsForCat(state, cat.id).length > 0) return false;
  if (bountyBroadcastsForCat(state, cat.id).some((broadcast) => (
    state.unlockedRecipes.includes(RECIPE_BY_OUTPUT.get(broadcast.itemId)?.id ?? "")
  ))) {
    return false;
  }
  const recipes = state.unlockedRecipes.map((id) => RECIPE_BY_ID.get(id))
    .filter((recipe): recipe is NonNullable<typeof recipe> => Boolean(recipe && localRecipeIsUsable(state, cat, recipe.output)))
    .sort((left, right) => {
      const rateLeft = externalNetCentsAt(state, left.output, priceOf, cat) / (CATALOG_ANALYSIS.workUnits[left.output] || 1);
      const rateRight = externalNetCentsAt(state, right.output, priceOf, cat) / (CATALOG_ANALYSIS.workUnits[right.output] || 1);
      return rateRight - rateLeft || right.output.localeCompare(left.output);
    });
  for (const recipe of recipes) {
    const revenue = externalNetCentsAt(state, recipe.output, priceOf, cat);
    if (recipe.inputs.length > 0 && revenue <= estimatedInputCost(state, recipe.id, priceOf)) continue;
    if (buyingPowerCents(state, cat, priceOf) < requiredWorkingCapitalCents(state, cat, recipe.id, priceOf)) continue;
    return Boolean(createPlan(state, cat, recipe.output, null, revenue, "external-sale"));
  }
  return false;
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
  const base = Math.max(1, Math.min(25, Math.floor(bestLiquidation / 100) + 1));
  return Math.ceil(base * (1 + landmarkEffectsAt(state, cat.position).carrierFeeBonus));
}

export function unreservedOwnedQuantity(state: GameState, cat: CatState, itemId: ItemId): number {
  const plan = planForCat(state, cat.id);
  const recipe = plan ? RECIPE_BY_ID.get(plan.recipeId) : undefined;
  const protectedQuantity = recipe ? effectiveRecipeInputs(recipe, state.difficulty).find((input) => input.itemId === itemId)?.quantity ?? 0 : 0;
  return Math.max(0, (cat.inventory[itemId] ?? 0) - protectedQuantity
    - buildingOfferReservedQuantity(state, cat.id, itemId));
}

/**
 * Quantity the owning cat can consume for its own production plan.
 * Building offers are hard reservations; plan inputs are not subtracted here
 * because the plan itself is their intended consumer.
 */
export function unofferedOwnedQuantity(state: GameState, cat: CatState, itemId: ItemId): number {
  return Math.max(0, (cat.inventory[itemId] ?? 0)
    - buildingOfferReservedQuantity(state, cat.id, itemId));
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
  recordSystemLawHit(state, "starter-law-cent-settlement");
  state.dirtyDecisions = true;
  return { ok: true };
}

function fundContract(state: GameState, order: DemandOrder, totalCents: number, priceOf: (itemId: ItemId) => number): boolean {
  if (totalCents > order.reservedCents || totalCents > order.maxDeliveredCents) return false;
  if (order.buyerKind === "treasury") {
    state.treasuryCoins += order.reservedCents - totalCents;
    return true;
  }
  const buyer = state.cats.find((cat) => cat.id === order.buyerCatId);
  if (!buyer) return false;
  buyer.escrowReservedCents = Math.max(0, buyer.escrowReservedCents - order.reservedCents);
  const cash = Math.min(buyer.coins, totalCents);
  buyer.coins -= cash;
  const borrowed = totalCents - cash;
  if (borrowed > 0) {
    const available = creditAvailableCents(state, buyer, priceOf);
    if (borrowed > available) {
      buyer.coins += cash;
      buyer.escrowReservedCents += order.reservedCents;
      return false;
    }
    buyer.debtCents += borrowed + Math.max(1, Math.ceil(borrowed * LOAN_RATE));
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
  const signals = signalsForCat(state, seller.id);
  for (const signal of signals) {
      const order = state.demandOrders.find((entry) => entry.id === signal.orderId && entry.status === "open");
      const buildingOrder = order ? state.buildingOrders.find((entry) => entry.demandOrderId === order.id) : undefined;
      const localBuildingSale = Boolean(buildingOrder && order?.destinationCatId === seller.id);
      if (!order || unreservedOwnedQuantity(state, seller, order.itemId) < 1) continue;
      const route = findTransportRoute(state, seller.id, order.destinationCatId);
      if (!route || (route.length < 2 && !localBuildingSale)) continue;
      const intermediates = route.slice(1, -1).map((id) => state.cats.find((cat) => cat.id === id)).filter((cat): cat is CatState => Boolean(cat));
      if (intermediates.some((cat) => outstandingCarrierLegs(state, cat.id) >= 2)) continue;
      const producerPlan = state.procurementPlans.find((plan) => plan.catId === seller.id
        && plan.terminalOrderId === order.id && plan.outputItemId === order.itemId && plan.status !== "cancelled");
      const sellerPriceCents = Math.max(
        externalNetCents(state, order.itemId, priceOf) + 1,
        producerPlan?.expectedRevenueCents ?? 0,
      );
      const feesByCatId = Object.fromEntries(intermediates.map((cat) => [cat.id, carrierFeeCents(state, cat, priceOf)]));
      const total = sellerPriceCents + Object.values(feesByCatId).reduce((sum, fee) => sum + fee, 0);
      if (total > order.maxDeliveredCents || !fundContract(state, order, total, priceOf)) continue;
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
        recordSystemLawHit(state, "starter-law-cent-settlement");
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
  for (const seller of [...state.cats].sort((a, b) => a.createdIndex - b.createdIndex)) {
    acceptProfitableOrdersForCat(state, seller, priceOf);
  }
}

export function refreshCatMarket(state: GameState, cat: CatState, priceOf: (itemId: ItemId) => number): void {
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
  if (!plan) {
    tryCreateOrderPlanForCat(state, cat, priceOf)
      || tryCreateBountyPlanForCat(state, cat, priceOf)
      || tryCreateExternalPlanForCat(state, cat, priceOf);
    plan = planForCat(state, cat.id);
  }
  if (plan) ensurePlanOrders(state, plan, priceOf);
  acceptProfitableOrdersForCat(state, cat, priceOf);
  syncBuildingOfferForCat(state, cat, priceOf);
}

export function completeProcurementPlan(state: GameState, catId: string, itemId: ItemId): number {
  const plan = state.procurementPlans.find((entry) => entry.catId === catId && entry.outputItemId === itemId && entry.status === "active");
  if (plan) {
    plan.status = "completed";
    for (const order of state.demandOrders.filter((entry) => entry.planId === plan.id && entry.status === "open")) {
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
  return bounty.amountCents;
}

export function claimDiscoveryBounty(state: GameState, catId: string, itemId: ItemId): boolean {
  const bounty = state.discoveryBounties.find((entry) => entry.itemId === itemId && !entry.paid);
  if (!bounty) return false;
  if (bounty.claimedByCatId === null) bounty.claimedByCatId = catId;
  return bounty.claimedByCatId === catId;
}

export function readyContractForCat(state: GameState, catId: string): ShipmentContract | undefined {
  return state.shipmentContracts.filter((contract) => contract.status !== "delivered"
    && contract.routeCatIds[contract.currentLeg] === catId
    && contract.custodianCatId === catId)
    .sort((a, b) => a.acceptedAt - b.acceptedAt || a.id.localeCompare(b.id))[0];
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
  if (action.type === "sell") return externalNetCentsAt(state, action.itemId, priceOf, cat);
  const recipe = RECIPE_BY_ID.get(action.recipeId);
  if (!recipe) return -1;
  const plan = planForCat(state, cat.id);
  if (plan && itemDependencyDistance(recipe.output, plan.outputItemId) >= 0) {
    const cost = estimatedInputCost(state, plan.recipeId, priceOf);
    return Math.max(1, plan.expectedRevenueCents - cost);
  }
  const heardOrder = signalsForCat(state, cat.id)
    .map((signal) => state.demandOrders.find((order) => order.id === signal.orderId && order.status === "open"))
    .filter((order): order is DemandOrder => Boolean(order && itemDependencyDistance(recipe.output, order.itemId) >= 0))
    .sort((left, right) => right.maxDeliveredCents - left.maxDeliveredCents || left.id.localeCompare(right.id))[0];
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
  recordSystemLawHit(state, "starter-law-cent-settlement");
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
