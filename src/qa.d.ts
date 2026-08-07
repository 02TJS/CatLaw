import type { DifficultyLevel, GameState, ItemId, Position } from "./game/types";

export {};

declare global {
  interface Window {
    advanceTime: (ms: number) => void;
    render_game_to_text: () => string;
    __CAT_WORKSHOP__?: {
      reset: (difficulty?: DifficultyLevel) => Promise<void>;
      state: () => GameState;
      setSpeed: (multiplier: number) => void;
      setSpeechFrequency: (frequency: number) => number;
      removeCat: (catId: string) => { ok: boolean; error?: string; settledCents?: number; debtRepaidCents?: number; treasuryDeltaCents?: number };
      placeNamedLandmark: (name: string, position: Position) => { ok: boolean; error?: string };
      renameLandmark: (landmarkId: string, name: string) => { ok: boolean; error?: string };
      dismantleLandmark: (landmarkId: string) => { ok: boolean; error?: string };
      createResource: (itemId: ItemId, position: Position) => { ok: boolean; error?: string };
      removeResource: (resourceId: string) => { ok: boolean; error?: string };
      buyCatItem: (catId: string, itemId: ItemId) => { ok: boolean; error?: string; cost?: number; sellerCatId?: string };
      buyAllCatStock: () => { ok: boolean; error?: string; costCents?: number; quantity?: number };
      buyAllCatStockAndSell: () => { ok: boolean; error?: string; costCents?: number; revenueCents?: number; netCents?: number; quantity?: number };
      sellWarehouseItem: (itemId: ItemId, quantity?: number) => { ok: boolean; error?: string; revenueCents?: number; quantity?: number };
      sellAllUnlockedWarehouseItems: () => { ok: boolean; error?: string; revenueCents?: number; quantity?: number };
      toggleWarehouseItemLock: (itemId: ItemId) => { ok: boolean; error?: string; locked?: boolean };
      acknowledgeAchievement: (achievementId: string) => boolean;
    };
  }
}
