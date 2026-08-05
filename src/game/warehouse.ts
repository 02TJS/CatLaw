import type { GameState, ItemId } from "./types.js";

/**
 * Tracks only stock that entered the player warehouse through a purchase.
 * The main warehouse map intentionally remains the mixed legacy inventory
 * used by building/landmark placement; this ledger preserves provenance for
 * stability reports and never feeds a cat's local inventory.
 */
export function recordWarehousePurchase(state: GameState, itemId: ItemId, quantity = 1): void {
  if (!Number.isInteger(quantity) || quantity <= 0) return;
  state.playerWarehousePurchases[itemId] = (state.playerWarehousePurchases[itemId] ?? 0) + quantity;
}

/** Consume purchased provenance first when a player warehouse item leaves. */
export function consumeWarehousePurchase(state: GameState, itemId: ItemId, quantity = 1): void {
  if (!Number.isInteger(quantity) || quantity <= 0) return;
  const purchased = state.playerWarehousePurchases[itemId] ?? 0;
  const remaining = purchased - Math.min(purchased, quantity);
  if (remaining > 0) state.playerWarehousePurchases[itemId] = remaining;
  else delete state.playerWarehousePurchases[itemId];
}

export function warehousePurchasedQuantity(state: GameState, itemId: ItemId): number {
  return Math.max(0, state.playerWarehousePurchases[itemId] ?? 0);
}
