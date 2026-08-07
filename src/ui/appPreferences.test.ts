import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_WEALTH_LENS_WINDOW_MS } from "./mapLenses";
import { DEFAULT_UI_PREFERENCES } from "./uiPreferences";
import {
  loadUiPreferences,
  loadWealthLensPreferences,
  WEALTH_LENS_PREFERENCES_KEY,
} from "./appPreferences";

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

function installStorage(values: Record<string, string>, throws = false): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem(key: string) {
          if (throws) throw new Error("locked");
          return values[key] ?? null;
        },
      },
    },
  });
}

describe("app preferences", () => {
  it("loads UI preferences through the existing normalization contract", () => {
    installStorage({
      "cat-workshop-ui-preferences-v1": JSON.stringify({
        controlScale: 1.26,
        interfaceFontScale: 2.4,
        speechBubbleScale: 0.2,
        mapScale: 1.53,
      }),
    });

    expect(loadUiPreferences()).toEqual({
      controlScale: 1.25,
      interfaceFontScale: 2.2,
      speechBubbleScale: 0.5,
      mapScale: 1.55,
    });
  });

  it("preserves valid wealth settings and falls back for invalid or locked storage", () => {
    installStorage({
      [WEALTH_LENS_PREFERENCES_KEY]: JSON.stringify({ mode: "change", windowMs: 30_000 }),
    });
    expect(loadWealthLensPreferences()).toEqual({ mode: "change", windowMs: 30_000 });

    installStorage({ [WEALTH_LENS_PREFERENCES_KEY]: "{" });
    expect(loadWealthLensPreferences()).toEqual({ mode: "total", windowMs: DEFAULT_WEALTH_LENS_WINDOW_MS });

    installStorage({}, true);
    expect(loadUiPreferences()).toEqual(DEFAULT_UI_PREFERENCES);
    expect(loadWealthLensPreferences()).toEqual({ mode: "total", windowMs: DEFAULT_WEALTH_LENS_WINDOW_MS });
  });
});
