import { advanceGame, buyBuildingOffer, buyWarehouseItem, cancelBuildingOrder, createInitialState, dismantleBuilding, enactLaw, expandParcel, placeCat, placeOwnedBuilding, queueBuildingOrder, reorderLaw, repealLaw, setPaused, unlockRecipe } from "./engine";
import { clearSave, loadGame, saveGame } from "./persistence";
import type { GameState, LawDraft, Position } from "./types";
import { randomWorldSeed } from "./world";
import type { DifficultyLevel } from "./types";

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
    if (!document.hidden) advanceGame(this.state, delta);
    if (now - this.lastNotify >= 100) {
      this.lastNotify = now;
      this.emit();
    }
    if (this.loaded && now - this.lastSave >= 1_000) {
      this.lastSave = now;
      void saveGame(this.state);
    }
    this.animationFrame = requestAnimationFrame(this.loop);
  };

  private onVisibility = (): void => {
    this.lastFrame = performance.now();
    if (document.hidden) void saveGame(this.state);
  };

  private onPageHide = (): void => {
    void saveGame(this.state);
  };

  advance(ms: number): void {
    advanceGame(this.state, ms);
    this.emit();
  }

  togglePause(): void {
    setPaused(this.state, !this.state.paused);
    this.emit();
  }

  addCat(position: Position): boolean {
    const result = Boolean(placeCat(this.state, position));
    if (result) this.emit();
    return result;
  }

  enact(draft: LawDraft, insertionIndex = 0) {
    const result = enactLaw(this.state, draft, insertionIndex);
    this.emit();
    return result;
  }

  reorder(lawId: string, delta: -1 | 1): void {
    reorderLaw(this.state, lawId, delta);
    this.emit();
  }

  repeal(lawId: string) {
    const result = repealLaw(this.state, lawId);
    this.emit();
    return result;
  }

  unlockRecipe(recipeId: string) {
    const result = unlockRecipe(this.state, recipeId);
    this.emit();
    return result;
  }

  expandParcel(parcel: Position) {
    const result = expandParcel(this.state, parcel);
    this.emit();
    return result;
  }

  queueBuilding(targetCatId: string, itemId: string) {
    const result = queueBuildingOrder(this.state, targetCatId, itemId);
    this.emit();
    return result;
  }

  cancelBuilding(orderId: string) {
    const result = cancelBuildingOrder(this.state, orderId);
    this.emit();
    return result;
  }

  buyBuilding(offerId: string) {
    const result = buyBuildingOffer(this.state, offerId);
    this.emit();
    return result;
  }

  buyWarehouseItem(itemId: string) {
    const result = buyWarehouseItem(this.state, itemId);
    this.emit();
    return result;
  }

  placeBuilding(itemId: string, position: Position) {
    const result = placeOwnedBuilding(this.state, itemId, position);
    this.emit();
    return result;
  }

  dismantleBuilding(buildingId: string) {
    const result = dismantleBuilding(this.state, buildingId);
    this.emit();
    return result;
  }

  async reset(difficulty?: DifficultyLevel): Promise<void> {
    await clearSave();
    this.state = createInitialState({ worldSeed: randomWorldSeed(), difficulty });
    this.emit();
  }
}
