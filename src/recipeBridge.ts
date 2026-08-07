import type { DifficultyLevel } from "./game/types";

export const RECIPE_BRIDGE_CHANNEL_NAME = "cat-workshop-interface-v1";

export interface RecipeInterfaceState {
  unlockedRecipes: string[];
  craftedItems: string[];
  treasuryCoins: number;
  difficulty: DifficultyLevel;
}

export type RecipeBridgeMessage =
  | { type: "recipe-state"; state: RecipeInterfaceState }
  | { type: "recipe-state-request" }
  | { type: "recipe-unlock"; recipeId: string }
  | { type: "recipe-unlock-result"; recipeId: string; ok: boolean; error?: string; cost?: number };
