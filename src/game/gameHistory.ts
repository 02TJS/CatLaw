import { creditAvailableCents, netWorthCents } from "./marketEconomics";
import { itemPrice } from "./marketPricing";
import type { CatState, GameState, ItemId } from "./types";

export const WEALTH_HISTORY_SAMPLE_INTERVAL_MS = 5_000;
export const WEALTH_HISTORY_MAX_WINDOW_MS = 300_000;
export const CLOSED_MARKET_HISTORY_LIMIT = 256;
export const LAW_HISTORY_LIMIT = 512;

/** Rolling gross production value, annualized to one logical production minute. */
export function grossProductionValuePerMinute(state: GameState): number {
  const logicalMinuteMs = 60_000 / Math.max(1, state.simulationSpeed);
  const observedMs = Math.max(1, Math.min(logicalMinuteMs, state.simTime));
  const cutoff = state.simTime - logicalMinuteMs;
  const valueCents = state.recentProductionEvents.reduce((sum, event) => {
    if (event.at < cutoff) return sum;
    if (Number.isFinite(event.valueCents)) return sum + Math.max(0, Math.round(event.valueCents ?? 0));
    const producer = state.cats.find((cat) => cat.id === event.catId);
    return sum + itemPrice(state, event.itemId, producer);
  }, 0);
  return Math.round(valueCents * logicalMinuteMs / observedMs);
}

/**
 * Reproduce the exact score used by the Wealth & Credit map lens.
 * Inventory is liquidated at this cat's current lawful price; debt, escrow and
 * available credit remain visible instead of reducing the metric to cash flow.
 */
export function catWealthScoreCents(state: GameState, cat: CatState): number {
  const priceOf = (itemId: ItemId) => itemPrice(state, itemId, cat);
  return Math.round(
    netWorthCents(state, cat, priceOf)
    + creditAvailableCents(state, cat, priceOf)
    - cat.escrowReservedCents,
  );
}

function pruneWealthHistory(state: GameState): void {
  const cutoff = state.simTime - WEALTH_HISTORY_MAX_WINDOW_MS - WEALTH_HISTORY_SAMPLE_INTERVAL_MS;
  state.wealthHistory = state.wealthHistory.filter((sample) => sample.at >= cutoff && sample.at <= state.simTime);
}

/** Capture or replace one deterministic wealth snapshot at the current sim time. */
export function recordWealthHistorySample(state: GameState, force = false): void {
  if (!Array.isArray(state.wealthHistory)) state.wealthHistory = [];
  const last = state.wealthHistory.at(-1);
  if (!force && last && state.simTime - last.at < WEALTH_HISTORY_SAMPLE_INTERVAL_MS) return;
  const sample = {
    at: state.simTime,
    values: Object.fromEntries(state.cats.map((cat) => [cat.id, catWealthScoreCents(state, cat)])),
  };
  if (last?.at === state.simTime) state.wealthHistory[state.wealthHistory.length - 1] = sample;
  else state.wealthHistory.push(sample);
  pruneWealthHistory(state);
}

/** Sanitize persisted samples and anchor the restored world at its load time. */
export function normalizeWealthHistory(state: GameState, rawHistory: unknown): void {
  const currentCatIds = new Set(state.cats.map((cat) => cat.id));
  const byTime = new Map<number, Record<string, number>>();
  for (const raw of Array.isArray(rawHistory) ? rawHistory : []) {
    if (!raw || !Number.isFinite(raw.at) || raw.at < 0 || raw.at > state.simTime || typeof raw.values !== "object") continue;
    const values: Record<string, number> = {};
    for (const [catId, value] of Object.entries(raw.values as Record<string, unknown>)) {
      if (currentCatIds.has(catId) && Number.isFinite(value)) values[catId] = Math.round(Number(value));
    }
    byTime.set(Number(raw.at), values);
  }
  state.wealthHistory = [...byTime]
    .sort(([left], [right]) => left - right)
    .map(([at, values]) => ({ at, values }));
  pruneWealthHistory(state);
  recordWealthHistorySample(state, true);
}

export function compactLawHistory(state: GameState): void {
  if (state.lawHistory.length > LAW_HISTORY_LIMIT) {
    state.lawHistory.splice(0, state.lawHistory.length - LAW_HISTORY_LIMIT);
  }
}

export function compactGameStateHistory(state: GameState): void {
  compactLawHistory(state);
  pruneWealthHistory(state);
  if (state.commandAudit.length > 2_000) state.commandAudit.splice(0, state.commandAudit.length - 2_000);
  if (state.marketEvents.length > 64) state.marketEvents = state.marketEvents.slice(-64);

  const liveContracts = state.shipmentContracts.filter((contract) => contract.status !== "delivered");
  const requiredOrderIds = new Set<string>([
    ...liveContracts.map((contract) => contract.orderId),
    ...state.buildingOrders.flatMap((order) => order.demandOrderId ? [order.demandOrderId] : []),
  ]);
  for (const order of state.demandOrders) if (order.status === "open") requiredOrderIds.add(order.id);

  const requiredPlanIds = new Set(state.demandOrders
    .filter((order) => requiredOrderIds.has(order.id) && order.planId)
    .map((order) => order.planId!));
  const archivedPlans = state.procurementPlans.filter((plan) => plan.status !== "active" && !requiredPlanIds.has(plan.id));
  const retainedArchivedPlanIds = new Set(archivedPlans.slice(-CLOSED_MARKET_HISTORY_LIMIT).map((plan) => plan.id));
  state.procurementPlans = state.procurementPlans.filter((plan) => (
    plan.status === "active" || requiredPlanIds.has(plan.id) || retainedArchivedPlanIds.has(plan.id)
  ));

  const retainedPlanIds = new Set(state.procurementPlans.map((plan) => plan.id));
  const archivedOrders = state.demandOrders.filter((order) => (
    !requiredOrderIds.has(order.id) && !(order.planId && retainedPlanIds.has(order.planId))
  ));
  const retainedArchivedOrderIds = new Set(archivedOrders.slice(-CLOSED_MARKET_HISTORY_LIMIT).map((order) => order.id));
  state.demandOrders = state.demandOrders.filter((order) => (
    requiredOrderIds.has(order.id)
      || Boolean(order.planId && retainedPlanIds.has(order.planId))
      || retainedArchivedOrderIds.has(order.id)
  ));

  const requiredContractIds = new Set(state.buildingOrders.flatMap((order) => order.contractId ? [order.contractId] : []));
  const archivedContracts = state.shipmentContracts.filter((contract) => (
    contract.status === "delivered" && !requiredContractIds.has(contract.id)
  ));
  const retainedArchivedContractIds = new Set(archivedContracts.slice(-CLOSED_MARKET_HISTORY_LIMIT).map((contract) => contract.id));
  state.shipmentContracts = state.shipmentContracts.filter((contract) => (
    contract.status !== "delivered" || requiredContractIds.has(contract.id) || retainedArchivedContractIds.has(contract.id)
  ));

  const closedOffers = state.buildingOffers.filter((offer) => offer.status !== "open");
  const retainedClosedOfferIds = new Set(closedOffers.slice(-CLOSED_MARKET_HISTORY_LIMIT).map((offer) => offer.id));
  state.buildingOffers = state.buildingOffers.filter((offer) => offer.status === "open" || retainedClosedOfferIds.has(offer.id));

  const retainedDemandSubjects = new Set(state.demandOrders.map((order) => order.id));
  const demandBroadcasts = state.marketBroadcasts.filter((broadcast) => broadcast.kind.startsWith("demand-")
    && !retainedDemandSubjects.has(broadcast.subjectId));
  const retainedDemandBroadcastIds = new Set(demandBroadcasts.slice(-CLOSED_MARKET_HISTORY_LIMIT).map((broadcast) => broadcast.id));
  state.marketBroadcasts = state.marketBroadcasts.filter((broadcast) => (
    !broadcast.kind.startsWith("demand-")
      || retainedDemandSubjects.has(broadcast.subjectId)
      || retainedDemandBroadcastIds.has(broadcast.id)
  ));
  const retainedBuildingOfferSubjects = new Set(state.buildingOffers.map((offer) => offer.id));
  state.marketBroadcasts = state.marketBroadcasts.filter((broadcast) => (
    !broadcast.kind.startsWith("building-offer") || retainedBuildingOfferSubjects.has(broadcast.subjectId)
  ));
}
