import { RECIPE_BY_ID } from "./catalog";
import { effectiveRecipeInputs } from "./difficulty";
import { externalNetCents, MIN_PLAN_PROFIT_CENTS } from "./marketEconomics";
import type { GameState, ItemId } from "./types";

export function estimatedInputCost(state: GameState, recipeId: string, priceOf: (itemId: ItemId) => number): number {
  const recipe = RECIPE_BY_ID.get(recipeId);
  if (!recipe) return Number.POSITIVE_INFINITY;
  return effectiveRecipeInputs(recipe, state.difficulty).reduce((sum, input) => (
    sum + input.quantity * externalNetCents(state, input.itemId, priceOf)
  ), 0);
}

/**
 * Read-only compatibility estimate for inspectors and older callers. Real
 * plans never fund orders from this estimate: they atomically lock a named
 * supplier, route, freight schedule and whole-basket financing certificate.
 */
export function productionOrderBidCents(
  state: GameState,
  _recipeId: string,
  inputItemId: ItemId,
  priceOf: (itemId: ItemId) => number,
): number {
  // Compatibility estimate for inspectors. Plans use a firm seller/route
  // quote and never commit money from this estimate.
  return externalNetCents(state, inputItemId, priceOf) + MIN_PLAN_PROFIT_CENTS;
}

export function productionOrderBudgetCents(
  state: GameState,
  recipeId: string,
  priceOf: (itemId: ItemId) => number,
): number {
  const recipe = RECIPE_BY_ID.get(recipeId);
  if (!recipe) return 0;
  return effectiveRecipeInputs(recipe, state.difficulty).reduce((sum, input) => (
    sum + input.quantity * productionOrderBidCents(state, recipe.id, input.itemId, priceOf)
  ), 0);
}

export function hasPriceSensitiveJobDemand(state: GameState, recipeId: string): boolean {
  const recipe = RECIPE_BY_ID.get(recipeId);
  return Boolean(recipe && state.unlockedRecipes.includes(recipe.id));
}
