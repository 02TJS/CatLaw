import { describe, expect, it } from "vitest";
import {
  advanceGame,
  catWealthScoreCents,
  createInitialState,
  WEALTH_HISTORY_MAX_WINDOW_MS,
  WEALTH_HISTORY_SAMPLE_INTERVAL_MS,
} from "./engine";
import { migrateSaveSnapshot } from "./persistence";

describe("persistent recent wealth history", () => {
  it("samples on deterministic five-second simulation boundaries", () => {
    const state = createInitialState({ worldSeed: 12345 });
    expect(state.wealthHistory.map((sample) => sample.at)).toEqual([0]);

    advanceGame(state, WEALTH_HISTORY_SAMPLE_INTERVAL_MS - 1);
    expect(state.wealthHistory.map((sample) => sample.at)).toEqual([0]);

    advanceGame(state, 1);
    expect(state.wealthHistory.map((sample) => sample.at)).toEqual([0, 5_000]);
    expect(state.wealthHistory.at(-1)?.values[state.cats[0].id]).toBe(catWealthScoreCents(state, state.cats[0]));
  });

  it("keeps one baseline interval beyond the adjustable five-minute window", () => {
    const state = createInitialState({ worldSeed: 12345 });
    advanceGame(state, WEALTH_HISTORY_MAX_WINDOW_MS + 10_000);

    expect(state.wealthHistory.at(-1)?.at).toBe(state.simTime);
    expect(state.wealthHistory[0].at).toBeGreaterThanOrEqual(
      state.simTime - WEALTH_HISTORY_MAX_WINDOW_MS - WEALTH_HISTORY_SAMPLE_INTERVAL_MS,
    );
    expect(state.wealthHistory.length).toBeLessThanOrEqual(
      WEALTH_HISTORY_MAX_WINDOW_MS / WEALTH_HISTORY_SAMPLE_INTERVAL_MS + 2,
    );
  });

  it("upgrades a schema-15 save with a current non-offline baseline", () => {
    const raw: any = structuredClone(createInitialState({ worldSeed: 9876 }));
    raw.schemaVersion = 15;
    raw.simTime = 12_345;
    delete raw.wealthHistory;

    const migrated = migrateSaveSnapshot(raw);
    expect(migrated.schemaVersion).toBe(17);
    expect(migrated.wealthHistory).toHaveLength(1);
    expect(migrated.wealthHistory[0].at).toBe(12_345);
    expect(migrated.wealthHistory[0].values[migrated.cats[0].id]).toBe(
      catWealthScoreCents(migrated, migrated.cats[0]),
    );
  });
});
