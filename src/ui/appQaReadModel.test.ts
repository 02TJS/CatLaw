import { describe, expect, it } from "vitest";
import { createInitialState } from "../game/engine";
import { DEFAULT_UI_PREFERENCES } from "./uiPreferences";
import { renderGameToText } from "./appQaReadModel";

describe("app QA read model", () => {
  it("keeps the established serialized world and runtime contract deterministic", () => {
    const state = createInitialState({ worldSeed: 402, difficulty: 3 });
    state.simTime = 12_345.6;
    const args = [
      state,
      4,
      state.cats[0].id,
      null,
      null,
      null,
      null,
      DEFAULT_UI_PREFERENCES,
      false,
      "none",
      null,
      "total",
      60_000,
      null,
      false,
    ] as const;

    const first = renderGameToText(...args);
    const second = renderGameToText(...args);
    const model = JSON.parse(first);

    expect(second).toBe(first);
    expect(model).toMatchObject({
      coordinateSystem: "整数方格；原点(0,0)；x向右增加，y向下增加；只可向四邻传递",
      simTimeMs: 12_346,
      difficulty: { level: 3 },
      runtimeSpeedMultiplier: 4,
      world: {
        mapInteractionMode: false,
        mapLens: { id: "none", title: "普通地图" },
        parcelSize: 9,
        worldSeed: 402,
      },
    });
    expect(model.cats[0]).toMatchObject({ id: state.cats[0].id, selected: true });
    expect(model.visualPreferences).toMatchObject(DEFAULT_UI_PREFERENCES);
  });
});
