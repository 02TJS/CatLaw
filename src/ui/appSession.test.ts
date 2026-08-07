import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameController } from "../game/controller";
import { createInitialState } from "../game/engine";
import { DEFAULT_UI_PREFERENCES } from "./uiPreferences";
import { startAppSession, type AppSessionBindings } from "./appSession";

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
});

describe("app session", () => {
  it("preserves initialization, shortcuts, QA bridge, escape order, and cleanup", () => {
    const listeners = new Map<string, EventListener>();
    const clearTimeout = vi.fn();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: vi.fn((name: string, listener: EventListener) => listeners.set(name, listener)),
        removeEventListener: vi.fn((name: string) => listeners.delete(name)),
        clearTimeout,
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { fullscreenElement: null, getElementById: vi.fn(() => null) },
    });

    const calls: string[] = [];
    const controller = {
      state: createInitialState({ worldSeed: 403 }),
      setRuntimeBlocked: vi.fn((blocked: boolean) => calls.push(`blocked:${blocked}`)),
      initialize: vi.fn(async () => { calls.push("initialize"); }),
      destroy: vi.fn(() => calls.push("destroy")),
      advance: vi.fn(),
      getSpeedMultiplier: vi.fn(() => 1),
      getRuntimeSpeedMultiplier: vi.fn(() => 1),
      reset: vi.fn(),
      setSpeed: vi.fn((speed: number) => calls.push(`speed:${speed}`)),
      setRuntimeSpeedMultiplier: vi.fn((speed: number) => calls.push(`speed:${speed}`)),
      setSpeechFrequency: vi.fn(),
      removeCat: vi.fn(),
      placeNamedLandmark: vi.fn(),
      renameLandmark: vi.fn(),
      dismantleLandmark: vi.fn(),
      createResource: vi.fn(),
      removeResource: vi.fn(),
      buyCatItem: vi.fn(),
      buyAllCatStock: vi.fn(),
      buyAllCatStockAndSell: vi.fn(),
      sellWarehouseItem: vi.fn(),
      sellAllUnlockedWarehouseItems: vi.fn(),
      toggleWarehouseItemLock: vi.fn(),
      acknowledgeAchievement: vi.fn(),
      togglePause: vi.fn(() => calls.push("pause")),
    } as unknown as GameController;
    const setter = (name: string) => vi.fn((value: unknown) => calls.push(`${name}:${String(value)}`));
    const pickerOpen = { current: true };
    const bindings: AppSessionBindings = {
      selectedCatRef: { current: "cat-0" },
      placingBuildingRef: { current: null },
      placementFeedbackRef: { current: null },
      placingLandmarkRef: { current: null },
      landmarkFeedbackRef: { current: null },
      uiPreferencesRef: { current: DEFAULT_UI_PREFERENCES },
      expansionModeRef: { current: false },
      mapLensIdRef: { current: "none" },
      mapLensItemIdRef: { current: null },
      wealthLensModeRef: { current: "total" },
      wealthLensWindowMsRef: { current: 60_000 },
      commerceFeedbackRef: { current: null },
      achievementReviewArmedRef: { current: false },
      mapLensItemPickerOpenRef: pickerOpen,
      commerceFeedbackTimer: { current: 99 },
      setMapLensItemPickerOpen: setter("picker"),
      setExpansionMode: setter("expansion"),
      setMapLensPaletteOpen: setter("palette"),
      setMapLensId: setter("lens"),
      setPlacingBuildingItemId: setter("building"),
      setPlacingLandmarkId: setter("landmark"),
    };

    const cleanup = startAppSession(controller, bindings);
    const keydown = listeners.get("keydown") as (event: KeyboardEvent) => void;
    keydown({ key: "p", target: null, preventDefault: vi.fn() } as unknown as KeyboardEvent);
    keydown({ key: "2", target: null, preventDefault: vi.fn() } as unknown as KeyboardEvent);
    keydown({ key: "Escape", target: null, preventDefault: vi.fn() } as unknown as KeyboardEvent);
    pickerOpen.current = false;
    keydown({ key: "Escape", target: null, preventDefault: vi.fn() } as unknown as KeyboardEvent);
    cleanup();

    expect(calls).toEqual([
      "blocked:false", "initialize", "pause", "speed:2", "picker:false",
      "expansion:false", "palette:false", "lens:none", "building:null", "landmark:null", "destroy",
    ]);
    expect(typeof window.advanceTime).toBe("function");
    expect(typeof window.render_game_to_text).toBe("function");
    expect(window.__CAT_WORKSHOP__).toBeDefined();
    expect(clearTimeout).toHaveBeenCalledWith(99);
    expect(listeners.has("keydown")).toBe(false);
  });
});
