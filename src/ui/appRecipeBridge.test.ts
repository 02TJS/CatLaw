import { describe, expect, it } from "vitest";
import { createInitialState } from "../game/engine";
import { buildRecipeInterfaceState } from "./appRecipeBridge";

describe("recipe bridge state", () => {
  it("preserves unlocked order, crafted catalog order, treasury, and difficulty", () => {
    const state = createInitialState({ worldSeed: 401, difficulty: 4 });
    state.unlockedRecipes = ["make_wood", "make_stone", "make_metal"];
    state.itemStats.wood.crafted = 2;
    state.itemStats.metal.crafted = 1;
    state.treasuryCoins = 12_345;

    const bridgeState = buildRecipeInterfaceState(state);

    expect(bridgeState).toEqual({
      unlockedRecipes: ["make_wood", "make_stone", "make_metal"],
      craftedItems: ["wood", "metal"],
      treasuryCoins: 12_345,
      difficulty: 4,
    });
    expect(bridgeState.unlockedRecipes).not.toBe(state.unlockedRecipes);
  });
});
