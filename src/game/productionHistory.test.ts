import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import { migrateSaveSnapshot } from "./persistence";
import { recordCraftCompletion, recordProductionPlan } from "./productionHistory";
import type { DemandOrder, ProcurementPlan } from "./types";

describe("persistent production stability history", () => {
  it("aggregates plans, required sources, destinations and craft completions", () => {
    const state = createInitialState({ worldSeed: 8201 });
    const producer = state.cats[0];
    const supplier = state.cats[1];
    const destination = state.cats[2];
    const terminal: DemandOrder = {
      id: "terminal", buyerKind: "cat", buyerCatId: destination.id, destinationCatId: destination.id,
      itemId: "plank", maxDeliveredCents: 100, reservedCents: 100, planId: "downstream",
      createdAt: 1, status: "open", closedAt: null, closeReason: null,
    };
    state.demandOrders.push(terminal);
    const plan: ProcurementPlan = {
      id: "plan-history", catId: producer.id, outputItemId: "plank", recipeId: "make_plank",
      terminalOrderId: terminal.id, expectedRevenueCents: 100, createdAt: 2, status: "active", reason: "order",
    };
    const input: DemandOrder = {
      id: "input", buyerKind: "cat", buyerCatId: producer.id, destinationCatId: producer.id,
      itemId: "wood", maxDeliveredCents: 10, reservedCents: 10, planId: plan.id,
      createdAt: 2, status: "open", closedAt: null, closeReason: null, committedSellerCatId: supplier.id,
    };
    recordProductionPlan(state, plan, [input]);
    state.simTime = 5_000;
    recordCraftCompletion(state, producer.id, "plank");
    recordProductionPlan(state, { ...plan, id: "plan-history-2", createdAt: 6_000 }, [input]);

    expect(state.productionHistory.byCat[producer.id].plank).toMatchObject({ plannedCount: 2, craftedCount: 1 });
    expect(state.productionHistory.flows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "input", itemId: "wood", sourceCatId: supplier.id, targetCatId: producer.id, count: 2 }),
      expect.objectContaining({ kind: "output", itemId: "plank", sourceCatId: producer.id, targetCatId: destination.id, count: 2 }),
    ]));
  });

  it("keeps the aggregate when a save is migrated", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 8202 });
    state.simTime = 7_000;
    recordCraftCompletion(state, state.cats[0].id, "wood");
    const migrated = migrateSaveSnapshot(structuredClone(state));
    expect(migrated.productionHistory.byCat[state.cats[0].id].wood?.craftedCount).toBe(1);
    expect(migrated.productionHistory.byCat[state.cats[0].id].wood?.lastCraftedAt).toBe(7_000);
  });
});
