import { describe, expect, it } from "vitest";
import { INTRO_RECIPE_IDS, ITEMS, RECIPE_BY_ID } from "./catalog";
import { advanceGame, cancelBuildingOrder, catStockPurchaseQuote, createInitialState, decideIdleCats, itemPrice, placeOwnedBuilding, queueBuildingOrder } from "./engine";
import { LOCAL_VISION_RADIUS, planLocalLogistics } from "./localPlanner";
import { acceptProfitableOrders, propagateOrderSignals } from "./market";
import type { CatState, GameState, ItemId, LawVersion, Position } from "./types";

function cat(index: number, position: Position): CatState {
  return {
    id: `cat-${index}`,
    createdIndex: index,
    position,
    inventory: {},
    coins: 0,
    debtCents: 0,
    escrowReservedCents: 0,
    action: null,
    lastDecision: "",
    decisionTrace: [],
  };
}

function passiveLaw(options: Partial<LawVersion> & Pick<LawVersion, "id" | "program">): LawVersion {
  const { id, program, ...overrides } = options;
  return {
    id,
    title: id,
    playerText: "",
    summary: "",
    sourceCode: "function decide(ctx) { return null; }",
    astHash: "",
    examples: [],
    warnings: [],
    enactedAt: 0,
    program,
    hitCount: 0,
    invalidCount: 0,
    consecutiveFaults: 0,
    status: "active",
    ...overrides,
  };
}

function finishFoundation(state: GameState): void {
  state.discoveredItems = INTRO_RECIPE_IDS.map((id) => RECIPE_BY_ID.get(id)!.output);
  state.dirtyDecisions = true;
}

function installSharedGreedyBehavior(state: GameState): void {
  state.laws = [structuredClone(createInitialState({ worldSeed: state.worldSeed }).laws
    .find((law) => law.id === "starter-law-local-greedy")!)];
}

describe("0.8.0 spatial market acceptance", () => {
  it("lets asset-greedy cats discover the ten-item free foundation for 100 deterministic seeds", () => {
    for (let worldSeed = 1; worldSeed <= 100; worldSeed += 1) {
      const state = createInitialState({ worldSeed });
      advanceGame(state, 180_000);
      expect(state.discoveredItems, `seed ${worldSeed}`).toHaveLength(10);
      expect(state.discoveredItems, `seed ${worldSeed}`).not.toContain(ITEMS[10].id);
      expect(state.resourceNodes.every((node) => !state.cats.some((cat) => cat.position.x === node.position.x
        && cat.position.y === node.position.y)), `seed ${worldSeed}`).toBe(true);
    }
  }, 60_000);

  it("discovers exactly the first ten free items within 180 seconds for a fixed seed", () => {
    const state = createInitialState({ worldSeed: 123_456 });
    advanceGame(state, 180_000);

    expect(new Set(state.discoveredItems)).toEqual(new Set(INTRO_RECIPE_IDS.map((id) => RECIPE_BY_ID.get(id)!.output)));
    expect(state.discoveredItems).not.toContain(ITEMS[10].id);
  }, 60_000);

  it("lets isolated resource cats craft stock for player collection without cross-component sharing", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 91 });
    state.cats = [cat(0, { x: 0, y: 0 }), cat(1, { x: 4, y: 4 })];
    state.resourceNodes = [
      { id: "ore-node", itemId: "ore", position: { x: -1, y: -1 } },
      { id: "fiber-node", itemId: "fiber", position: { x: 3, y: 3 } },
    ];
    finishFoundation(state);
    installSharedGreedyBehavior(state);

    decideIdleCats(state);
    advanceGame(state, 10_000);
    expect(state.itemStats.ore.crafted).toBeGreaterThan(0);
    expect(state.itemStats.fiber.crafted).toBeGreaterThan(0);
    expect(state.itemStats.ore.sold + state.itemStats.fiber.sold).toBe(0);
    expect(state.itemStats.ore.passed + state.itemStats.fiber.passed).toBe(0);
  });

  it("changes player acquisition quotes for a price law but never starts a cat sale", () => {
    const baseline = createInitialState({ withStarter: false, worldSeed: 222 });
    finishFoundation(baseline);
    baseline.resourceNodes = [];
    baseline.cats[0].inventory.brick = 1;
    baseline.cats[0].inventory.gear = 1;
    baseline.laws = [];
    decideIdleCats(baseline);
    expect(baseline.cats[0].action?.type).toBe("wait");
    const baselineQuote = catStockPurchaseQuote(baseline, baseline.cats[0].id);

    const taxed = structuredClone(baseline);
    taxed.cats.forEach((entry) => {
      if (entry.action) entry.inventory[entry.action.itemId] = (entry.inventory[entry.action.itemId] ?? 0) + 1;
      entry.action = null;
    });
    taxed.laws = [passiveLaw({ id: "tax", sourceCode: "function decide(ctx) { setTax(0.99); return null; }", program: { version: 2 } })];
    taxed.dirtyDecisions = true;
    decideIdleCats(taxed);
    expect(taxed.cats[0].action?.type).toBe("wait");
    expect(catStockPurchaseQuote(taxed, taxed.cats[0].id).totalCostCents).toBe(baselineQuote.totalCostCents);

    const priced = structuredClone(baseline);
    priced.cats.forEach((entry) => {
      if (entry.action) entry.inventory[entry.action.itemId] = (entry.inventory[entry.action.itemId] ?? 0) + 1;
      entry.action = null;
    });
    priced.laws = [passiveLaw({ id: "brick-price", sourceCode: "function decide(ctx) { setPrice('brick', 10); return null; }", program: { version: 2 } })];
    priced.dirtyDecisions = true;
    decideIdleCats(priced);
    expect(priced.cats[0].action?.type).toBe("wait");
    expect(catStockPurchaseQuote(priced, priced.cats[0].id).totalCostCents).toBeGreaterThan(baselineQuote.totalCostCents);
  });

  it("finishes an already-contracted legacy building delivery into the player inventory", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 17 });
    state.cats = [cat(0, { x: 0, y: 0 }), cat(1, { x: 1, y: 0 }), cat(2, { x: 2, y: 0 })];
    state.nextCatIndex = 3;
    state.cats[0].inventory.factory = 1;
    state.treasuryCoins = 1_000_000;
    state.unlockedRecipes = [...RECIPE_BY_ID.keys()];
    state.resourceNodes = [];
    installSharedGreedyBehavior(state);
    // An already-produced building on the connected chain must be transported rather than recreated or teleported.
    const order = queueBuildingOrder(state, "cat-2", "factory");
    expect(order.ok).toBe(true);
    propagateOrderSignals(state);
    propagateOrderSignals(state);
    acceptProfitableOrders(state, (itemId) => itemPrice(state, itemId));
    decideIdleCats(state);
    expect(state.cats[0].action).toMatchObject({ type: "pass", itemId: "factory", direction: "east" });
    advanceGame(state, 5_000);
    expect(state.cats[1].action).toMatchObject({ type: "pass", itemId: "factory", direction: "east" });

    expect(cancelBuildingOrder(state, order.order!.id)).toMatchObject({ ok: false, error: expect.stringContaining("不可撤销") });
    advanceGame(state, 5_000);
    expect(state.buildings).toHaveLength(0);
    expect(state.playerBuildingInventory.factory).toBe(1);
    expect(placeOwnedBuilding(state, "factory", { x: 3, y: 0 })).toMatchObject({ ok: true });
    expect(state.buildings[0]).toMatchObject({ itemId: "factory", position: { x: 3, y: 0 } });
  });

  it("plans 1000 cats with no workstation seeing beyond Manhattan radius two", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 7 });
    state.cats = [];
    state.resourceNodes = [];
    for (let y = 0; y < 25; y += 1) {
      for (let x = 0; x < 40; x += 1) {
        const index = y * 40 + x;
        const entry = cat(index, { x, y });
        if (index % 23 === 0) entry.inventory.wood = 1;
        state.cats.push(entry);
      }
    }
    state.nextCatIndex = state.cats.length;
    state.resourceNodes = [{ id: "wood", itemId: "wood", position: { x: -1, y: -1 } }];
    finishFoundation(state);

    const startedAt = performance.now();
    const result = planLocalLogistics(state, (itemId: ItemId) => itemPrice(state, itemId));
    const elapsed = performance.now() - startedAt;

    expect(result.status).toHaveLength(1_000);
    expect(result.status.every((entry) => entry.catIds.length <= 13)).toBe(true);
    expect(result.status.every((entry) => entry.catIds.every((id) => {
      const origin = state.cats.find((cat) => `local-${cat.id}` === entry.componentId)!;
      const visible = state.cats.find((cat) => cat.id === id)!;
      return Math.abs(origin.position.x - visible.position.x) + Math.abs(origin.position.y - visible.position.y) <= LOCAL_VISION_RADIUS;
    }))).toBe(true);
    expect(result.assignments.size).toBeLessThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(1_000);
  });
});
