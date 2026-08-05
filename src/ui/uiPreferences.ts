export const UI_PREFERENCES_STORAGE_KEY = "cat-workshop-ui-preferences-v1";

export const CONTROL_SCALE_MIN = 0.5;
export const CONTROL_SCALE_MAX = 1.8;
export const INTERFACE_FONT_SCALE_MIN = 0.5;
export const INTERFACE_FONT_SCALE_MAX = 2.2;
export const SPEECH_BUBBLE_SCALE_MIN = 0.5;
export const SPEECH_BUBBLE_SCALE_MAX = 2.2;
export const MAP_SCALE_MIN = 0.5;
export const MAP_SCALE_MAX = 2;

export interface UiPreferences {
  controlScale: number;
  interfaceFontScale: number;
  speechBubbleScale: number;
  mapScale: number;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  controlScale: 1,
  interfaceFontScale: 1,
  speechBubbleScale: 1,
  mapScale: 1,
};

export function normalizeUiPreferences(input: unknown): UiPreferences {
  const candidate = input && typeof input === "object"
    ? input as Partial<UiPreferences> & { fontScale?: number }
    : {};
  const legacyFontScale = candidate.fontScale;
  return {
    controlScale: normalizeScale(candidate.controlScale, CONTROL_SCALE_MIN, CONTROL_SCALE_MAX),
    interfaceFontScale: normalizeScale(candidate.interfaceFontScale ?? legacyFontScale, INTERFACE_FONT_SCALE_MIN, INTERFACE_FONT_SCALE_MAX),
    speechBubbleScale: normalizeScale(candidate.speechBubbleScale ?? legacyFontScale, SPEECH_BUBBLE_SCALE_MIN, SPEECH_BUBBLE_SCALE_MAX),
    mapScale: normalizeScale(candidate.mapScale, MAP_SCALE_MIN, MAP_SCALE_MAX),
  };
}

export function parseUiPreferences(raw: string | null): UiPreferences {
  if (!raw) return { ...DEFAULT_UI_PREFERENCES };
  try {
    return normalizeUiPreferences(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_UI_PREFERENCES };
  }
}

export function serializeUiPreferences(preferences: UiPreferences): string {
  return JSON.stringify(normalizeUiPreferences(preferences));
}

function normalizeScale(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.round(Math.max(minimum, Math.min(maximum, value)) * 20) / 20;
}
