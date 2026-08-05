import { describe, expect, it } from "vitest";
import {
  BASE_PRICE_FLOORS,
  BASE_PRICE_TIER_PREMIUMS,
  CATALOG_ANALYSIS,
  FOUNDATION_RECIPE_IDS,
  INPUT_PARITY_PRICE_IDS,
  INDUSTRIAL_GATE_RECIPE_IDS,
  INTRO_RECIPE_IDS,
  ITEMS,
  MARKET_CERTIFICATION_ITEM_IDS,
  MARKET_CHALLENGE_RECIPE_IDS,
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

  it("uses permanent early price floors, one proven parity bottleneck, and a profitable advanced value curve", () => {
    for (const [itemId, floor] of Object.entries(BASE_PRICE_FLOORS)) {
      expect(CATALOG_ANALYSIS.basePrices[itemId], itemId).toBeGreaterThanOrEqual(floor);
    }
    expect(BASE_PRICE_TIER_PREMIUMS).toEqual([1, 1.15, 1.35, 1.65, 2, 2.5, 3.25, 4.25, 5.5]);
    for (const recipe of RECIPES.filter((entry) => entry.inputs.length > 0)) {
      const ingredientValue = recipe.inputs.reduce((sum, input) => (
        sum + CATALOG_ANALYSIS.basePrices[input.itemId] * input.quantity
      ), 0);
      if (INPUT_PARITY_PRICE_IDS.includes(recipe.output as typeof INPUT_PARITY_PRICE_IDS[number])) {
        expect(CATALOG_ANALYSIS.basePrices[recipe.output], recipe.output).toBe(ingredientValue);
      } else {
        expect(CATALOG_ANALYSIS.basePrices[recipe.output], recipe.output).toBeGreaterThan(ingredientValue);
      }
    }
    expect(CATALOG_ANALYSIS.basePrices.factory).toBe(64);
    expect(CATALOG_ANALYSIS.basePrices.stargate).toBeGreaterThan(300_000);
  });

  it("defines the free foundation, paid challenge, and industrial gate through item 20", () => {
    expect(INTRO_RECIPE_IDS).toEqual(RECIPES.slice(0, 10).map((recipe) => recipe.id));
    expect(MARKET_CHALLENGE_RECIPE_IDS).toEqual(RECIPES.slice(10, 15).map((recipe) => recipe.id));
    expect(FOUNDATION_RECIPE_IDS).toEqual(RECIPES.slice(0, 15).map((recipe) => recipe.id));
    expect(MARKET_CERTIFICATION_ITEM_IDS).toEqual(["paper", "tools", "glass", "metal", "gear"]);
    expect(INDUSTRIAL_GATE_RECIPE_IDS).toEqual(RECIPES.slice(15, 20).map((recipe) => recipe.id));
    expect(missingProductionCertifications("make_cable", ["metal", "gear"])).toEqual(["paper", "tools", "glass"]);
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
