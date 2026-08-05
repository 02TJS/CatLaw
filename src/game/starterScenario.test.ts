import { describe, expect, it } from "vitest";
import { MARKET_CHALLENGE_RECIPE_IDS, RECIPES } from "./catalog";
import { advanceGame, createInitialState, unlockRecipe } from "./engine";
import type { GameState } from "./types";

const TEST_SPEED = 5_000;
const WINDOW_LOGICAL_MS = 300_000;

function advanceLogical(state: GameState, logicalMs: number): void {
  advanceGame(state, logicalMs / state.simulationSpeed);
}

function observeStableProduction(state: GameState, through: number): number[][] {
  const snapshots: number[][] = [RECIPES.map((recipe) => state.itemStats[recipe.output].crafted)];
  for (let window = 0; window < 3; window += 1) {
    advanceLogical(state, WINDOW_LOGICAL_MS);
    snapshots.push(RECIPES.map((recipe) => state.itemStats[recipe.output].crafted));
  }
  const windows = snapshots.slice(1).map((snapshot, window) => (
    snapshot.map((value, item) => value - snapshots[window][item])
  ));
  for (let item = 0; item < through; item += 1) {
    const production = windows.map((window) => window[item]);
    expect(production.reduce((sum, value) => sum + value, 0), RECIPES[item].output).toBeGreaterThanOrEqual(3);
    expect(production.filter((value) => value > 0).length, RECIPES[item].output).toBeGreaterThanOrEqual(2);
  }
  const totals = windows.map((window) => window.slice(0, through).reduce((sum, value) => sum + value, 0));
  expect(totals.at(-1)).toBeGreaterThan(0);
  expect(totals[1] < totals[0] * 0.5 && totals[2] < totals[1] * 0.5).toBe(false);
  return windows;
}

describe("seven-law starter economy", () => {
  it("stably produces 1-10 untouched and 1-15 after only buying five blueprints", { timeout: 30_000 }, () => {
    for (const worldSeed of [1, 7, 91]) {
      const state = createInitialState({ worldSeed, difficulty: 5, simulationSpeed: TEST_SPEED });
      expect(state.laws).toHaveLength(7);
      expect(state.laws.some((law) => law.sourceCode.includes("setPrice("))).toBe(false);

      advanceLogical(state, 300_000);
      const firstWindows = observeStableProduction(state, 10);
      expect(firstWindows.every((window) => window[10] === 0), `seed ${worldSeed} item 11`).toBe(true);

      for (const recipeId of MARKET_CHALLENGE_RECIPE_IDS) {
        expect(unlockRecipe(state, recipeId), `seed ${worldSeed} ${recipeId}`).toMatchObject({ ok: true });
      }
      advanceLogical(state, 300_000);
      const paidWindows = observeStableProduction(state, 15);
      expect(paidWindows.every((window) => window[15] === 0), `seed ${worldSeed} item 16`).toBe(true);
    }
  });
});
