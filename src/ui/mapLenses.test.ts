import { describe, expect, it } from "vitest";
import { createInitialState } from "../game/engine";
import { buildMapLensSnapshot, LENS_COLORS, mapLensSelectableItemIds } from "./mapLenses";

describe("Civilization-style map lenses", () => {
  it("offers unlocked and live-market products before their first craft", () => {
    const state = createInitialState({ worldSeed: 12345 });
    state.unlockedRecipes.push("make_computer");
    expect(state.discoveredItems).not.toContain("computer");
    expect(mapLensSelectableItemIds(state)).toContain("computer");
    expect(mapLensSelectableItemIds(state)).not.toContain("server");

    state.procurementPlans.push({
      id: "plan-visible-server",
      catId: state.cats[0].id,
      outputItemId: "server",
      recipeId: "make_server",
      terminalOrderId: null,
      expectedRevenueCents: 1_000,
      createdAt: 0,
      status: "active",
      reason: "order",
    });
    const selectable = mapLensSelectableItemIds(state);
    expect(selectable).toContain("server");
    expect(selectable.indexOf("computer")).toBeLessThan(selectable.indexOf("server"));
  });

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

  it("compares adjustable recent wealth windows around a true zero center", () => {
    const state = createInitialState({ worldSeed: 12345 });
    state.simTime = 60_000;
    const total = buildMapLensSnapshot(state, "wealth", null);
    const firstId = state.cats[0].id;
    const secondId = state.cats[1].id;
    const firstNow = total.metric?.values.get(firstId) ?? 0;
    const secondNow = total.metric?.values.get(secondId) ?? 0;
    state.wealthHistory = [
      { at: 0, values: { [firstId]: firstNow - 1_000, [secondId]: secondNow + 500 } },
      { at: 45_000, values: { [firstId]: firstNow - 200, [secondId]: secondNow + 100 } },
    ];

    const fifteenSeconds = buildMapLensSnapshot(state, "wealth", null, { wealthMode: "change", wealthWindowMs: 15_000 });
    expect(fifteenSeconds.metric).toMatchObject({ mode: "change", windowMs: 15_000, baselineAt: 45_000 });
    expect(fifteenSeconds.metric?.values.get(firstId)).toBe(200);
    expect(fifteenSeconds.metric?.values.get(secondId)).toBe(-100);
    expect(fifteenSeconds.metric?.normalized.get(firstId)).toBe(1);
    expect(fifteenSeconds.metric?.normalized.get(secondId)).toBe(0.25);
    expect(fifteenSeconds.legend[1].label).toContain("持平");

    const oneMinute = buildMapLensSnapshot(state, "wealth", null, { wealthMode: "change", wealthWindowMs: 60_000 });
    expect(oneMinute.metric).toMatchObject({ windowMs: 60_000, baselineAt: 0 });
    expect(oneMinute.metric?.values.get(firstId)).toBe(1_000);
    expect(oneMinute.metric?.values.get(secondId)).toBe(-500);
  });

  it("uses a fixed green-to-red activity scale based on effective actions", () => {
    const state = createInitialState({ worldSeed: 12345 });
    state.simTime = 90_000;
    const [active, cooling, stalled] = state.cats;
    active.action = {
      type: "craft",
      recipeId: "make_wood",
      itemId: "wood",
      startedAt: 89_000,
      endsAt: 94_000,
      reserved: {},
      lawId: "starter-law-foundation-cycle",
    };
    state.commandAudit.push(
      { sequence: 1, atMs: 60_000, origin: "simulation", kind: "action-start", target: cooling.id, ok: true, detail: "pass:wood" },
      { sequence: 2, atMs: 25_000, origin: "simulation", kind: "action-start", target: stalled.id, ok: true, detail: "craft:stone" },
      { sequence: 3, atMs: 89_500, origin: "simulation", kind: "action-start", target: state.cats[3].id, ok: true, detail: "wait" },
    );

    const snapshot = buildMapLensSnapshot(state, "activity", null);
    expect(snapshot.metric?.unit).toBe("milliseconds");
    expect(snapshot.metric?.values.get(active.id)).toBe(0);
    expect(snapshot.metric?.normalized.get(active.id)).toBe(0);
    expect(snapshot.metric?.values.get(cooling.id)).toBe(30_000);
    expect(snapshot.metric?.normalized.get(cooling.id)).toBe(0.5);
    expect(snapshot.metric?.values.get(stalled.id)).toBe(65_000);
    expect(snapshot.metric?.normalized.get(stalled.id)).toBe(1);
    expect(snapshot.catColors.get(active.id)?.top).toBe(snapshot.legend[0].top);
    expect(snapshot.catColors.get(cooling.id)?.top).toBe(snapshot.legend[1].top);
    expect(snapshot.catColors.get(stalled.id)?.top).toBe(snapshot.legend[2].top);
    expect(snapshot.metric?.values.get(state.cats[3].id)).toBe(60_000);
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
