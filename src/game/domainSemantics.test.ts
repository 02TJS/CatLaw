import { describe, expect, it } from "vitest";
import { GameController } from "./controller";
import {
  catCashCents,
  PLAYER_WAREHOUSE_SAVE_FIELD,
  playerWarehouseInventory,
  treasuryCashCents,
} from "./domainSemantics";
import {
  normalizeInternalSimulationRate,
  normalizeRuntimeSpeedMultiplier,
} from "./domainUnits";
import { createInitialState } from "./engine";
import { serializeGameState } from "./persistence";

describe("domain semantic boundaries", () => {
  it("preserves the historical internal simulation-rate normalization", () => {
    expect(normalizeInternalSimulationRate(undefined)).toBe(1);
    expect(normalizeInternalSimulationRate(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normalizeInternalSimulationRate(-3)).toBe(1);
    expect(normalizeInternalSimulationRate(3.9)).toBe(3);
    expect(createInitialState({ simulationSpeed: 3.9 }).simulationSpeed).toBe(3);
  });

  it("preserves nearest runtime preset selection and the lower-value tie break", () => {
    expect(normalizeRuntimeSpeedMultiplier(0)).toBe(1);
    expect(normalizeRuntimeSpeedMultiplier(1.5)).toBe(1);
    expect(normalizeRuntimeSpeedMultiplier(3)).toBe(2);
    expect(normalizeRuntimeSpeedMultiplier(7.9)).toBe(8);
  });

  it("keeps runtime playback speed outside deterministic GameState", () => {
    const controller = new GameController();
    controller.state = createInitialState({ simulationSpeed: 7 });

    controller.setSpeed(3);
    expect(controller.getRuntimeSpeedMultiplier()).toBe(2);
    expect(controller.state.simulationSpeed).toBe(7);

    controller.setRuntimeSpeedMultiplier(8);
    expect(controller.getSpeedMultiplier()).toBe(8);
    expect(controller.state.simulationSpeed).toBe(7);
  });

  it("maps canonical money and warehouse names to the unchanged save fields", () => {
    const state = createInitialState({ worldSeed: 607 });
    const firstCat = state.cats[0];
    state.playerBuildingInventory.wood = 4;

    expect(PLAYER_WAREHOUSE_SAVE_FIELD).toBe("playerBuildingInventory");
    expect(playerWarehouseInventory(state)).toBe(state.playerBuildingInventory);
    expect(playerWarehouseInventory(state).wood).toBe(4);
    expect(catCashCents(firstCat)).toBe(firstCat.coins);
    expect(treasuryCashCents(state)).toBe(state.treasuryCoins);
  });

  it("serializes only the legacy-compatible save keys, not canonical aliases", () => {
    const snapshot = serializeGameState(createInitialState({ worldSeed: 608 }));
    const serialized = snapshot as unknown as Record<string, unknown>;
    const firstCat = snapshot.cats[0] as unknown as Record<string, unknown>;

    expect(serialized).toHaveProperty("treasuryCoins");
    expect(serialized).toHaveProperty("playerBuildingInventory");
    expect(serialized).not.toHaveProperty("treasuryCashCents");
    expect(serialized).not.toHaveProperty("playerWarehouseInventory");
    expect(firstCat).toHaveProperty("coins");
    expect(firstCat).not.toHaveProperty("cashCents");
  });
});
