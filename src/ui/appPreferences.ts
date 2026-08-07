import { useEffect } from "react";
import {
  DEFAULT_UI_PREFERENCES,
  parseUiPreferences,
  serializeUiPreferences,
  UI_PREFERENCES_STORAGE_KEY,
  type UiPreferences,
} from "./uiPreferences";
import {
  DEFAULT_WEALTH_LENS_WINDOW_MS,
  WEALTH_LENS_WINDOW_OPTIONS_MS,
  type WealthLensMode,
} from "./mapLenses";

export const WEALTH_LENS_PREFERENCES_KEY = "cat-workshop-wealth-lens-v1";

export function loadUiPreferences(): UiPreferences {
  try {
    return parseUiPreferences(window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_UI_PREFERENCES };
  }
}

export function loadWealthLensPreferences(): { mode: WealthLensMode; windowMs: number } {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(WEALTH_LENS_PREFERENCES_KEY) ?? "null");
    const mode: WealthLensMode = parsed?.mode === "change" ? "change" : "total";
    const windowMs = WEALTH_LENS_WINDOW_OPTIONS_MS.includes(parsed?.windowMs)
      ? parsed.windowMs
      : DEFAULT_WEALTH_LENS_WINDOW_MS;
    return { mode, windowMs };
  } catch {
    return { mode: "total", windowMs: DEFAULT_WEALTH_LENS_WINDOW_MS };
  }
}

export function useAppPreferencePersistence(
  uiPreferences: UiPreferences,
  uiPreferencesRef: { current: UiPreferences },
  wealthLensMode: WealthLensMode,
  wealthLensWindowMs: number,
): void {
  useEffect(() => {
    uiPreferencesRef.current = uiPreferences;
    try {
      window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, serializeUiPreferences(uiPreferences));
    } catch {
      // Private browsing or a locked profile must not prevent the game from running.
    }
  }, [uiPreferences]);

  useEffect(() => {
    try {
      window.localStorage.setItem(WEALTH_LENS_PREFERENCES_KEY, JSON.stringify({ mode: wealthLensMode, windowMs: wealthLensWindowMs }));
    } catch {
      // A locked profile must not prevent the lens itself from working.
    }
  }, [wealthLensMode, wealthLensWindowMs]);
}
