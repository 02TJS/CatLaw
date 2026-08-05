import { describe, expect, it } from "vitest";
import { ITEMS, RECIPES } from "../game/catalog";
import { layoutRecipeGraph, RECIPE_COLUMN_STEP, RECIPE_MIN_ROUTE_GAP, segmentIntersectsRect } from "./recipeGraphLayout";

function positiveCollinearOverlap(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number },
): boolean {
  if (a1.y === a2.y && b1.y === b2.y && a1.y === b1.y) {
    return Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x))
      < Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x));
  }
  if (a1.x === a2.x && b1.x === b2.x && a1.x === b1.x) {
    return Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y))
      < Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y));
  }
  return false;
}

describe("recipe graph one-flow layout", () => {
  const layout = layoutRecipeGraph(ITEMS, RECIPES);

  it("keeps all 65 products in one stable, non-overlapping era layout", () => {
    expect(layout.nodes).toHaveLength(65);
    expect(new Set(layout.nodes.map((node) => node.id)).size).toBe(65);
    const tierXs = [...new Set([...layout.nodes].sort((a, b) => a.tier - b.tier).map((node) => node.x))];
    expect(tierXs).toHaveLength(9);
    for (let index = 1; index < tierXs.length; index += 1) expect(tierXs[index] - tierXs[index - 1]).toBe(RECIPE_COLUMN_STEP);
    for (let index = 0; index < layout.nodes.length; index += 1) {
      for (let otherIndex = index + 1; otherIndex < layout.nodes.length; otherIndex += 1) {
        const a = layout.nodes[index];
        const b = layout.nodes[otherIndex];
        const overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        expect(overlaps, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });

  it("places every same-era ingredient above the product that consumes it", () => {
    const nodeById = new Map(layout.nodes.map((node) => [node.id, node]));
    for (const recipe of RECIPES) {
      const target = nodeById.get(recipe.output)!;
      for (const input of recipe.inputs) {
        const source = nodeById.get(input.itemId)!;
        if (source.tier === target.tier) expect(source.y, `${input.itemId} should be above ${recipe.output}`).toBeLessThan(target.y);
      }
    }
  });

  it("uses a visible route-clearance budget larger than the previous sub-pixel separation", () => {
    expect(RECIPE_MIN_ROUTE_GAP).toBeGreaterThanOrEqual(8);
  });

  it("draws one short orthogonal wire per ingredient without crossing a product card", () => {
    expect(layout.edges).toHaveLength(RECIPES.reduce((sum, recipe) => sum + recipe.inputs.length, 0));
    let totalLength = 0;
    for (const edge of layout.edges) {
      for (let index = 1; index < edge.points.length; index += 1) {
        const a = edge.points[index - 1];
        const b = edge.points[index];
        expect(a.x === b.x || a.y === b.y, `${edge.id} contains a diagonal segment`).toBe(true);
        totalLength += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
        for (const node of layout.nodes) {
          if (node.id === edge.source || node.id === edge.target) continue;
          expect(segmentIntersectsRect(a, b, node, 3), `${edge.id} crosses ${node.id}`).toBe(false);
        }
      }
    }
    expect(layout.width).toBeLessThan(3_000);
    expect(totalLength).toBeLessThan(140_000);
  });

  it("separates every shared wire corridor instead of drawing lines on top of each other", () => {
    for (let edgeIndex = 0; edgeIndex < layout.edges.length; edgeIndex += 1) {
      const edge = layout.edges[edgeIndex];
      for (let otherIndex = edgeIndex + 1; otherIndex < layout.edges.length; otherIndex += 1) {
        const other = layout.edges[otherIndex];
        for (let segment = 1; segment < edge.points.length; segment += 1) {
          for (let otherSegment = 1; otherSegment < other.points.length; otherSegment += 1) {
            const sharesNode = edge.source === other.source || edge.source === other.target
              || edge.target === other.source || edge.target === other.target;
            if (!sharesNode) expect(
              positiveCollinearOverlap(edge.points[segment - 1], edge.points[segment], other.points[otherSegment - 1], other.points[otherSegment]),
              `${edge.id} overlaps ${other.id}`,
            ).toBe(false);
          }
        }
      }
    }
  }, 15_000);
});
