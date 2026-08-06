import { describe, expect, it } from "vitest";
import { executeLawSource } from "./lawInterpreter";
import {
  buildObservation,
  createInitialState,
  createPlayerResource,
  landmarkEffectsAt,
  placeNamedLandmark,
  removeResource,
  renameLandmark,
  resourcePlacementFailure,
} from "./engine";
import { landmarkNameFailure } from "./landmarks";
import type { GameState, Position } from "./types";
import { resourceNodesAtPosition } from "./world";

function emptyPosition(state: GameState, excluded: Position[] = []): Position {
  for (let y = -4; y <= 4; y += 1) {
    for (let x = -4; x <= 4; x += 1) {
      const occupied = state.cats.some((cat) => cat.position.x === x && cat.position.y === y)
        || state.resourceNodes.some((node) => node.position.x === x && node.position.y === y)
        || state.buildings.some((building) => building.position.x === x && building.position.y === y)
        || state.landmarks.some((landmark) => landmark.position.x === x && landmark.position.y === y)
        || excluded.some((position) => position.x === x && position.y === y);
      if (!occupied) return { x, y };
    }
  }
  throw new Error("中央地块没有普通空格");
}

describe("schema 17 right-click world editing", () => {
  it("creates a uniquely named landmark only after atomically consuming one warehouse wood", () => {
    const state = createInitialState({ worldSeed: 17 });
    const position = emptyPosition(state);
    const before = structuredClone(state.landmarks);
    expect(placeNamedLandmark(state, "东区", position)).toEqual({ ok: false, error: "仓库需要 1 份木材" });
    expect(state.landmarks).toEqual(before);

    state.playerBuildingInventory.wood = 1;
    state.playerWarehousePurchases.wood = 1;
    const result = placeNamedLandmark(state, "  东区  ", position);
    expect(result).toMatchObject({ ok: true, landmark: { landmarkId: null, name: "东区", position } });
    expect(state.playerBuildingInventory.wood).toBeUndefined();
    expect(state.playerWarehousePurchases.wood).toBeUndefined();
    expect(landmarkEffectsAt(state, position)).toMatchObject({
      actionSpeedReduction: 0,
      craftSpeedReduction: 0,
      passSpeedReduction: 0,
      saleValueBonus: 0,
      creditBonusCents: 0,
    });
  });

  it("rejects empty, unsafe, overlong, and case-insensitive duplicate landmark names", () => {
    const state = createInitialState({ worldSeed: 18 });
    const first = emptyPosition(state);
    state.playerBuildingInventory.wood = 2;
    expect(placeNamedLandmark(state, "Alpha", first).ok).toBe(true);
    expect(landmarkNameFailure(state, " ")).toBe("请输入地标名称");
    expect(landmarkNameFailure(state, "A/B")).toContain("只能使用");
    expect(landmarkNameFailure(state, "一".repeat(21))).toContain("最多 20");
    expect(placeNamedLandmark(state, "alpha", emptyPosition(state)).error).toBe("地标名称不能重复");
    expect(state.playerBuildingInventory.wood).toBe(1);
  });

  it("renames landmarks atomically and immediately changes law helper matching", () => {
    const state = createInitialState({ worldSeed: 19 });
    const position = emptyPosition(state);
    state.playerBuildingInventory.wood = 1;
    const landmark = placeNamedLandmark(state, "旧名", position).landmark!;
    expect(renameLandmark(state, landmark.id, "A")).toMatchObject({ ok: true, landmark: { name: "A" } });

    const observer = state.cats[0];
    const observation = buildObservation(state, observer);
    expect(observation.landmarks?.some((entry) => entry.name === "A" && entry.kind === "marker")).toBe(true);
    const near = executeLawSource("function decide(ctx) { if (nearLandmark('A', 20)) return earnCoins(); return null; }", observation, 200, {
      earnCoins: () => ({ type: "craft", recipeId: "make_wood" }),
    });
    const old = executeLawSource("function decide(ctx) { if (nearLandmark('旧名', 20)) return earnCoins(); return null; }", observation, 200, {
      earnCoins: () => ({ type: "craft", recipeId: "make_wood" }),
    });
    expect(near.action).toEqual({ type: "craft", recipeId: "make_wood" });
    expect(old.action).toBeNull();
  });

  it("creates a base-resource center for exactly fifty matching warehouse items", () => {
    const state = createInitialState({ worldSeed: 20 });
    const position = emptyPosition(state);
    state.playerBuildingInventory.stone = 49;
    const beforeNodes = state.resourceNodes.length;
    expect(createPlayerResource(state, "stone", position)).toEqual({ ok: false, error: "仓库需要 50 份石料" });
    expect(state.resourceNodes).toHaveLength(beforeNodes);
    expect(state.playerBuildingInventory.stone).toBe(49);

    state.playerBuildingInventory.stone = 50;
    state.playerWarehousePurchases.stone = 50;
    const result = createPlayerResource(state, "stone", position);
    expect(result).toMatchObject({ ok: true, resource: { itemId: "stone", position } });
    expect(state.playerBuildingInventory.stone).toBeUndefined();
    expect(state.playerWarehousePurchases.stone).toBeUndefined();
    expect(resourceNodesAtPosition([result.resource!], { x: position.x + 1, y: position.y + 1 }).map((node) => node.itemId)).toEqual(["stone"]);
    expect(removeResource(state, result.resource!.id)).toEqual({ ok: true });
    expect(resourceNodesAtPosition(state.resourceNodes, { x: position.x + 1, y: position.y + 1 }).some((node) => node.id === result.resource!.id)).toBe(false);
  });

  it("rejects non-base resources and exact-cell object collisions without consuming stock", () => {
    const state = createInitialState({ worldSeed: 21 });
    state.playerBuildingInventory.wood = 100;
    expect(resourcePlacementFailure(state, "plank", emptyPosition(state))).toBe("只能创建六种基础资源");
    const catPosition = state.cats[0].position;
    expect(createPlayerResource(state, "wood", catPosition)).toEqual({ ok: false, error: "该格已有猫咪工位" });
    expect(state.playerBuildingInventory.wood).toBe(100);
  });
});
