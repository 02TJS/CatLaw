import { ITEM_BY_ID } from "./catalog";
import type {
  DemandOrder,
  GameState,
  ItemId,
  ProcurementPlan,
  ProductionHistory,
  ProductionHistoryCounter,
  ProductionHistoryFlow,
} from "./types";

const emptyCounter = (): ProductionHistoryCounter => ({
  plannedCount: 0,
  craftedCount: 0,
  firstPlannedAt: null,
  lastPlannedAt: null,
  firstCraftedAt: null,
  lastCraftedAt: null,
});

function counterFor(state: GameState, catId: string, itemId: ItemId): ProductionHistoryCounter {
  const byItem = state.productionHistory.byCat[catId] ?? {};
  state.productionHistory.byCat[catId] = byItem;
  const existing = byItem[itemId];
  if (existing) return existing;
  const counter = emptyCounter();
  byItem[itemId] = counter;
  return counter;
}

function flowId(
  outputItemId: ItemId,
  kind: ProductionHistoryFlow["kind"],
  itemId: ItemId,
  sourceCatId: string,
  targetCatId: string,
): string {
  return `${outputItemId}|${kind}|${itemId}|${sourceCatId}|${targetCatId}`;
}

function recordFlow(
  state: GameState,
  outputItemId: ItemId,
  kind: ProductionHistoryFlow["kind"],
  itemId: ItemId,
  sourceCatId: string,
  targetCatId: string,
  at: number,
): void {
  if (!sourceCatId || !targetCatId || sourceCatId === targetCatId) return;
  const id = flowId(outputItemId, kind, itemId, sourceCatId, targetCatId);
  const existing = state.productionHistory.flows.find((entry) => entry.id === id);
  if (existing) {
    existing.count += 1;
    existing.lastAt = Math.max(existing.lastAt, at);
    existing.firstAt = Math.min(existing.firstAt, at);
    return;
  }
  state.productionHistory.flows.push({
    id,
    outputItemId,
    kind,
    itemId,
    sourceCatId,
    targetCatId,
    count: 1,
    firstAt: at,
    lastAt: at,
  });
}

export function recordProductionPlan(state: GameState, plan: ProcurementPlan, planOrders: DemandOrder[]): void {
  const counter = counterFor(state, plan.catId, plan.outputItemId);
  counter.plannedCount += 1;
  counter.firstPlannedAt = counter.firstPlannedAt === null ? plan.createdAt : Math.min(counter.firstPlannedAt, plan.createdAt);
  counter.lastPlannedAt = counter.lastPlannedAt === null ? plan.createdAt : Math.max(counter.lastPlannedAt, plan.createdAt);

  for (const order of planOrders) {
    if (!order.committedSellerCatId) continue;
    recordFlow(state, plan.outputItemId, "input", order.itemId, order.committedSellerCatId, plan.catId, plan.createdAt);
  }
  if (!plan.terminalOrderId) return;
  const terminalOrder = state.demandOrders.find((order) => order.id === plan.terminalOrderId);
  if (!terminalOrder) return;
  recordFlow(state, plan.outputItemId, "output", plan.outputItemId, plan.catId, terminalOrder.destinationCatId, plan.createdAt);
}

export function recordCraftCompletion(state: GameState, catId: string, itemId: ItemId): void {
  const counter = counterFor(state, catId, itemId);
  counter.craftedCount += 1;
  counter.firstCraftedAt = counter.firstCraftedAt === null ? state.simTime : Math.min(counter.firstCraftedAt, state.simTime);
  counter.lastCraftedAt = counter.lastCraftedAt === null ? state.simTime : Math.max(counter.lastCraftedAt, state.simTime);
}

function finiteTime(value: unknown): number | null {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : null;
}

function sanitizedCounter(value: any): ProductionHistoryCounter {
  return {
    plannedCount: Number.isFinite(value?.plannedCount) ? Math.max(0, Math.floor(value.plannedCount)) : 0,
    craftedCount: Number.isFinite(value?.craftedCount) ? Math.max(0, Math.floor(value.craftedCount)) : 0,
    firstPlannedAt: finiteTime(value?.firstPlannedAt),
    lastPlannedAt: finiteTime(value?.lastPlannedAt),
    firstCraftedAt: finiteTime(value?.firstCraftedAt),
    lastCraftedAt: finiteTime(value?.lastCraftedAt),
  };
}

function sanitizePersistedHistory(raw: any): ProductionHistory {
  const history: ProductionHistory = { byCat: {}, flows: [] };
  if (raw?.byCat && typeof raw.byCat === "object") {
    for (const [catId, rawByItem] of Object.entries(raw.byCat as Record<string, unknown>)) {
      if (!rawByItem || typeof rawByItem !== "object") continue;
      const byItem: Partial<Record<ItemId, ProductionHistoryCounter>> = {};
      for (const [itemId, rawCounter] of Object.entries(rawByItem as Record<string, unknown>)) {
        if (!ITEM_BY_ID.has(itemId)) continue;
        byItem[itemId] = sanitizedCounter(rawCounter);
      }
      history.byCat[catId] = byItem;
    }
  }
  const seen = new Set<string>();
  for (const rawFlow of Array.isArray(raw?.flows) ? raw.flows : []) {
    if (!rawFlow || !ITEM_BY_ID.has(rawFlow.outputItemId) || !ITEM_BY_ID.has(rawFlow.itemId)) continue;
    if (!["input", "output"].includes(rawFlow.kind)) continue;
    if (typeof rawFlow.sourceCatId !== "string" || typeof rawFlow.targetCatId !== "string"
      || rawFlow.sourceCatId === rawFlow.targetCatId) continue;
    const id = flowId(rawFlow.outputItemId, rawFlow.kind, rawFlow.itemId, rawFlow.sourceCatId, rawFlow.targetCatId);
    if (seen.has(id)) continue;
    seen.add(id);
    history.flows.push({
      id,
      outputItemId: rawFlow.outputItemId,
      kind: rawFlow.kind,
      itemId: rawFlow.itemId,
      sourceCatId: rawFlow.sourceCatId,
      targetCatId: rawFlow.targetCatId,
      count: Number.isFinite(rawFlow.count) ? Math.max(1, Math.floor(rawFlow.count)) : 1,
      firstAt: finiteTime(rawFlow.firstAt) ?? 0,
      lastAt: finiteTime(rawFlow.lastAt) ?? 0,
    });
  }
  return history;
}

export function normalizeProductionHistory(state: GameState, rawHistory: unknown): void {
  state.productionHistory = sanitizePersistedHistory(rawHistory);
  if (rawHistory && typeof rawHistory === "object") return;

  // Backfill the retained market tail for older saves. From this version on,
  // aggregation happens at plan/craft time and therefore survives compaction.
  for (const plan of state.procurementPlans) {
    const orders = state.demandOrders.filter((order) => order.planId === plan.id);
    recordProductionPlan(state, plan, orders);
  }
  for (const event of state.recentProductionEvents) {
    if (!ITEM_BY_ID.has(event.itemId)) continue;
    recordCraftCompletion({ ...state, simTime: event.at } as GameState, event.catId, event.itemId);
  }
}
