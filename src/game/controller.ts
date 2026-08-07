import { acknowledgeAchievement, advanceGame, buyAllCatStock, buyAllCatStockAndSell, buyBuildingOffer, buyCatItem, buyLandmarkBlueprint, buyWarehouseItem, cancelBuildingOrder, createInitialState, createPlayerResource, dismantleBuilding, dismantleLandmark, enactLaw, expandParcel, placeCat, placeLandmark, placeNamedLandmark, placeOwnedBuilding, queueBuildingOrder, recordPlayerCommand, removeCat, removeResource, renameLandmark, reorderLaw, repealLaw, sellAllUnlockedWarehouseItems, sellWarehouseItem, setPaused, setSpeechFrequency, toggleWarehouseItemLock, unlockRecipe } from "./engine";
import { clearSave, loadGame, saveGame } from "./persistence";
import type { GameState, LandmarkId, LawDraft, Position } from "./types";
import { randomWorldSeed } from "./world";
import type { DifficultyLevel } from "./types";
import {
  normalizeRuntimeSpeedMultiplier,
  RUNTIME_SPEED_MULTIPLIERS,
  type RuntimeSpeedMultiplier,
} from "./domainUnits";

type Listener = () => void;

export class GameController {
  state: GameState = createInitialState();
  private listeners = new Set<Listener>();
  private animationFrame = 0;
  private lastFrame = 0;
  private lastNotify = 0;
  private lastSave = 0;
  private loaded = false;
  private revision = 0;
  private lastSavedRevision = -1;
  private saveInFlight: Promise<void> | null = null;
  private saveQueued = false;
  private runtimeSpeedMultiplier: RuntimeSpeedMultiplier = 1;
  private runtimeBlocked = false;

  static readonly RUNTIME_SPEED_PRESETS = RUNTIME_SPEED_MULTIPLIERS;
  /** @deprecated Compatibility alias; use RUNTIME_SPEED_PRESETS. */
  static readonly SPEED_PRESETS = GameController.RUNTIME_SPEED_PRESETS;

  async initialize(): Promise<void> {
    this.state = await loadGame(randomWorldSeed());
    this.loaded = true;
    this.lastFrame = performance.now();
    this.animationFrame = requestAnimationFrame(this.loop);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.onPageHide);
    this.emit();
  }

  destroy(): void {
    this.queueSave(true);
    cancelAnimationFrame(this.animationFrame);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.onPageHide);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRevision = (): number => this.revision;

  private emit(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  private loop = (now: number): void => {
    const delta = Math.max(0, Math.min(100, now - this.lastFrame));
    this.lastFrame = now;
    const simulated = !document.hidden && !this.runtimeBlocked && !this.state.paused;
    if (simulated) advanceGame(this.state, delta * this.runtimeSpeedMultiplier);
    if (simulated && now - this.lastNotify >= 100) {
      this.lastNotify = now;
      this.emit();
    }
    if (this.loaded && now - this.lastSave >= 1_000) {
      this.lastSave = now;
      this.queueSave();
    }
    this.animationFrame = requestAnimationFrame(this.loop);
  };

  private queueSave(force = false): void {
    if (!this.loaded) return;
    if (this.saveInFlight) {
      this.saveQueued = this.saveQueued || force || this.revision > this.lastSavedRevision;
      return;
    }
    if (!force && this.revision <= this.lastSavedRevision) return;
    const savingRevision = this.revision;
    this.saveInFlight = saveGame(this.state)
      .then(() => {
        this.lastSavedRevision = Math.max(this.lastSavedRevision, savingRevision);
      })
      .catch((error) => {
        console.error("猫咪工坊自动存档失败", error);
      })
      .finally(() => {
        this.saveInFlight = null;
        if (!this.saveQueued) return;
        this.saveQueued = false;
        this.queueSave(true);
      });
  }

  private async flushSaves(): Promise<void> {
    while (this.saveInFlight) await this.saveInFlight;
  }

  private onVisibility = (): void => {
    this.lastFrame = performance.now();
    if (document.hidden) this.queueSave(true);
  };

  private onPageHide = (): void => {
    this.queueSave(true);
  };

  advance(ms: number): void {
    if (this.runtimeBlocked) return;
    advanceGame(this.state, ms * this.runtimeSpeedMultiplier);
    recordPlayerCommand(this.state, "advance-time", String(ms), true);
    this.emit();
  }

  getSpeedMultiplier(): RuntimeSpeedMultiplier {
    return this.runtimeSpeedMultiplier;
  }

  getRuntimeSpeedMultiplier(): RuntimeSpeedMultiplier {
    return this.runtimeSpeedMultiplier;
  }

  setRuntimeBlocked(blocked: boolean): void {
    if (blocked === this.runtimeBlocked) return;
    this.runtimeBlocked = blocked;
    this.lastFrame = performance.now();
    this.emit();
  }

  setRuntimeSpeedMultiplier(multiplier: RuntimeSpeedMultiplier): void {
    const next = multiplier;
    if (next === this.runtimeSpeedMultiplier) return;
    this.runtimeSpeedMultiplier = next;
    this.emit();
  }

  /** Compatibility boundary for the existing QA API and callers with arbitrary numbers. */
  setSpeed(multiplier: number): void {
    this.setRuntimeSpeedMultiplier(normalizeRuntimeSpeedMultiplier(multiplier));
  }

  togglePause(): void {
    setPaused(this.state, !this.state.paused);
    recordPlayerCommand(this.state, "set-paused", String(this.state.paused), true);
    this.emit();
  }

  setSpeechFrequency(frequency: number): number {
    const normalized = setSpeechFrequency(this.state, frequency);
    recordPlayerCommand(this.state, "set-speech-frequency", String(normalized), true);
    this.emit();
    return normalized;
  }

  addCat(position: Position): boolean {
    const result = Boolean(placeCat(this.state, position));
    recordPlayerCommand(this.state, "place-cat", `${position.x},${position.y}`, result);
    if (result) this.emit();
    return result;
  }

  removeCat(catId: string) {
    const result = removeCat(this.state, catId);
    recordPlayerCommand(this.state, "remove-cat", catId, result.ok, result.error);
    this.emit();
    return result;
  }

  enact(draft: LawDraft, insertionIndex = 0) {
    const result = enactLaw(this.state, draft, insertionIndex);
    recordPlayerCommand(this.state, "enact-law", draft.title, result.ok, result.error);
    this.emit();
    return result;
  }

  reorder(lawId: string, delta: -1 | 1): void {
    const ok = reorderLaw(this.state, lawId, delta);
    recordPlayerCommand(this.state, "reorder-law", lawId, ok, String(delta));
    this.emit();
  }

  repeal(lawId: string) {
    const result = repealLaw(this.state, lawId);
    recordPlayerCommand(this.state, "repeal-law", lawId, result.ok, result.error);
    this.emit();
    return result;
  }

  unlockRecipe(recipeId: string) {
    const result = unlockRecipe(this.state, recipeId);
    recordPlayerCommand(this.state, "buy-recipe", recipeId, result.ok, result.error);
    this.emit();
    return result;
  }

  expandParcel(parcel: Position) {
    const result = expandParcel(this.state, parcel);
    recordPlayerCommand(this.state, "expand-parcel", `${parcel.x},${parcel.y}`, result.ok, result.error);
    this.emit();
    return result;
  }

  queueBuilding(targetCatId: string, itemId: string) {
    const result = queueBuildingOrder(this.state, targetCatId, itemId);
    recordPlayerCommand(this.state, "queue-building", `${targetCatId}:${itemId}`, result.ok, result.error);
    this.emit();
    return result;
  }

  cancelBuilding(orderId: string) {
    const result = cancelBuildingOrder(this.state, orderId);
    recordPlayerCommand(this.state, "cancel-building", orderId, result.ok, result.error);
    this.emit();
    return result;
  }

  buyBuilding(offerId: string) {
    const result = buyBuildingOffer(this.state, offerId);
    recordPlayerCommand(this.state, "buy-building", offerId, result.ok, result.error);
    this.emit();
    return result;
  }

  buyWarehouseItem(itemId: string) {
    const result = buyWarehouseItem(this.state, itemId);
    recordPlayerCommand(this.state, "buy-cat-stock", `warehouse:${itemId}`, result.ok, result.error);
    this.emit();
    return result;
  }

  buyCatItem(catId: string, itemId: string) {
    const result = buyCatItem(this.state, catId, itemId);
    recordPlayerCommand(this.state, "buy-cat-stock", `${catId}:${itemId}`, result.ok, result.error);
    this.emit();
    return result;
  }

  buyAllCatStock() {
    const result = buyAllCatStock(this.state);
    recordPlayerCommand(this.state, "buy-cat-stock", "all", result.ok, result.error);
    this.emit();
    return result;
  }

  buyAllCatStockAndSell() {
    const result = buyAllCatStockAndSell(this.state);
    recordPlayerCommand(this.state, "buy-cat-stock", "all-and-sell", result.ok, result.error);
    this.emit();
    return result;
  }

  sellWarehouseItem(itemId: string, quantity = 1) {
    const result = sellWarehouseItem(this.state, itemId, quantity);
    recordPlayerCommand(this.state, "sell-warehouse", `${itemId}:${quantity}`, result.ok, result.error);
    this.emit();
    return result;
  }

  sellAllUnlockedWarehouseItems() {
    const result = sellAllUnlockedWarehouseItems(this.state);
    recordPlayerCommand(this.state, "sell-warehouse", "all-unlocked", result.ok, result.error);
    this.emit();
    return result;
  }

  toggleWarehouseItemLock(itemId: string) {
    const result = toggleWarehouseItemLock(this.state, itemId);
    recordPlayerCommand(this.state, "toggle-warehouse-lock", itemId, result.ok, result.error);
    this.emit();
    return result;
  }

  acknowledgeAchievement(achievementId: string): boolean {
    const ok = acknowledgeAchievement(this.state, achievementId);
    recordPlayerCommand(this.state, "ack-achievement", achievementId, ok);
    if (ok) this.emit();
    return ok;
  }

  placeBuilding(itemId: string, position: Position) {
    const result = placeOwnedBuilding(this.state, itemId, position);
    recordPlayerCommand(this.state, "place-building", `${itemId}@${position.x},${position.y}`, result.ok, result.error);
    this.emit();
    return result;
  }

  dismantleBuilding(buildingId: string) {
    const result = dismantleBuilding(this.state, buildingId);
    recordPlayerCommand(this.state, "dismantle-building", buildingId, result.ok, result.error);
    this.emit();
    return result;
  }

  buyLandmarkBlueprint(landmarkId: LandmarkId) {
    const result = buyLandmarkBlueprint(this.state, landmarkId);
    recordPlayerCommand(this.state, "buy-landmark-blueprint", landmarkId, result.ok, result.error);
    this.emit();
    return result;
  }

  placeLandmark(landmarkId: LandmarkId, position: Position) {
    const result = placeLandmark(this.state, landmarkId, position);
    recordPlayerCommand(this.state, "place-landmark", `${landmarkId}@${position.x},${position.y}`, result.ok, result.error);
    this.emit();
    return result;
  }

  placeNamedLandmark(name: string, position: Position) {
    const result = placeNamedLandmark(this.state, name, position);
    recordPlayerCommand(this.state, "place-landmark", `${name}@${position.x},${position.y}`, result.ok, result.error);
    this.emit();
    return result;
  }

  renameLandmark(deployedId: string, name: string) {
    const result = renameLandmark(this.state, deployedId, name);
    recordPlayerCommand(this.state, "rename-landmark", `${deployedId}:${name}`, result.ok, result.error);
    this.emit();
    return result;
  }

  dismantleLandmark(deployedId: string) {
    const result = dismantleLandmark(this.state, deployedId);
    recordPlayerCommand(this.state, "dismantle-landmark", deployedId, result.ok, result.error);
    this.emit();
    return result;
  }

  createResource(itemId: string, position: Position) {
    const result = createPlayerResource(this.state, itemId, position);
    recordPlayerCommand(this.state, "create-resource", `${itemId}@${position.x},${position.y}`, result.ok, result.error);
    this.emit();
    return result;
  }

  removeResource(resourceId: string) {
    const result = removeResource(this.state, resourceId);
    recordPlayerCommand(this.state, "remove-resource", resourceId, result.ok, result.error);
    this.emit();
    return result;
  }

  async reset(difficulty?: DifficultyLevel): Promise<void> {
    this.loaded = false;
    this.saveQueued = false;
    await this.flushSaves();
    await clearSave();
    this.state = createInitialState({ worldSeed: randomWorldSeed(), difficulty });
    this.runtimeSpeedMultiplier = 1;
    this.lastSavedRevision = -1;
    this.lastSave = performance.now();
    this.loaded = true;
    this.emit();
  }
}
