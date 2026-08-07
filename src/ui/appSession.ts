import type { Dispatch, SetStateAction } from "react";
import type { GameController } from "../game/controller";
import type { LandmarkId } from "../game/types";
import type { MapLensId, WealthLensMode } from "./mapLenses";
import type { UiPreferences } from "./uiPreferences";
import type {
  CommerceFeedback,
  LandmarkPlacementFeedback,
  PlacementFeedback,
} from "./appTypes";
import { renderGameToText } from "./appQaReadModel";
import type { RuntimeSpeedMultiplier } from "../game/domainUnits";

export interface AppSessionBindings {
  selectedCatRef: { current: string };
  placingBuildingRef: { current: string | null };
  placementFeedbackRef: { current: PlacementFeedback | null };
  placingLandmarkRef: { current: LandmarkId | null };
  landmarkFeedbackRef: { current: LandmarkPlacementFeedback | null };
  uiPreferencesRef: { current: UiPreferences };
  expansionModeRef: { current: boolean };
  mapLensIdRef: { current: MapLensId };
  mapLensItemIdRef: { current: string | null };
  wealthLensModeRef: { current: WealthLensMode };
  wealthLensWindowMsRef: { current: number };
  commerceFeedbackRef: { current: CommerceFeedback | null };
  achievementReviewArmedRef: { current: boolean };
  mapLensItemPickerOpenRef: { current: boolean };
  commerceFeedbackTimer: { current: number | null };
  setMapLensItemPickerOpen: Dispatch<SetStateAction<boolean>>;
  setExpansionMode: Dispatch<SetStateAction<boolean>>;
  setMapLensPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setMapLensId: Dispatch<SetStateAction<MapLensId>>;
  setPlacingBuildingItemId: Dispatch<SetStateAction<string | null>>;
  setPlacingLandmarkId: Dispatch<SetStateAction<LandmarkId | null>>;
}

export function startAppSession(
  controller: GameController,
  bindings: AppSessionBindings,
): () => void {
  controller.setRuntimeBlocked(false);
  void controller.initialize();
  window.advanceTime = (ms) => controller.advance(ms);
  window.render_game_to_text = () => renderGameToText(
    controller.state,
    controller.getRuntimeSpeedMultiplier(),
    bindings.selectedCatRef.current,
    bindings.placingBuildingRef.current,
    bindings.placementFeedbackRef.current,
    bindings.placingLandmarkRef.current,
    bindings.landmarkFeedbackRef.current,
    bindings.uiPreferencesRef.current,
    bindings.expansionModeRef.current,
    bindings.mapLensIdRef.current,
    bindings.mapLensItemIdRef.current,
    bindings.wealthLensModeRef.current,
    bindings.wealthLensWindowMsRef.current,
    bindings.commerceFeedbackRef.current,
    bindings.achievementReviewArmedRef.current,
  );
  window.__CAT_WORKSHOP__ = {
    reset: (difficulty) => controller.reset(difficulty),
    state: () => structuredClone(controller.state),
    setSpeed: (multiplier) => controller.setSpeed(multiplier),
    setSpeechFrequency: (frequency) => controller.setSpeechFrequency(frequency),
    removeCat: (catId) => controller.removeCat(catId),
    placeNamedLandmark: (name, position) => controller.placeNamedLandmark(name, position),
    renameLandmark: (landmarkId, name) => controller.renameLandmark(landmarkId, name),
    dismantleLandmark: (landmarkId) => controller.dismantleLandmark(landmarkId),
    createResource: (itemId, position) => controller.createResource(itemId, position),
    removeResource: (resourceId) => controller.removeResource(resourceId),
    buyCatItem: (catId, itemId) => controller.buyCatItem(catId, itemId),
    buyAllCatStock: () => controller.buyAllCatStock(),
    buyAllCatStockAndSell: () => controller.buyAllCatStockAndSell(),
    sellWarehouseItem: (itemId, quantity) => controller.sellWarehouseItem(itemId, quantity),
    sellAllUnlockedWarehouseItems: () => controller.sellAllUnlockedWarehouseItems(),
    toggleWarehouseItemLock: (itemId) => controller.toggleWarehouseItemLock(itemId),
    acknowledgeAchievement: (achievementId) => controller.acknowledgeAchievement(achievementId),
  };
  const onKey = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const typing = Boolean(target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
    if (!typing && event.key.toLowerCase() === "p") {
      event.preventDefault();
      controller.togglePause();
      return;
    }
    if (!typing) {
      const speedByKey: Record<string, RuntimeSpeedMultiplier> = { "1": 1, "2": 2, "3": 4, "4": 8 };
      const nextSpeed = speedByKey[event.key];
      if (nextSpeed) {
        controller.setRuntimeSpeedMultiplier(nextSpeed);
        return;
      }
    }
    if (event.key === "Escape") {
      if (bindings.mapLensItemPickerOpenRef.current) {
        bindings.setMapLensItemPickerOpen(false);
        return;
      }
      bindings.setExpansionMode(false);
      bindings.setMapLensPaletteOpen(false);
      bindings.setMapLensId("none");
      bindings.setPlacingBuildingItemId(null);
      bindings.setPlacingLandmarkId(null);
    }
    if (event.key.toLowerCase() === "f" && !["INPUT", "TEXTAREA"].includes((event.target as HTMLElement)?.tagName)) {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.getElementById("game-shell")?.requestFullscreen();
    }
  };
  window.addEventListener("keydown", onKey);
  return () => {
    if (bindings.commerceFeedbackTimer.current !== null) window.clearTimeout(bindings.commerceFeedbackTimer.current);
    controller.destroy();
    window.removeEventListener("keydown", onKey);
  };
}
