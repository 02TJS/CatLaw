import { describe, expect, it } from "vitest";
import {
  INDUSTRIAL_GATE_RECIPE_IDS,
  INTRO_RECIPE_IDS,
  ITEMS,
  MARKET_CERTIFICATION_ITEM_IDS,
  MARKET_CHALLENGE_RECIPE_IDS,
  canUnlockRecipe,
  missingProductionCertifications,
  recipeUnlockCost,
} from "./catalog";
import { advanceGame, buyAllCatStockAndSell, createInitialState, enactLaw, itemPrice, unlockRecipe } from "./engine";
import { hashSource } from "./lawInterpreter";
import type { GameState, ItemId, LawDraft } from "./types";
import { publishBountySignal, refreshCatMarket } from "./market";

const MARKET_CHALLENGE_TOTAL_COST = MARKET_CHALLENGE_RECIPE_IDS
  .reduce((sum, recipeId) => sum + recipeUnlockCost(recipeId), 0);

function priceDraft(itemId: ItemId, multiplier: number): LawDraft {
  const sourceCode = `function decide(ctx) { setPrice(${JSON.stringify(itemId)}, ${multiplier}); return null; }`;
  return {
    title: `${itemId} 测试价格法`,
    playerText: "test",
    summary: "test",
    sourceCode,
    astHash: hashSource(sourceCode),
    examples: [],
    warnings: [],
    program: { version: 2 },
    validation: { syntax: true, safety: true, examplesPassed: 0, examplesTotal: 0, messages: [] },
  };
}

function finishFoundation(state: GameState): void {
  const discovered = new Set(ITEMS.slice(0, 15).map((item) => item.id));
  state.discoveredItems = [...discovered];
  for (const bounty of state.discoveryBounties) {
    if (discovered.has(bounty.itemId)) bounty.paid = true;
  }
  state.marketBroadcasts = state.marketBroadcasts.filter((broadcast) => (
    !discovered.has(broadcast.itemId) || broadcast.kind !== "bounty-open"
  ));
  state.dirtyDecisions = true;
}

function buyMarketRecipes(state: GameState): number {
  const before = state.treasuryCoins;
  for (const recipeId of MARKET_CHALLENGE_RECIPE_IDS) {
    expect(unlockRecipe(state, recipeId)).toEqual({ ok: true, cost: recipeUnlockCost(recipeId) });
  }
  return before - state.treasuryCoins;
}

describe("market certification challenge", () => {
  it("prices recipes 11–15 deterministically in cents and keeps them inside the 150-coin treasury", () => {
    const costs = MARKET_CHALLENGE_RECIPE_IDS.map(recipeUnlockCost);
    expect(costs).toEqual([2800, 3600, 1600, 2000, 4800]);
    expect(costs.reduce((sum, cost) => sum + cost, 0)).toBe(14_800);
    expect(MARKET_CHALLENGE_TOTAL_COST).toBeLessThanOrEqual(createInitialState().treasuryCoins);
  });

  it("requires the exact treasury balance and never charges a failed or duplicate purchase", () => {
    const state = createInitialState({ withStarter: false });
    const cost = recipeUnlockCost("make_paper");
    state.treasuryCoins = cost - 1;

    expect(unlockRecipe(state, "make_paper")).toEqual({ ok: false, error: `国库需要 ${(cost / 100).toFixed(2)} 🪙` });
    expect(state.treasuryCoins).toBe(cost - 1);
    expect(state.unlockedRecipes).not.toContain("make_paper");

    state.treasuryCoins = cost;
    expect(unlockRecipe(state, "make_paper")).toEqual({ ok: true, cost });
    expect(state.treasuryCoins).toBe(0);
    expect(unlockRecipe(state, "make_paper")).toEqual({ ok: false, error: "配方已经解锁" });
    expect(state.treasuryCoins).toBe(0);
  });

  it("keeps gear locked until the metal recipe is purchased", () => {
    const state = createInitialState({ withStarter: false });
    state.treasuryCoins = 1_000;
    expect(unlockRecipe(state, "make_gear")).toEqual({ ok: false, error: "请先解锁 make_metal" });
    expect(state.treasuryCoins).toBe(1_000);
  });

  it("does not treat inventory, discovery, passing, or selling as production certification", () => {
    const state = createInitialState({ withStarter: false });
    state.treasuryCoins = MARKET_CHALLENGE_TOTAL_COST;
    buyMarketRecipes(state);
    for (const itemId of MARKET_CERTIFICATION_ITEM_IDS) {
      state.discoveredItems.push(itemId);
      state.cats[0].inventory[itemId] = 3;
      state.itemStats[itemId].passed = 2;
      state.itemStats[itemId].sold = 1;
    }

    const before = state.treasuryCoins;
    expect(unlockRecipe(state, "make_cable")).toMatchObject({ ok: false, error: expect.stringContaining("产业认证未完成") });
    expect(state.treasuryCoins).toBe(before);
    expect(missingProductionCertifications("make_cable", [])).toEqual(MARKET_CERTIFICATION_ITEM_IDS);
  });

  it("blocks every recipe from 16–20 when even one certification is missing", () => {
    const state = createInitialState({ withStarter: false });
    state.treasuryCoins = 100_000;
    buyMarketRecipes(state);
    const crafted = MARKET_CERTIFICATION_ITEM_IDS.filter((itemId) => itemId !== "paper");
    for (const itemId of crafted) state.itemStats[itemId].crafted = 1;

    for (const recipeId of INDUSTRIAL_GATE_RECIPE_IDS) {
      expect(canUnlockRecipe(recipeId, state.unlockedRecipes, crafted)).toBe(false);
      expect(unlockRecipe(state, recipeId)).toMatchObject({ ok: false, error: expect.stringContaining("纸") });
    }
    expect(INDUSTRIAL_GATE_RECIPE_IDS.every((recipeId) => !state.unlockedRecipes.includes(recipeId))).toBe(true);
  });

  it("opens and purchases all recipes 16–20 immediately after certification reaches 5/5", () => {
    const state = createInitialState({ withStarter: false });
    state.treasuryCoins = 100_000;
    const challengeSpend = buyMarketRecipes(state);
    for (const itemId of MARKET_CERTIFICATION_ITEM_IDS) state.itemStats[itemId].crafted = 1;
    const crafted = [...MARKET_CERTIFICATION_ITEM_IDS];
    expect(INDUSTRIAL_GATE_RECIPE_IDS.every((recipeId) => canUnlockRecipe(recipeId, state.unlockedRecipes, crafted))).toBe(true);

    const gateSpend = INDUSTRIAL_GATE_RECIPE_IDS.reduce((sum, recipeId) => sum + recipeUnlockCost(recipeId), 0);
    for (const recipeId of INDUSTRIAL_GATE_RECIPE_IDS) expect(unlockRecipe(state, recipeId).ok).toBe(true);
    expect(state.unlockedRecipes.slice(0, 20)).toEqual([...INTRO_RECIPE_IDS, ...MARKET_CHALLENGE_RECIPE_IDS, ...INDUSTRIAL_GATE_RECIPE_IDS]);
    expect(state.treasuryCoins).toBe(100_000 - challengeSpend - gateSpend);
  });

  it("limits the five-item certification gate to recipes 16–20", () => {
    const hypotheticalKnown = [...INTRO_RECIPE_IDS, ...MARKET_CHALLENGE_RECIPE_IDS, "make_cable", "make_battery"];
    expect(missingProductionCertifications("make_lamp", [])).toEqual([]);
    expect(canUnlockRecipe("make_lamp", hypotheticalKnown, [])).toBe(true);
  });

  it("can fund all five purchases naturally without unlocking item 11 by itself", () => {
    const state = createInitialState();
    advanceGame(state, 900_000);
    expect(state.treasuryCoins).toBeGreaterThanOrEqual(MARKET_CHALLENGE_TOTAL_COST);
    expect(state.unlockedRecipes).toEqual(INTRO_RECIPE_IDS);
    expect(MARKET_CERTIFICATION_ITEM_IDS.every((itemId) => state.itemStats[itemId].crafted === 0)).toBe(true);
    expect(MARKET_CERTIFICATION_ITEM_IDS.every((itemId) => !state.discoveredItems.includes(itemId))).toBe(true);
  }, 20_000);

  it("continues the shared two-tile teaching logic until all five paid goods are certified", () => {
    const state = createInitialState();
    state.treasuryCoins = MARKET_CHALLENGE_TOTAL_COST;
    buyMarketRecipes(state);
    advanceGame(state, 300_000);
    expect(MARKET_CERTIFICATION_ITEM_IDS.filter((itemId) => state.itemStats[itemId].crafted > 0)).toEqual(MARKET_CERTIFICATION_ITEM_IDS);
  });

  it("allows a strong paper price law to earn its missing certification", () => {
    const state = createInitialState({ worldSeed: 123 });
    finishFoundation(state);
    state.treasuryCoins = MARKET_CHALLENGE_TOTAL_COST;
    buyMarketRecipes(state);
    expect(enactLaw(state, priceDraft("paper", 10)).ok).toBe(true);
    // finishFoundation intentionally preserves already-funded work.  Give
    // those commitments time to drain before judging the new price regime.
    advanceGame(state, 300_000);
    expect(state.itemStats.paper.crafted).toBeGreaterThan(0);
  });

  it("lets paid hop-by-hop orders bridge separated water and wood regions", () => {
    const state = createInitialState({ worldSeed: 123 });
    finishFoundation(state);
    state.treasuryCoins = MARKET_CHALLENGE_TOTAL_COST;
    buyMarketRecipes(state);
    expect(enactLaw(state, priceDraft("paper", 10)).ok).toBe(true);
    advanceGame(state, 300_000);
    expect(state.itemStats.paper.crafted).toBeGreaterThan(0);
  });

  it.each(["tools", "glass"] as const)("uses market contracts to assemble spatially separated %s inputs", (itemId) => {
    const state = createInitialState({ worldSeed: 123 });
    finishFoundation(state);
    state.treasuryCoins = MARKET_CHALLENGE_TOTAL_COST;
    buyMarketRecipes(state);
    expect(enactLaw(state, priceDraft(itemId, 10)).ok).toBe(true);
    advanceGame(state, 300_000);
    expect(state.itemStats[itemId].crafted).toBeGreaterThan(0);
  });

  it("keeps a certification permanently after the certified product is sold", () => {
    const state = createInitialState({ worldSeed: 123 });
    finishFoundation(state);
    state.treasuryCoins = MARKET_CHALLENGE_TOTAL_COST;
    buyMarketRecipes(state);
    expect(enactLaw(state, priceDraft("thread", 10)).ok).toBe(true);
    advanceGame(state, 180_000);
    expect(state.itemStats.thread.crafted).toBeGreaterThanOrEqual(1);
    state.treasuryCoins = 1_000_000_000;
    expect(buyAllCatStockAndSell(state).ok).toBe(true);
    expect(state.itemStats.thread.sold).toBeGreaterThanOrEqual(1);
    expect(missingProductionCertifications("make_cable", ["thread"])).not.toContain("thread");
  });

  it("does not let a direct x2 signal replace reliable supplier quotes or create partial orders", () => {
    const state = createInitialState({ withStarter: false, difficulty: 5, worldSeed: 91 });
    const wheelRecipeId = "make_wheel";
    state.unlockedRecipes.push(wheelRecipeId);
    state.discoveryBounties.forEach((bounty) => {
      bounty.paid = bounty.itemId !== "wheel";
      bounty.claimedByCatId = null;
    });
    publishBountySignal(state, "wheel", "open", state.cats[0].id);
    expect(enactLaw(state, priceDraft("wheel", 2)).ok).toBe(true);
    advanceGame(state, 5_000);
    const priceOf = (itemId: string) => itemPrice(state, itemId);
    refreshCatMarket(state, state.cats[0], priceOf);
    expect(state.procurementPlans.some((plan) => plan.outputItemId === "wheel")).toBe(false);
    expect(state.demandOrders).toHaveLength(0);

    // Money alone cannot make a firm quote appear when there is no supplier or
    // transport route for either direct ingredient.
    state.cats[0].coins = 1_000_000_000;
    refreshCatMarket(state, state.cats[0], priceOf);
    expect(state.procurementPlans.some((plan) => plan.outputItemId === "wheel")).toBe(false);
    expect(state.demandOrders).toHaveLength(0);
  });
});
