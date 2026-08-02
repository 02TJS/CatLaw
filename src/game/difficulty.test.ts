import { describe, expect, it } from "vitest";
import { CATALOG_ANALYSIS, RECIPE_BY_OUTPUT } from "./catalog";
import { createInitialState, recipeSiteFailure } from "./engine";
import { createDiscoveryBounties } from "./market";
import { difficultyProfile, difficultySiteRequirements, effectiveRecipeInputs } from "./difficulty";

describe("five difficulty profiles", () => {
  it("exposes monotonic economy parameters and keeps standard bounty values", () => {
    expect(difficultyProfile(1).initialTreasuryCents).toBeGreaterThan(difficultyProfile(2).initialTreasuryCents);
    expect([1, 2, 3, 4, 5].map((level) => difficultyProfile(level as 1 | 2 | 3 | 4 | 5).baseCreditCents))
      .toEqual([15_000, 12_500, 10_000, 7_500, 5_000]);
    expect(difficultyProfile(1).bountyMultiplier).toBe(4);
    expect(difficultyProfile(2).bountyMultiplier).toBe(3);
    expect(createDiscoveryBounties(1)[0].amountCents).toBe(CATALOG_ANALYSIS.basePrices.wood * 400);
    expect(createDiscoveryBounties(2)[0].amountCents).toBe(CATALOG_ANALYSIS.basePrices.wood * 300);
  });

  it("turns on machine and antenna work zones at level three", () => {
    const vehicle = RECIPE_BY_OUTPUT.get("vehicle")!;
    expect(difficultySiteRequirements(vehicle, 2).map((entry) => entry.buildingItemId)).toEqual(["factory"]);
    expect(difficultySiteRequirements(vehicle, 3).map((entry) => entry.buildingItemId)).toEqual(["factory", "machine_tool"]);
    const radio = RECIPE_BY_OUTPUT.get("radio")!;
    expect(difficultySiteRequirements(radio, 3).map((entry) => entry.buildingItemId)).toEqual(["factory", "antenna"]);
  });

  it("adds overlapping compound zones at level four", () => {
    const rocket = RECIPE_BY_OUTPUT.get("rocket")!;
    expect(difficultySiteRequirements(rocket, 3).map((entry) => entry.buildingItemId)).toEqual(["reactor"]);
    expect(difficultySiteRequirements(rocket, 4).map((entry) => entry.buildingItemId)).toEqual(["reactor", "factory"]);
  });

  it("increases only existing ingredient quantities at level five", () => {
    const vehicle = RECIPE_BY_OUTPUT.get("vehicle")!;
    expect(effectiveRecipeInputs(vehicle, 2)).toEqual(vehicle.inputs);
    expect(effectiveRecipeInputs(vehicle, 5)).toEqual([
      { itemId: "wheel", quantity: 4 },
      { itemId: "controller", quantity: 1 },
      { itemId: "fuel", quantity: 2 },
    ]);
    const server = RECIPE_BY_OUTPUT.get("server")!;
    expect(effectiveRecipeInputs(server, 5)).toEqual([
      { itemId: "computer", quantity: 3 },
      { itemId: "coolant", quantity: 2 },
    ]);
  });

  it("uses the selected difficulty in production site validation", () => {
    const state = createInitialState({ withStarter: false, difficulty: 3, worldSeed: 13 });
    state.resourceNodes = [];
    state.buildings = [
      { id: "factory", itemId: "factory", hostCatId: "cat-0", position: { x: 0, y: 0 }, deployedAt: 0 },
      { id: "machine", itemId: "machine_tool", hostCatId: "cat-0", position: { x: 0, y: 2 }, deployedAt: 0 },
    ];
    const cat = { ...state.cats[0], position: { x: 0, y: 2 } };
    expect(recipeSiteFailure(state, cat, RECIPE_BY_OUTPUT.get("vehicle")!)).toBeNull();
    expect(recipeSiteFailure(state, { ...cat, position: { x: 2, y: 0 } }, RECIPE_BY_OUTPUT.get("vehicle")!)).toContain("机床2格内");
  });
});
