import { ITEM_BY_ID } from "./catalog";
import { difficultySiteRequirements } from "./difficulty";
import type { CatState, GameState, ItemId, Position, RecipeDefinition } from "./types";
import { resourceNodesAtPosition } from "./world";

export function resourceItemAt(state: GameState, position: Position): ItemId | undefined {
  return resourceItemsAt(state, position)[0];
}

export function resourceItemsAt(state: GameState, position: Position): ItemId[] {
  return resourceNodesAtPosition(state.resourceNodes, position).map((node) => node.itemId);
}

export function siteFailure(state: GameState, cat: CatState, recipe: RecipeDefinition): string | null {
  if (recipe.inputs.length === 0) {
    return resourceItemsAt(state, cat.position).includes(recipe.output)
      ? null
      : `这里不在 ${ITEM_BY_ID.get(recipe.output)?.name ?? recipe.output}采集区`;
  }
  for (const requirement of difficultySiteRequirements(recipe, state.difficulty)) {
    const nearby = state.buildings.some((building) => building.itemId === requirement.buildingItemId
      && manhattan(building.position, cat.position) <= requirement.maxManhattanDistance);
    if (!nearby) {
      return `需要位于${ITEM_BY_ID.get(requirement.buildingItemId)?.name ?? requirement.buildingItemId}${requirement.maxManhattanDistance}格内`;
    }
  }
  return null;
}

function manhattan(left: Position, right: Position): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}
