import { describe, expect, it } from "vitest";
import { advanceGame, createInitialState, grossProductionValuePerMinute, itemPrice } from "./engine";

describe("gross production value metric", () => {
  it("uses completed-goods value rather than treasury or sales growth", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 1 });
    state.simTime = 60_000;
    state.treasuryCoins = 9_999_999;
    state.totalSales = 8_888_888;
    state.recentProductionEvents = [
      { itemId: "wood", catId: state.cats[0].id, at: 10_000, valueCents: 100 },
      { itemId: "plank", catId: state.cats[0].id, at: 55_000, valueCents: 250 },
    ];

    expect(grossProductionValuePerMinute(state)).toBe(350);
    state.treasuryCoins = 0;
    state.totalSales = 0;
    expect(grossProductionValuePerMinute(state)).toBe(350);
  });

  it("annualizes a partial minute and ignores production outside the rolling window", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 2 });
    state.simTime = 30_000;
    state.recentProductionEvents = [
      { itemId: "wood", catId: state.cats[0].id, at: 5_000, valueCents: 100 },
    ];
    expect(grossProductionValuePerMinute(state)).toBe(200);

    state.simTime = 90_001;
    expect(grossProductionValuePerMinute(state)).toBe(0);
  });

  it("supports accelerated deterministic simulations and legacy events without stored value", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 3, simulationSpeed: 5_000 });
    state.simTime = 12;
    state.recentProductionEvents = [
      { itemId: "wood", catId: state.cats[0].id, at: 12, valueCents: 175 },
    ];
    expect(grossProductionValuePerMinute(state)).toBe(175);

    state.recentProductionEvents = [{ itemId: "wood", catId: state.cats[0].id, at: 12 }];
    expect(grossProductionValuePerMinute(state)).toBe(itemPrice(state, "wood", state.cats[0]));
  });

  it("records the producer's value when a real craft completes", () => {
    const state = createInitialState({ worldSeed: 7 });
    advanceGame(state, 10_000);
    expect(state.recentProductionEvents.length).toBeGreaterThan(0);
    expect(state.recentProductionEvents.every((event) => Number.isInteger(event.valueCents) && (event.valueCents ?? 0) > 0)).toBe(true);
    expect(grossProductionValuePerMinute(state)).toBeGreaterThan(0);
  });
});
