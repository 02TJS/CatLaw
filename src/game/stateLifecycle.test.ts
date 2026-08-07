import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import { cloneGameStateForPersistence, GAME_STATE_LIFECYCLE_KEYS } from "./stateLifecycle";

describe("GameState lifecycle boundaries", () => {
  it("classifies every flat GameState field exactly once", () => {
    const stateKeys = Object.keys(createInitialState()).sort();
    const lifecycleKeys = Object.values(GAME_STATE_LIFECYCLE_KEYS).flat();
    expect(new Set(lifecycleKeys).size).toBe(lifecycleKeys.length);
    expect([...lifecycleKeys].sort()).toEqual(stateKeys);
  });

  it("clones the persistence boundary without changing its historical exclusions", () => {
    const state = createInitialState();
    state.floatingEvents.push({
      id: "runtime-event",
      catId: state.cats[0].id,
      text: "runtime",
      createdAt: 0,
      duration: 1_000,
      kind: "speech",
    });
    const legacyCat = state.cats[0] as typeof state.cats[0] & { lawPolicy?: unknown };
    legacyCat.lawPolicy = { priceMultipliers: { wood: 9 } };

    const snapshot = cloneGameStateForPersistence(state) as typeof state & {
      cats: Array<typeof state.cats[number] & { lawPolicy?: unknown }>;
    };
    expect(snapshot).not.toBe(state);
    expect(snapshot.floatingEvents).toEqual([]);
    expect(snapshot.cats.every((cat) => !Object.prototype.hasOwnProperty.call(cat, "lawPolicy"))).toBe(true);
    expect(state.floatingEvents).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(state.cats[0], "lawPolicy")).toBe(true);
  });
});
