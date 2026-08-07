import { DEPLOYABLE_BUILDING_IDS } from "../game/catalog";
import {
  buildingPlacementFailure,
  PLAYER_RESOURCE_CREATION_COST,
  resourcePlacementFailure,
} from "../game/engine";
import type { GameState, Position } from "../game/types";
import { BASE_RESOURCE_ITEM_IDS, isPositionUnlocked } from "../game/world";

export interface ContextPlacementOption {
  itemId: string;
  quantity: number;
  failure: string | null;
}

export interface CanvasPlacementMode {
  placingBuildingItemId: string | null;
  placingLandmarkId: string | null;
  expansionMode: boolean;
}

export function canOfferAddCatAt(
  state: GameState,
  tile: Position,
  mode: CanvasPlacementMode,
): boolean {
  return !mode.placingBuildingItemId
    && !mode.placingLandmarkId
    && !mode.expansionMode
    && isPositionUnlocked(state.unlockedParcels, tile)
    && !state.resourceNodes.some((node) => node.position.x === tile.x && node.position.y === tile.y)
    && !state.buildings.some((building) => building.position.x === tile.x && building.position.y === tile.y)
    && !state.landmarks.some((landmark) => landmark.position.x === tile.x && landmark.position.y === tile.y)
    && !state.cats.some((cat) => cat.position.x === tile.x && cat.position.y === tile.y);
}

export function ownedBuildingOptionsAt(state: GameState, tile: Position): ContextPlacementOption[] {
  return DEPLOYABLE_BUILDING_IDS
    .filter((itemId) => (state.playerBuildingInventory[itemId] ?? 0) > 0)
    .map((itemId) => ({
      itemId,
      quantity: state.playerBuildingInventory[itemId] ?? 0,
      failure: buildingPlacementFailure(state, itemId, tile),
    }));
}

export function resourceCreationOptionsAt(state: GameState, tile: Position): ContextPlacementOption[] {
  return BASE_RESOURCE_ITEM_IDS
    .filter((itemId) => (state.playerBuildingInventory[itemId] ?? 0) >= PLAYER_RESOURCE_CREATION_COST)
    .map((itemId) => ({
      itemId,
      quantity: state.playerBuildingInventory[itemId] ?? 0,
      failure: resourcePlacementFailure(state, itemId, tile),
    }));
}

export function canCreateResourceAt(state: GameState, tile: Position): boolean {
  return BASE_RESOURCE_ITEM_IDS.some((itemId) => (
    (state.playerBuildingInventory[itemId] ?? 0) >= PLAYER_RESOURCE_CREATION_COST
    && !resourcePlacementFailure(state, itemId, tile)
  ));
}
