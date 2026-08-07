import { describe, expect, it } from "vitest";
import { createInitialState, PLAYER_RESOURCE_CREATION_COST } from "../game/engine";
import {
  canCreateResourceAt,
  canOfferAddCatAt,
  ownedBuildingOptionsAt,
  resourceCreationOptionsAt,
} from "./gameCanvasContextMenu";

describe("game canvas context menu", () => {
  it("offers a cat only on an unlocked tile with no world object", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 201 });
    const tile = { x: 0, y: 0 };
    const mode = { placingBuildingItemId: null, placingLandmarkId: null, expansionMode: false };
    state.cats = [];
    state.resourceNodes = [];
    state.buildings = [];
    state.landmarks = [];
    expect(canOfferAddCatAt(state, tile, mode)).toBe(true);

    state.resourceNodes = [{ id: "resource-test", itemId: "wood", position: tile }];
    expect(canOfferAddCatAt(state, tile, mode)).toBe(false);
    state.resourceNodes = [];
    state.buildings = [{ id: "building-test", itemId: "factory", position: tile, deployedAt: 0 }];
    expect(canOfferAddCatAt(state, tile, mode)).toBe(false);
    state.buildings = [];
    state.landmarks = [{ id: "landmark-test", landmarkId: null, name: "测试", position: tile, deployedAt: 0 }];
    expect(canOfferAddCatAt(state, tile, mode)).toBe(false);
    state.landmarks = [];
    state.cats = [{
      id: "cat-test",
      createdIndex: 0,
      position: tile,
      inventory: {},
      coins: 0,
      debtCents: 0,
      escrowReservedCents: 0,
      action: null,
      lastDecision: "",
      decisionTrace: [],
    }];
    expect(canOfferAddCatAt(state, tile, mode)).toBe(false);
  });

  it("preserves inventory quantities and placement failures in menu options", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 202 });
    const tile = { x: 0, y: 0 };
    state.cats = [];
    state.resourceNodes = [];
    state.buildings = [];
    state.landmarks = [];
    state.playerBuildingInventory = { factory: 2, wood: PLAYER_RESOURCE_CREATION_COST };

    expect(ownedBuildingOptionsAt(state, tile)).toEqual([
      { itemId: "factory", quantity: 2, failure: null },
    ]);
    expect(resourceCreationOptionsAt(state, tile)).toContainEqual({
      itemId: "wood",
      quantity: PLAYER_RESOURCE_CREATION_COST,
      failure: null,
    });
    expect(canCreateResourceAt(state, tile)).toBe(true);
  });
});
