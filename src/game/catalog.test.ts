import { describe, expect, it } from "vitest";
import {
  CATALOG_ANALYSIS,
  INDUSTRIAL_GATE_RECIPE_IDS,
  INTRO_RECIPE_IDS,
  ITEMS,
  MARKET_CERTIFICATION_ITEM_IDS,
  MARKET_CHALLENGE_RECIPE_IDS,
  TUTORIAL_RECIPE_IDS,
  RECIPES,
  RECIPE_BY_OUTPUT,
  missingProductionCertifications,
  validateCatalog,
} from "./catalog";

describe("catalog", () => {
  it("contains 65 unique, reachable items and recipes", () => {
    expect(ITEMS).toHaveLength(65);
    expect(RECIPES).toHaveLength(65);
    expect(new Set(ITEMS.map((item) => item.id)).size).toBe(65);
    expect(new Set(ITEMS.map((item) => item.emoji)).size).toBe(65);
    expect(() => validateCatalog()).not.toThrow();
    expect(Object.keys(CATALOG_ANALYSIS.workUnits)).toHaveLength(65);
  });

  it("keeps the stargate behind all six final components", () => {
    const recipe = RECIPE_BY_OUTPUT.get("stargate");
    expect(recipe?.inputs.map((input) => input.itemId)).toEqual([
      "gate_ring", "stabilizer", "exotic_crystal", "address_core", "containment", "energy_matrix",
    ]);
    expect(CATALOG_ANALYSIS.sellPrices.stargate).toBeGreaterThan(CATALOG_ANALYSIS.sellPrices.wood);
  });

  it("defines the market challenge at catalog positions 10–20", () => {
    expect(INTRO_RECIPE_IDS).toEqual(RECIPES.slice(0, 9).map((recipe) => recipe.id));
    expect(MARKET_CHALLENGE_RECIPE_IDS).toEqual(RECIPES.slice(9, 15).map((recipe) => recipe.id));
    expect(TUTORIAL_RECIPE_IDS).toEqual(RECIPES.slice(0, 15).map((recipe) => recipe.id));
    expect(MARKET_CERTIFICATION_ITEM_IDS).toEqual(["thread", "paper", "tools", "glass", "metal", "gear"]);
    expect(INDUSTRIAL_GATE_RECIPE_IDS).toEqual(RECIPES.slice(15, 20).map((recipe) => recipe.id));
    expect(missingProductionCertifications("make_cable", ["metal", "gear"])).toEqual(["thread", "paper", "tools", "glass"]);
  });

  it("assigns the exact factory, lab, and reactor manufacturing gates", () => {
    expect(RECIPE_BY_OUTPUT.get("coolant")?.siteRequirements).toEqual([]);
    expect(RECIPE_BY_OUTPUT.get("chip")?.siteRequirements).toEqual([{ buildingItemId: "factory", maxManhattanDistance: 2 }]);
    expect(RECIPE_BY_OUTPUT.get("lab")?.siteRequirements).toEqual([{ buildingItemId: "factory", maxManhattanDistance: 2 }]);
    expect(RECIPE_BY_OUTPUT.get("atom_core")?.siteRequirements).toEqual([{ buildingItemId: "lab", maxManhattanDistance: 2 }]);
    expect(RECIPE_BY_OUTPUT.get("solar_array")?.siteRequirements).toEqual([{ buildingItemId: "lab", maxManhattanDistance: 2 }]);
    expect(RECIPE_BY_OUTPUT.get("rocket")?.siteRequirements).toContainEqual({ buildingItemId: "reactor", maxManhattanDistance: 3 });
    expect(RECIPE_BY_OUTPUT.get("stargate")?.siteRequirements).toContainEqual({ buildingItemId: "reactor", maxManhattanDistance: 3 });
  });
});
