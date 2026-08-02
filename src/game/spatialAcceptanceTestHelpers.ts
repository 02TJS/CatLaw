import { expect } from "vitest";
import { ITEMS, MARKET_CHALLENGE_RECIPE_IDS, RECIPE_BY_ID, TUTORIAL_RECIPE_IDS } from "./catalog";
import { advanceGame, buyAllCatStockAndSell, createInitialState, unlockRecipe } from "./engine";

export function verifyTeachingGoalRange(firstSeed: number, lastSeed: number): void {
  const expected = TUTORIAL_RECIPE_IDS.map((id) => RECIPE_BY_ID.get(id)!.output);
  for (let worldSeed = firstSeed; worldSeed <= lastSeed; worldSeed += 1) {
    const state = createInitialState({ worldSeed });
    state.treasuryCoins = 1_000_000;
    for (const recipeId of MARKET_CHALLENGE_RECIPE_IDS) expect(unlockRecipe(state, recipeId).ok).toBe(true);
    for (let cycle = 0; cycle < 5; cycle += 1) {
      advanceGame(state, 60_000);
      buyAllCatStockAndSell(state);
    }
    expect(new Set(state.discoveredItems), `seed ${worldSeed}`).toEqual(new Set(expected));
    expect(state.discoveredItems, `seed ${worldSeed}`).not.toContain(ITEMS[15].id);
  }
}
