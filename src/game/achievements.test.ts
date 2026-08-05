import { describe, expect, it } from "vitest";
import {
  acknowledgeAchievement,
  normalizeAchievementState,
  pendingAchievements,
  PRODUCTION_RATE_ACHIEVEMENT_THRESHOLDS_CENTS,
  TOTAL_PRODUCTION_ACHIEVEMENT_THRESHOLDS_CENTS,
  unlockProductionAchievements,
} from "./achievements";
import { advanceGame, createInitialState, itemPrice } from "./engine";
import { migrateSaveSnapshot } from "./persistence";

describe("persistent production achievements", () => {
  it("queues first craft, rate and total milestones only once", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 8101 });
    state.totalProductionValueCents = TOTAL_PRODUCTION_ACHIEVEMENT_THRESHOLDS_CENTS[0];
    unlockProductionAchievements(state, "wood", true, PRODUCTION_RATE_ACHIEVEMENT_THRESHOLDS_CENTS[0]);
    unlockProductionAchievements(state, "wood", true, PRODUCTION_RATE_ACHIEVEMENT_THRESHOLDS_CENTS[0]);
    expect(state.achievements.map((entry) => entry.id)).toEqual([
      "first-craft:wood",
      `production-rate:${PRODUCTION_RATE_ACHIEVEMENT_THRESHOLDS_CENTS[0]}`,
      `total-production:${TOTAL_PRODUCTION_ACHIEVEMENT_THRESHOLDS_CENTS[0]}`,
    ]);
    expect(pendingAchievements(state)).toHaveLength(3);
    expect(acknowledgeAchievement(state, "first-craft:wood")).toBe(true);
    expect(acknowledgeAchievement(state, "first-craft:wood")).toBe(false);
    expect(pendingAchievements(state).map((entry) => entry.id)).toHaveLength(2);
  });

  it("captures cumulative value at the price that applied when crafting completed", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 8102 });
    const cat = state.cats[0];
    const capturedValue = itemPrice(state, "wood", cat);
    cat.action = {
      type: "craft",
      recipeId: "make_wood",
      itemId: "wood",
      startedAt: state.simTime,
      endsAt: state.simTime + 5_000,
      reserved: {},
      lawId: "qa-achievement",
    };
    advanceGame(state, 5_000);
    expect(state.totalProductionValueCents).toBe(capturedValue);
    expect(state.achievements.some((entry) => entry.id === "first-craft:wood")).toBe(true);
  });

  it("marks legacy production achievements as already read", () => {
    const legacy = structuredClone(createInitialState({ withStarter: false, worldSeed: 8103 })) as any;
    delete legacy.achievements;
    delete legacy.totalProductionValueCents;
    legacy.itemStats.wood.crafted = 60;
    const migrated = migrateSaveSnapshot(legacy);
    expect(migrated.totalProductionValueCents).toBeGreaterThan(0);
    expect(migrated.achievements.find((entry) => entry.id === "first-craft:wood")?.acknowledgedAt).not.toBeNull();
    expect(pendingAchievements(migrated)).toHaveLength(0);
  });

  it("normalizes malformed achievement history without duplicating ids", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 8104 });
    state.achievements = [
      { id: "first-craft:wood", kind: "first-craft", itemId: "wood", thresholdCents: null, unlockedAt: 1, acknowledgedAt: null },
      { id: "first-craft:wood", kind: "first-craft", itemId: "wood", thresholdCents: null, unlockedAt: 2, acknowledgedAt: null },
    ];
    normalizeAchievementState(state, true);
    expect(state.achievements).toHaveLength(1);
  });

  it("presents pending achievements from the highest grade to the lowest", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 8105 });
    state.achievements = [
      { id: "first-craft:wood", kind: "first-craft", itemId: "wood", thresholdCents: null, unlockedAt: 1, acknowledgedAt: null },
      { id: "first-craft:computer", kind: "first-craft", itemId: "computer", thresholdCents: null, unlockedAt: 2, acknowledgedAt: null },
      { id: `production-rate:${PRODUCTION_RATE_ACHIEVEMENT_THRESHOLDS_CENTS.at(-1)}`, kind: "production-rate", itemId: null, thresholdCents: PRODUCTION_RATE_ACHIEVEMENT_THRESHOLDS_CENTS.at(-1)!, unlockedAt: 3, acknowledgedAt: null },
    ];
    expect(pendingAchievements(state).map((entry) => entry.id)).toEqual([
      `production-rate:${PRODUCTION_RATE_ACHIEVEMENT_THRESHOLDS_CENTS.at(-1)}`,
      "first-craft:computer",
      "first-craft:wood",
    ]);
  });
});
