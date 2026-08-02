import { describe, expect, it } from "vitest";
import { createInitialState, expandParcel, placeCat } from "./engine";
import { BASE_RESOURCE_ITEM_IDS, generateParcelResourceNodes, generateStarterWorld, parcelBounds, parcelCost, parcelForPosition, resourceHarvestTiles, resourceNodesAtPosition } from "./world";

describe("9x9 parcel world", () => {
  it("maps the centered parcel and negative boundaries correctly", () => {
    expect(parcelBounds({ x: 0, y: 0 })).toEqual({ minX: -4, minY: -4, maxX: 4, maxY: 4 });
    expect(parcelForPosition({ x: -4, y: 4 })).toEqual({ x: 0, y: 0 });
    expect(parcelForPosition({ x: 4, y: -4 })).toEqual({ x: 0, y: 0 });
    expect(parcelForPosition({ x: 5, y: 0 })).toEqual({ x: 1, y: 0 });
    expect(parcelForPosition({ x: -5, y: 0 })).toEqual({ x: -1, y: 0 });
    expect(parcelForPosition({ x: -14, y: 14 })).toEqual({ x: -2, y: 2 });
  });

  it("generates a deterministic connected eleven-cat start with six unique resources", () => {
    const first = generateStarterWorld(123456);
    const repeat = generateStarterWorld(123456);
    const different = generateStarterWorld(654321);
    expect(repeat).toEqual(first);
    expect(different).not.toEqual(first);
    expect(first.catPositions).toHaveLength(11);
    expect(first.catPositions[0]).toEqual({ x: 0, y: 0 });
    expect(new Set(first.catPositions.map((position) => `${position.x},${position.y}`)).size).toBe(11);
    expect(first.resourceNodes.map((node) => node.itemId).sort()).toEqual([...BASE_RESOURCE_ITEM_IDS].sort());
    expect(first.resourceNodes.every((node) => !first.catPositions.some((cat) => cat.x === node.position.x && cat.y === node.position.y))).toBe(true);
    expect(first.resourceNodes.every((node) => first.catPositions.some((cat) => resourceNodesAtPosition([node], cat).length === 1))).toBe(true);
    const harvestTiles = first.resourceNodes.flatMap(resourceHarvestTiles);
    expect(new Set(harvestTiles.map((position) => `${position.x},${position.y}`)).size).toBe(harvestTiles.length);
    expect(Math.max(...first.resourceNodes.map((node) => node.position.x)) - Math.min(...first.resourceNodes.map((node) => node.position.x))).toBeGreaterThanOrEqual(4);
    expect(Math.max(...first.resourceNodes.map((node) => node.position.y)) - Math.min(...first.resourceNodes.map((node) => node.position.y))).toBeGreaterThanOrEqual(4);
    const reached = new Set([`${first.catPositions[0].x},${first.catPositions[0].y}`]);
    while (true) {
      const before = reached.size;
      for (const position of first.catPositions) {
        if ([...reached].some((key) => {
          const [x, y] = key.split(",").map(Number);
          return Math.abs(x - position.x) + Math.abs(y - position.y) === 1;
        })) reached.add(`${position.x},${position.y}`);
      }
      if (reached.size === before) break;
    }
    expect(reached.size).toBe(11);
  });

  it("creates one or two stable resource nodes in every purchased parcel", () => {
    for (const parcel of [{ x: 1, y: 0 }, { x: -2, y: 3 }, { x: 0, y: -1 }]) {
      const nodes = generateParcelResourceNodes(99, parcel);
      expect(nodes.length).toBeGreaterThanOrEqual(1);
      expect(nodes.length).toBeLessThanOrEqual(2);
      expect(generateParcelResourceNodes(99, parcel)).toEqual(nodes);
      const bounds = parcelBounds(parcel);
      expect(nodes.every((node) => node.position.x >= bounds.minX && node.position.x <= bounds.maxX
        && node.position.y >= bounds.minY && node.position.y <= bounds.maxY)).toBe(true);
      expect(nodes.every((node) => node.position.x > bounds.minX && node.position.x < bounds.maxX
        && node.position.y > bounds.minY && node.position.y < bounds.maxY)).toBe(true);
      expect(nodes.every((node, index) => nodes.slice(index + 1).every((other) => Math.max(
        Math.abs(node.position.x - other.position.x), Math.abs(node.position.y - other.position.y),
      ) >= 3))).toBe(true);
      expect(new Set(nodes.map((node) => node.itemId)).size).toBe(nodes.length);
    }
  });

  it("charges only adjacent parcels and prevents placement on locked land", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 7 });
    expect(placeCat(state, { x: 5, y: 0 })).toBeNull();
    expect(expandParcel(state, { x: 2, y: 0 })).toEqual({ ok: false, error: "只能开拓与现有土地四邻相接的地块" });
    const cost = parcelCost({ x: 1, y: 0 });
    state.treasuryCoins = cost - 1;
    expect(expandParcel(state, { x: 1, y: 0 })).toEqual({ ok: false, error: "国库需要 75.00 🪙" });
    state.treasuryCoins = cost;
    expect(expandParcel(state, { x: 1, y: 0 })).toEqual({ ok: true, cost });
    expect(state.treasuryCoins).toBe(0);
    const resourceCenter = state.resourceNodes.find((node) => parcelForPosition(node.position).x === 1)!;
    expect(placeCat(state, resourceCenter.position)).toBeNull();
    const harvestTile = resourceHarvestTiles(resourceCenter).find((position) => parcelForPosition(position).x === 1)!;
    expect(placeCat(state, harvestTile)).not.toBeNull();
    expect(expandParcel(state, { x: 1, y: 0 })).toEqual({ ok: false, error: "地块已经开拓" });
  });
});
