import { describe, expect, it } from "vitest";
import {
  DEFAULT_UI_PREFERENCES,
  normalizeUiPreferences,
  parseUiPreferences,
  serializeUiPreferences,
} from "./uiPreferences";

describe("desktop-pet visual preferences", () => {
  it("falls back safely for missing or malformed storage", () => {
    expect(parseUiPreferences(null)).toEqual(DEFAULT_UI_PREFERENCES);
    expect(parseUiPreferences("not json")).toEqual(DEFAULT_UI_PREFERENCES);
  });

  it("clamps and rounds all four visual scales independently", () => {
    expect(normalizeUiPreferences({
      controlScale: 0.1,
      interfaceFontScale: 9,
      speechBubbleScale: 0.2,
      mapScale: 8,
    })).toEqual({
      controlScale: 0.5,
      interfaceFontScale: 2.2,
      speechBubbleScale: 0.5,
      mapScale: 2,
    });
    expect(normalizeUiPreferences({
      controlScale: 1.234,
      interfaceFontScale: 1.471,
      speechBubbleScale: 1.829,
      mapScale: 0.876,
    })).toEqual({
      controlScale: 1.25,
      interfaceFontScale: 1.45,
      speechBubbleScale: 1.85,
      mapScale: 0.9,
    });
  });

  it("round-trips valid scales without coupling their values", () => {
    const preferences = {
      controlScale: 1.3,
      interfaceFontScale: 0.85,
      speechBubbleScale: 1.75,
      mapScale: 1.4,
    };
    expect(parseUiPreferences(serializeUiPreferences(preferences))).toEqual(preferences);
  });

  it("migrates the former shared font scale into both independent font controls", () => {
    expect(parseUiPreferences(JSON.stringify({ controlScale: 1.2, fontScale: 1.55 }))).toEqual({
      controlScale: 1.2,
      interfaceFontScale: 1.55,
      speechBubbleScale: 1.55,
      mapScale: 1,
    });
  });
});
