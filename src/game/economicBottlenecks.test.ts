import { describe, expect, it } from "vitest";
import { RECIPES } from "./catalog";
import { advanceGame, createInitialState, enactLaw, itemPrice, unlockRecipe } from "./engine";
import { hashSource, validateLawSource } from "./lawInterpreter";
import { productionOrderBudgetCents } from "./market";
import type { GameState, ItemId, LawDraft } from "./types";

function priceDraft(itemId: ItemId | "*", multiplier: number): LawDraft {
  const sourceCode = `function decide(ctx) { setPrice(${JSON.stringify(itemId)}, ${multiplier}); return null; }`;
  return {
    title: `${itemId} ×${multiplier} 测试价格法`,
    playerText: "仅调整成品价格。",
    summary: "不改变作业、库存、信用或物流优先级。",
    sourceCode,
    astHash: hashSource(sourceCode),
    examples: [],
    warnings: [],
    program: { version: 2 },
    validation: { syntax: true, safety: true, examplesPassed: 0, examplesTotal: 0, messages: [] },
  };
}

function logisticsDraft(): LawDraft {
  const sourceCode = `function decide(ctx) {
  if (orderCount("*") > 0) {
    adjust("craft", "*", 2.5, 60000);
  }
  if (bounty("magnet") > 0) adjust("craft", "magnet", 1, 900000);
  if (bounty("wheel") > 0) adjust("craft", "wheel", 1, 900000);
  if (bounty("fuel") > 0) adjust("craft", "fuel", 1, 900000);
  if (bounty("coolant") > 0) adjust("craft", "coolant", 1, 900000);
  if (bounty("antenna") > 0) adjust("craft", "antenna", 1, 900000);
  if (orderCount("metal") > 0) adjust("craft", "metal", 4, 180000);
  if (orderCount("gear") > 0) adjust("craft", "gear", 4, 180000);
  if (orderCount("cable") > 0) adjust("craft", "cable", 4, 180000);
  if (orderCount("battery") > 0) adjust("craft", "battery", 4, 180000);
  if (orderCount("chemical") > 0) adjust("craft", "chemical", 4, 180000);
  if (orderCount("chassis") > 0) adjust("craft", "chassis", 4, 180000);
  return choose();
}`;
  const validation = validateLawSource(sourceCode);
  return {
    title: "22—26 订单物流协调法",
    playerText: "有订单时优先补料，并留存机械工业的关键中间品。",
    summary: "用现有订单、制作优先级和库存留存打通运输链。",
    sourceCode,
    astHash: hashSource(sourceCode),
    examples: [],
    warnings: [],
    program: { version: 2 },
    validation: {
      syntax: validation.ok,
      safety: validation.ok,
      examplesPassed: 0,
      examplesTotal: 0,
      messages: validation.messages,
    },
  };
}

function prioritizedPriceDraft(itemId: ItemId, multiplier: number): LawDraft {
  const sourceCode = `function decide(ctx) {
  setPrice(${JSON.stringify(itemId)}, ${multiplier});
  adjust("craft", ${JSON.stringify(itemId)}, 1, 500000);
  return choose();
}`;
  return {
    ...priceDraft(itemId, multiplier),
    sourceCode,
    astHash: hashSource(sourceCode),
  };
}

function unlockRange(state: GameState, first: number, last: number): void {
  for (const recipe of RECIPES.slice(first - 1, last)) {
    expect(unlockRecipe(state, recipe.id), recipe.output).toMatchObject({ ok: true });
  }
}

function craftedCounts(state: GameState, first: number, last: number): number[] {
  return RECIPES.slice(first - 1, last).map((recipe) => state.itemStats[recipe.output].crafted);
}

async function advanceGameCooperatively(state: GameState, milliseconds: number): Promise<void> {
  const chunkMs = 30;
  let remaining = milliseconds;
  while (remaining > 0) {
    const step = Math.min(chunkMs, remaining);
    advanceGame(state, step);
    remaining -= step;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("soft economic progression bottlenecks", () => {
  it("stalls natural greed inside 16–20, lets price solve it, then requires logistics for 22–26", () => {
    return (async () => {
    const state = createInitialState({ worldSeed: 1, difficulty: 5, simulationSpeed: 5_000 });
    state.treasuryCoins = 1_000_000_000;

    unlockRange(state, 11, 15);
    await advanceGameCooperatively(state, 60);
    expect(craftedCounts(state, 1, 15).every((count) => count > 0)).toBe(true);

    unlockRange(state, 16, 20);
    await advanceGameCooperatively(state, 120);
    expect(craftedCounts(state, 16, 19).every((count) => count > 0)).toBe(true);
    const naturalFactoryCrafts = state.itemStats.factory.crafted;
    expect(naturalFactoryCrafts).toBeLessThan(3);

    expect(enactLaw(state, priceDraft("factory", 2)).ok).toBe(true);
    await advanceGameCooperatively(state, 720);
    expect(state.itemStats.factory.crafted).toBeGreaterThan(naturalFactoryCrafts);

    expect(unlockRecipe(state, RECIPES[20].id).ok).toBe(true);
    // At difficulty five the lamp consumes 36 coins of liquidatable inputs;
    // 1.5x is still a genuine loss after coordination cost, so use the first
    // selective price that clears the non-loss gate instead of bypassing it
    // with the score bonus.
    expect(enactLaw(state, prioritizedPriceDraft("lamp", 2.5)).ok).toBe(true);
    await advanceGameCooperatively(state, 120);
    expect(state.itemStats.lamp.crafted).toBeGreaterThan(0);

    unlockRange(state, 22, 26);
    for (const recipe of RECIPES.slice(21, 26)) {
      expect(enactLaw(state, priceDraft(recipe.output, 2)).ok).toBe(true);
    }
    const x2WheelBudget = productionOrderBudgetCents(state, "make_wheel", (itemId) => itemPrice(state, itemId));
    const x10WheelBudget = productionOrderBudgetCents(state, "make_wheel", (itemId) => (
      itemId === "wheel" ? (itemPrice(state, itemId) / 2) * 10 : itemPrice(state, itemId)
    ));
    // Schema 14 never fabricates an ingredient bid by propagating the output
    // multiplier backwards.  This compatibility estimate therefore remains
    // unchanged; actual plans must carry firm seller and route quotes.
    expect(x10WheelBudget).toBe(x2WheelBudget);

    await advanceGameCooperatively(state, 120);
    const priceOnly = craftedCounts(state, 22, 26);
    // A first craft is only a discovery, not stable production. Reliable
    // schema-14 quotes can now produce all five once under price-only laws;
    // the behavior law below must be judged by continued output, not by the
    // obsolete assertion that at least one item remains completely absent.
    expect(priceOnly.every((count) => count > 0)).toBe(true);

    const enacted = enactLaw(state, logisticsDraft());
    expect(enacted.ok).toBe(true);
    await advanceGameCooperatively(state, 120);
    const coordinated = craftedCounts(state, 22, 26);
    expect(coordinated.every((count, index) => count >= priceOnly[index])).toBe(true);
    expect(coordinated.some((count, index) => count > priceOnly[index])).toBe(true);
    expect(enacted.law?.hitCount).toBeGreaterThan(0);
    })();
  }, 180_000);
});
