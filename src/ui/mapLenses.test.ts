import { describe, expect, it } from "vitest";
import { createInitialState } from "../game/engine";
import { buildMapLensSnapshot, LENS_COLORS } from "./mapLenses";

describe("Civilization-style map lenses", () => {
  it("shows owned materials through the inventory enhancement lens", () => {
    const state = createInitialState({ worldSeed: 12345 });
    const first = state.cats[0];
    first.inventory.wood = 2;
    first.inventory.computer = 1;
    const ordinary = buildMapLensSnapshot(state, "none", null);
    const enhanced = buildMapLensSnapshot(state, "inventory", null);
    expect(ordinary.catColors.size).toBe(0);
    expect(enhanced.catColors.get(first.id)?.id).toContain("rose");
    expect(enhanced.legend.at(-1)?.label).toBe("没有库存");
  });

  it("normalizes wealth and credit across the current cat population", () => {
    const state = createInitialState({ worldSeed: 12345 });
    state.cats[0].coins = 100;
    state.cats[1].coins = 10_000;
    const snapshot = buildMapLensSnapshot(state, "wealth", null);
    expect(snapshot.catColors.size).toBe(state.cats.length);
    expect(snapshot.legend).toHaveLength(3);
    expect([...snapshot.catColors.values()].every((entry) => typeof entry.top === "string")).toBe(true);
    expect(snapshot.metric?.min).toBeLessThan(snapshot.metric?.max ?? 0);
    expect(Math.min(...(snapshot.metric?.normalized.values() ?? []))).toBe(0);
    expect(Math.max(...(snapshot.metric?.normalized.values() ?? []))).toBe(1);
    expect(snapshot.catColors.get(state.cats[0].id)?.top).not.toBe(snapshot.catColors.get(state.cats[1].id)?.top);
  });

  it("uses resource coverage colors for the production environment lens", () => {
    const state = createInitialState({ worldSeed: 12345 });
    const snapshot = buildMapLensSnapshot(state, "environment", "wood");
    const greenCats = [...snapshot.catColors.values()].filter((entry) => entry.id === LENS_COLORS.darkGreen.id);
    expect(greenCats.length).toBeGreaterThan(0);
    expect(snapshot.areas.every((area) => area.kind === "resource" && area.itemId === "wood")).toBe(true);
  });

  it("maps the selected product's rolling output back to producing cats", () => {
    const state = createInitialState({ worldSeed: 12345 });
    const catId = state.cats[0].id;
    state.simTime = 60_000;
    state.recentProductionEvents = [
      { itemId: "wood", catId, at: 5_000 },
      { itemId: "wood", catId, at: 25_000 },
      { itemId: "wood", catId, at: 45_000 },
    ];
    const snapshot = buildMapLensSnapshot(state, "stability", "wood");
    expect(snapshot.catColors.get(catId)?.id).toBe(LENS_COLORS.darkGreen.id);
  });

  it("shows only the selected product's persistent input and destination graph", () => {
    const state = createInitialState({ worldSeed: 12345 });
    const supplier = state.cats[0];
    const producer = state.cats[1];
    const destination = state.cats[2];
    state.productionHistory.byCat[producer.id] = {
      plank: { plannedCount: 6, craftedCount: 4, firstPlannedAt: 1, lastPlannedAt: 9, firstCraftedAt: 2, lastCraftedAt: 10 },
    };
    state.productionHistory.flows = [
      { id: "plank-input", outputItemId: "plank", kind: "input", itemId: "wood", sourceCatId: supplier.id, targetCatId: producer.id, count: 6, firstAt: 1, lastAt: 9 },
      { id: "plank-output", outputItemId: "plank", kind: "output", itemId: "plank", sourceCatId: producer.id, targetCatId: destination.id, count: 4, firstAt: 2, lastAt: 10 },
      { id: "brick-input", outputItemId: "brick", kind: "input", itemId: "stone", sourceCatId: destination.id, targetCatId: producer.id, count: 99, firstAt: 1, lastAt: 10 },
    ];

    const snapshot = buildMapLensSnapshot(state, "stability", "plank");
    expect(snapshot.edges).toHaveLength(2);
    expect(snapshot.edges.map((edge) => ({ kind: edge.kind, itemId: edge.itemId, count: edge.count }))).toEqual([
      { kind: "input", itemId: "wood", count: 6 },
      { kind: "output", itemId: "plank", count: 4 },
    ]);
    expect(snapshot.orderFloors.get(producer.id)?.demandTargets).toContainEqual({ itemId: "wood", targetItemIds: ["plank"] });
    expect(snapshot.orderFloors.get(supplier.id)?.supplyItemIds).toEqual(["wood"]);
    expect(snapshot.orderFloors.get(destination.id)?.demandItemIds).toEqual(["plank"]);
  });

  it("records buyer targets and committed supplier goods on their floors", () => {
    const state = createInitialState({ worldSeed: 12345 });
    const supplier = state.cats[0];
    const buyer = state.cats[1];
    state.procurementPlans.push({
      id: "plan-map-lens",
      catId: buyer.id,
      outputItemId: "plank",
      recipeId: "plank",
      terminalOrderId: null,
      expectedRevenueCents: 1_000,
      createdAt: 0,
      status: "active",
      reason: "bounty",
    });
    state.demandOrders.push({
      id: "order-map-lens",
      buyerKind: "cat",
      buyerCatId: buyer.id,
      destinationCatId: buyer.id,
      itemId: "wood",
      maxDeliveredCents: 300,
      reservedCents: 300,
      planId: "plan-map-lens",
      createdAt: 0,
      status: "open",
      closedAt: null,
      closeReason: null,
      committedSellerCatId: supplier.id,
    });

    const snapshot = buildMapLensSnapshot(state, "orders", null);
    expect(snapshot.orderFloors.get(supplier.id)).toEqual({
      catId: supplier.id,
      demandItemIds: [],
      demandTargets: [],
      supplyItemIds: ["wood"],
      carrier: false,
    });
    expect(snapshot.orderFloors.get(buyer.id)).toEqual({
      catId: buyer.id,
      demandItemIds: ["wood"],
      demandTargets: [{ itemId: "wood", targetItemIds: ["plank"] }],
      supplyItemIds: [],
      carrier: false,
    });
  });

  it("keeps both item sets when one floor is simultaneously demand and supply", () => {
    const state = createInitialState({ worldSeed: 12345 });
    const first = state.cats[0];
    const second = state.cats[1];
    const order = (id: string, itemId: "wood" | "stone", buyerCatId: string, sellerCatId: string) => ({
      id,
      buyerKind: "cat" as const,
      buyerCatId,
      destinationCatId: buyerCatId,
      itemId,
      maxDeliveredCents: 300,
      reservedCents: 300,
      planId: null,
      createdAt: 0,
      status: "open" as const,
      closedAt: null,
      closeReason: null,
      committedSellerCatId: sellerCatId,
    });
    state.demandOrders.push(
      order("order-red-left", "wood", first.id, second.id),
      order("order-green-right", "stone", second.id, first.id),
    );

    const snapshot = buildMapLensSnapshot(state, "orders", null);
    expect(snapshot.orderFloors.get(first.id)).toEqual({
      catId: first.id,
      demandItemIds: ["wood"],
      demandTargets: [],
      supplyItemIds: ["stone"],
      carrier: false,
    });
    expect(snapshot.catColors.get(first.id)?.id).toBe(LENS_COLORS.purple.id);
  });

  it("exposes a coordinate lens with neutral cat floors and both axes", () => {
    const state = createInitialState({ worldSeed: 12345 });
    const snapshot = buildMapLensSnapshot(state, "coordinates", null);
    expect(snapshot.catColors.size).toBe(state.cats.length);
    expect([...snapshot.catColors.values()].every((entry) => entry.id === LENS_COLORS.neutral.id)).toBe(true);
    expect(snapshot.legend.map((entry) => entry.label)).toEqual([
      "X 横轴（y=0）",
      "Y 纵轴（x=0）",
      "猫序号与坐标",
    ]);
  });
});
