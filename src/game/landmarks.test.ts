import { describe, expect, it } from "vitest";
import { advanceGame, createInitialState, itemPrice, sellWarehouseItem, warehouseSellPrice } from "./engine";
import {
  actionSpeedReductionAt,
  buyLandmarkBlueprint,
  dismantleLandmark,
  landmarkEffectsAt,
  landmarkPlacementFailure,
  placeLandmark,
} from "./landmarks";
import { carrierFeeCents, creditLimitCents } from "./market";
import { migrateSaveSnapshot } from "./persistence";
import type { GameState, LandmarkId, LawVersion } from "./types";

function blank(): GameState {
  const state = createInitialState({ withStarter: false, worldSeed: 7 });
  state.resourceNodes = [];
  state.treasuryCoins = 1_000_000;
  return state;
}

function unlockAndStock(state: GameState, id: LandmarkId): void {
  const materials = ({
    founders_plaza: [["stone", 6], ["plank", 2], ["tools", 1]],
    craft_academy: [["brick", 4], ["paper", 4], ["tools", 2], ["glass", 2]],
    logistics_hub: [["chassis", 4], ["wheel", 4], ["fuel", 2], ["radio", 1]],
    market_center: [["brick", 6], ["display", 2], ["radio", 2], ["computer", 1]],
    energy_spire: [["battery", 6], ["cable", 4], ["controller", 2], ["solar_array", 2]],
    quantum_beacon: [["satellite", 2], ["ai_core", 2], ["quantum_sensor", 1], ["superconductor", 2]],
  } as const)[id];
  state.discoveredItems.push(...materials.map(([itemId]) => itemId));
  for (const [itemId, quantity] of materials) state.playerBuildingInventory[itemId] = quantity;
  expect(buyLandmarkBlueprint(state, id).ok).toBe(true);
}

function behaviorLaw(sourceCode: string): LawVersion {
  return {
    id: "test-law", title: "test", playerText: "test", summary: "test", sourceCode, astHash: "test", examples: [], warnings: [],
    enactedAt: 0, program: { version: 2 },
    hitCount: 0, invalidCount: 0, consecutiveFaults: 0, status: "active",
  };
}

describe("0.11.0 player landmarks", () => {
  it("keeps blueprint purchase failure paths atomic and unlocks permanently on success", () => {
    const state = blank();
    const before = structuredClone(state);
    expect(buyLandmarkBlueprint(state, "founders_plaza").ok).toBe(false);
    expect(state.treasuryCoins).toBe(before.treasuryCoins);
    expect(state.unlockedLandmarkIds).toEqual([]);
    state.discoveredItems.push("stone", "plank", "tools");
    state.treasuryCoins = 999;
    expect(buyLandmarkBlueprint(state, "founders_plaza").ok).toBe(false);
    expect(state.treasuryCoins).toBe(999);
    state.treasuryCoins = 1_000;
    expect(buyLandmarkBlueprint(state, "founders_plaza")).toEqual({ ok: true, cost: 1_000 });
    expect(state.treasuryCoins).toBe(0);
    expect(state.unlockedLandmarkIds).toEqual(["founders_plaza"]);
    expect(buyLandmarkBlueprint(state, "founders_plaza").ok).toBe(false);
  });

  it("places atomically only on ordinary empty land and refunds floor half on dismantle", () => {
    const state = blank();
    unlockAndStock(state, "founders_plaza");
    const stocked = structuredClone(state.playerBuildingInventory);
    expect(landmarkPlacementFailure(state, "founders_plaza", { x: 0, y: 0 })).toContain("猫咪");
    expect(placeLandmark(state, "founders_plaza", { x: 99, y: 99 }).ok).toBe(false);
    expect(state.playerBuildingInventory).toEqual(stocked);
    const placed = placeLandmark(state, "founders_plaza", { x: 1, y: 0 });
    expect(placed.ok).toBe(true);
    expect(state.playerBuildingInventory).toEqual({});
    expect(placeLandmark(state, "founders_plaza", { x: 1, y: 0 }).ok).toBe(false);
    expect(dismantleLandmark(state, placed.landmark!.id)).toEqual({ ok: true, refunded: { stone: 3, plank: 1 } });
    expect(state.playerBuildingInventory).toEqual({ stone: 3, plank: 1 });
    expect(state.unlockedLandmarkIds).toContain("founders_plaza");
  });

  it("rejects resource centers, harvest cells, industrial buildings, and landmarks", () => {
    const state = blank();
    unlockAndStock(state, "founders_plaza");
    state.resourceNodes = [{ id: "r", itemId: "wood", position: { x: 2, y: 2 } }];
    expect(landmarkPlacementFailure(state, "founders_plaza", { x: 2, y: 2 })).toContain("资源");
    expect(landmarkPlacementFailure(state, "founders_plaza", { x: 1, y: 2 })).toContain("资源");
    state.resourceNodes = [];
    state.buildings.push({ id: "b", itemId: "factory", position: { x: 2, y: 2 }, deployedAt: 0 });
    expect(landmarkPlacementFailure(state, "founders_plaza", { x: 2, y: 2 })).toContain("工业建筑");
    state.buildings = [];
    state.landmarks.push({ id: "l", landmarkId: "founders_plaza", position: { x: 2, y: 2 }, deployedAt: 0 });
    expect(landmarkPlacementFailure(state, "founders_plaza", { x: 2, y: 2 })).toContain("地标");
  });

  it("caps same-type stacks at three and combines cross-type effects at all limits", () => {
    const state = blank();
    const positions = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    const deploy = (landmarkId: LandmarkId, count: number) => {
      for (let index = 0; index < count; index += 1) state.landmarks.push({
        id: `${landmarkId}-${index}`, landmarkId, position: positions[index], deployedAt: 0,
      });
    };
    deploy("founders_plaza", 4);
    deploy("craft_academy", 3);
    deploy("market_center", 4);
    deploy("logistics_hub", 4);
    deploy("quantum_beacon", 4);
    const effects = landmarkEffectsAt(state, { x: 0, y: 0 });
    expect(effects.stacks.founders_plaza).toBe(3);
    expect(effects.stacks.logistics_hub).toBe(3);
    expect(effects.stacks.market_center).toBe(3);
    expect(effects.saleValueBonus).toBeCloseTo(0.45);
    expect(effects.creditBonusCents).toBe(7_500);
    expect(effects.carrierFeeBonus).toBeCloseTo(0.60);
    expect(effects.effectiveVisionRadius).toBe(2);
    expect(actionSpeedReductionAt(state, { x: 0, y: 0 }, "craft")).toBeCloseTo(0.60);
  });

  it("multiplies repeated and cross-type time reductions", () => {
    const state = blank();
    state.landmarks.push(
      { id: "craft-1", landmarkId: "craft_academy", position: { x: 1, y: 0 }, deployedAt: 0 },
      { id: "craft-2", landmarkId: "craft_academy", position: { x: -1, y: 0 }, deployedAt: 0 },
    );
    expect(landmarkEffectsAt(state, { x: 0, y: 0 }).craftSpeedReduction).toBeCloseTo(0.36);
    expect(actionSpeedReductionAt(state, { x: 0, y: 0 }, "craft")).toBeCloseTo(0.36);

    state.landmarks = [
      { id: "all", landmarkId: "founders_plaza", position: { x: 1, y: 0 }, deployedAt: 0 },
      { id: "craft", landmarkId: "craft_academy", position: { x: -1, y: 0 }, deployedAt: 0 },
    ];
    expect(actionSpeedReductionAt(state, { x: 0, y: 0 }, "craft")).toBeCloseTo(0.28);
  });

  it("locks accelerated duration while player warehouse sales ignore landmarks", () => {
    const state = blank();
    state.landmarks.push({ id: "p", landmarkId: "founders_plaza", position: { x: 2, y: 0 }, deployedAt: 0 });
    state.cats[0].inventory.wood = 2;
    state.laws = [behaviorLaw('function decide(ctx) { return { type: "craft", recipeId: "make_plank" }; }')];
    advanceGame(state, 5_000);
    expect(state.cats[0].action?.endsAt).toBe(9_500);
    state.landmarks = [];
    expect(state.cats[0].action?.endsAt).toBe(9_500);
    advanceGame(state, 4_499);
    expect(state.itemStats.plank.crafted).toBe(0);
    advanceGame(state, 1);
    expect(state.itemStats.plank.crafted).toBe(1);

    const sale = blank();
    sale.playerBuildingInventory.wood = 1;
    sale.landmarks.push({ id: "m", landmarkId: "market_center", position: { x: 1, y: 0 }, deployedAt: 0 });
    const treasuryBefore = sale.treasuryCoins;
    expect(sellWarehouseItem(sale, "wood")).toMatchObject({ ok: true, revenueCents: warehouseSellPrice("wood") });
    expect(sale.totalSales).toBe(warehouseSellPrice("wood"));
    expect(sale.treasuryCoins - treasuryBefore).toBe(warehouseSellPrice("wood"));
    expect(sale.cats[0].coins).toBe(0);
  });

  it("applies dynamic credit and locked carrier fee bonuses", () => {
    const state = blank();
    const cat = state.cats[0];
    const baseCredit = creditLimitCents(state, cat, (id) => itemPrice(state, id));
    const baseFee = carrierFeeCents(state, cat, (id) => itemPrice(state, id));
    state.landmarks.push(
      { id: "m1", landmarkId: "market_center", position: { x: 1, y: 0 }, deployedAt: 0 },
      { id: "h1", landmarkId: "logistics_hub", position: { x: 1, y: 1 }, deployedAt: 0 },
    );
    expect(creditLimitCents(state, cat, (id) => itemPrice(state, id))).toBe(baseCredit + 2_500);
    expect(carrierFeeCents(state, cat, (id) => itemPrice(state, id))).toBe(Math.ceil(baseFee * 1.2));
  });

  it("migrates schema 6 saves to empty schema 10 landmark and warehouse-lock state without loss", () => {
    const legacy = structuredClone(blank()) as any;
    legacy.schemaVersion = 6;
    delete legacy.landmarks;
    delete legacy.unlockedLandmarkIds;
    delete legacy.nextLandmarkIndex;
    legacy.treasuryCoins = 12_345;
    legacy.playerBuildingInventory = { wood: 9 };
    const migrated = migrateSaveSnapshot(legacy);
    expect(migrated.schemaVersion).toBe(17);
    expect(migrated.landmarks).toEqual([]);
    expect(migrated.unlockedLandmarkIds).toEqual([]);
    expect(migrated.nextLandmarkIndex).toBe(0);
    expect(migrated.treasuryCoins).toBe(12_345);
    expect(migrated.playerBuildingInventory).toEqual({ wood: 9 });
  });
});
