import { describe, expect, it } from "vitest";
import { createInitialState } from "../game/engine";
import { isoToScreen } from "./isometric";
import {
  actionProgress,
  actorScenePosition,
  contextTargetAtPoint,
  pointToWorldTile,
  workstationCenter,
} from "./gameCanvasGeometry";

describe("game canvas geometry", () => {
  it("maps the visible top of a raised workstation back to its world tile", () => {
    const state = createInitialState({ worldSeed: 123 });
    const cat = state.cats[0];
    cat.position = { x: 2, y: -1 };
    cat.action = {
      type: "craft",
      recipeId: "make_metal",
      itemId: "metal",
      startedAt: 0,
      endsAt: 100,
      reserved: {},
      lawId: "test-law",
    };
    const camera = { x: 0, y: 0, zoom: 1.25 };
    const viewport = { width: 800, height: 600 };
    const localPoint = isoToScreen(workstationCenter(cat), camera, viewport);

    expect(pointToWorldTile(localPoint, camera, viewport, [cat])).toEqual(cat.position);
  });

  it("prefers a screen-space object hit before the underlying ground tile", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 124 });
    state.cats = [];
    state.buildings = [];
    state.landmarks = [];
    state.resourceNodes = [{ id: "resource-test", itemId: "wood", position: { x: 3, y: 2 } }];
    const camera = { x: 0, y: 0, zoom: 1 };
    const viewport = { width: 900, height: 700 };
    const objectCenter = workstationCenter({
      id: "position-probe",
      createdIndex: 0,
      position: state.resourceNodes[0].position,
      inventory: {},
      coins: 0,
      debtCents: 0,
      escrowReservedCents: 0,
      action: null,
      lastDecision: "",
      decisionTrace: [],
    });
    const point = isoToScreen({ x: objectCenter.x, y: objectCenter.y + 7 }, camera, viewport);

    expect(contextTargetAtPoint(point, camera, viewport, state)).toEqual({
      tile: { x: 3, y: 2 },
      target: { kind: "resource", id: "resource-test" },
    });
  });

  it("keeps action progress and travelling actor positions deterministic", () => {
    const state = createInitialState({ worldSeed: 125 });
    const cat = state.cats[0];
    cat.position = { x: 4, y: 5 };
    cat.action = {
      type: "pass",
      itemId: "wood",
      direction: "east",
      startedAt: 100,
      endsAt: 300,
      reserved: {},
      lawId: "test-law",
    };

    expect(actionProgress(cat.action, 200)).toBe(0.5);
    expect(actorScenePosition(cat, 200, false)).toEqual({ x: 4.5, y: 5 });
    expect(actorScenePosition(cat, 200, true)).toEqual({ x: 4.45, y: 5 });
  });
});
