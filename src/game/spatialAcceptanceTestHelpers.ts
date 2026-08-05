import { expect } from "vitest";
import { FOUNDATION_RECIPE_IDS, ITEMS, MARKET_CHALLENGE_RECIPE_IDS, RECIPE_BY_ID } from "./catalog";
import { advanceGame, createInitialState, unlockRecipe } from "./engine";

export function verifyGreedyFoundationRange(firstSeed: number, lastSeed: number): void {
  const expected = FOUNDATION_RECIPE_IDS.map((id) => RECIPE_BY_ID.get(id)!.output);
  for (let worldSeed = firstSeed; worldSeed <= lastSeed; worldSeed += 1) {
    const state = createInitialState({ worldSeed, simulationSpeed: 5_000 });
    state.treasuryCoins = 1_000_000;
    for (const recipeId of MARKET_CHALLENGE_RECIPE_IDS) expect(unlockRecipe(state, recipeId).ok).toBe(true);
    advanceGame(state, 600_000 / state.simulationSpeed);
    expect(new Set(state.discoveredItems), `seed ${worldSeed}`).toEqual(new Set(expected));
    expect(state.discoveredItems, `seed ${worldSeed}`).not.toContain(ITEMS[15].id);
  }
}
