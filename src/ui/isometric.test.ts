import { describe, expect, it } from "vitest";
import {
  depthCompare,
  isoPointToTile,
  isoToScreen,
  isoToWorld,
  pointInTile,
  sceneDepthCompare,
  screenPointToTile,
  tileDiamond,
  worldToIso,
} from "./isometric";

describe("isometric geometry", () => {
  it("round-trips positive, negative, and fractional world coordinates", () => {
    for (const point of [{ x: 0, y: 0 }, { x: -7, y: 4 }, { x: 3.25, y: -8.5 }]) {
      const roundTrip = isoToWorld(worldToIso(point));
      expect(roundTrip.x).toBeCloseTo(point.x, 10);
      expect(roundTrip.y).toBeCloseTo(point.y, 10);
    }
  });

  it("hits tile centers, negative tiles, and shared edges deterministically", () => {
    expect(isoPointToTile(worldToIso({ x: -3, y: -2 }))).toEqual({ x: -3, y: -2 });
    const eastEdge = tileDiamond({ x: 0, y: 0 })[1];
    expect(pointInTile(eastEdge, { x: 0, y: 0 })).toBe(true);
    expect(isoPointToTile(eastEdge)).toEqual({ x: 1, y: 0 });
  });

  it("maps neighboring tiles to the expected isometric directions", () => {
    const origin = worldToIso({ x: 0, y: 0 });
    expect(worldToIso({ x: 1, y: 0 })).toEqual({ x: origin.x + 64, y: origin.y + 32 });
    expect(worldToIso({ x: 0, y: 1 })).toEqual({ x: origin.x - 64, y: origin.y + 32 });
  });

  it("keeps hit testing correct after pan and zoom", () => {
    const camera = { x: 38, y: -21, zoom: 1.37 };
    const viewport = { width: 913, height: 677 };
    const tile = { x: -4, y: 6 };
    const screen = isoToScreen(worldToIso(tile), camera, viewport);
    expect(screenPointToTile(screen, camera, viewport)).toEqual(tile);
  });

  it("sorts equal-depth positions stably", () => {
    const rows = [
      { x: 2, y: 0, createdIndex: 2 },
      { x: 0, y: 2, createdIndex: 1 },
      { x: 1, y: 0, createdIndex: 3 },
    ].sort(depthCompare);
    expect(rows.map(({ x, y }) => [x, y])).toEqual([[1, 0], [0, 2], [2, 0]]);
  });

  it("moves a travelling actor across adjacent station layers at the halfway boundary", () => {
    const source = { position: { x: 0, y: 0 }, layer: 0, order: 0 };
    const eastStation = { position: { x: 1, y: 0 }, layer: 0, order: 1 };
    const earlyActor = { position: { x: 0.25, y: 0 }, layer: 0.5, order: 2 };
    const lateActor = { position: { x: 0.75, y: 0 }, layer: 0.5, order: 2 };

    expect([eastStation, earlyActor, source].sort(sceneDepthCompare)).toEqual([source, earlyActor, eastStation]);
    expect([lateActor, eastStation, source].sort(sceneDepthCompare)).toEqual([source, eastStation, lateActor]);
  });

  it("places a northbound actor behind its source station after crossing the boundary", () => {
    const northStation = { position: { x: 0, y: -1 }, layer: 0, order: 0 };
    const source = { position: { x: 0, y: 0 }, layer: 0, order: 1 };
    const actor = { position: { x: 0, y: -0.75 }, layer: 0.5, order: 2 };
    expect([source, actor, northStation].sort(sceneDepthCompare)).toEqual([northStation, actor, source]);
  });
});
