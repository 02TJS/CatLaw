import { describe, expect, it } from "vitest";
import { createInitialState } from "../game/engine";
import type { SceneReadModel } from "./gameCanvasScene";
import { rebuildSceneReadModel } from "./gameCanvasScene";

function scratch(): SceneReadModel {
  return { visibleCats: [], scene: [], stationBases: [], catById: new Map() };
}

describe("game canvas scene read model", () => {
  it("clips world objects and preserves painter ordering", () => {
    const state = createInitialState({ worldSeed: 301 });
    const nearCat = state.cats[0];
    const farCat = state.cats[1];
    nearCat.position = { x: 0, y: 0 };
    nearCat.action = null;
    farCat.position = { x: 20, y: 20 };
    state.cats = [nearCat, farCat];
    state.resourceNodes = [
      { id: "resource-near", itemId: "wood", position: { x: 0, y: 0 } },
      { id: "resource-far", itemId: "stone", position: { x: 20, y: 20 } },
    ];
    state.buildings = [{ id: "building-near", itemId: "factory", position: { x: 0, y: 0 }, deployedAt: 0 }];
    state.landmarks = [{ id: "landmark-near", landmarkId: null, name: "测试", position: { x: 0, y: 0 }, deployedAt: 0 }];
    const model = scratch();

    rebuildSceneReadModel(state, { minX: 0, maxX: 0, minY: 0, maxY: 0 }, false, model);

    expect(model.visibleCats.map((cat) => cat.id)).toEqual([nearCat.id]);
    expect([...model.catById]).toEqual([[nearCat.id, nearCat]]);
    expect(model.stationBases).toEqual([nearCat]);
    expect(model.scene.map((entry) => entry.kind)).toEqual(["building", "landmark", "resource", "actor"]);
    expect(model.scene.some((entry) => "node" in entry && entry.node.id === "resource-far")).toBe(false);
  });

  it("uses fractional pass progress for a moving actor", () => {
    const state = createInitialState({ worldSeed: 302 });
    const cat = state.cats[0];
    state.simTime = 50;
    cat.position = { x: 0, y: 0 };
    cat.action = {
      type: "pass",
      itemId: "wood",
      direction: "east",
      startedAt: 0,
      endsAt: 100,
      reserved: {},
      lawId: "test-law",
    };
    state.cats = [cat];
    state.resourceNodes = [];
    state.buildings = [];
    state.landmarks = [];
    const model = scratch();

    rebuildSceneReadModel(state, { minX: -1, maxX: 1, minY: -1, maxY: 1 }, false, model);

    expect(model.scene).toHaveLength(1);
    expect(model.scene[0].position).toEqual({ x: 0.5, y: 0 });
  });
});
