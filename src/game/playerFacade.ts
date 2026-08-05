import {
  advanceGame,
  buyAllCatStock,
  buyAllCatStockAndSell,
  buyBuildingOffer,
  buyCatItem,
  buyWarehouseItem,
  enactLaw,
  placeOwnedBuilding,
  recordPlayerCommand,
  reorderLaw,
  repealLaw,
  sellAllUnlockedWarehouseItems,
  sellWarehouseItem,
  unlockRecipe,
} from "./engine.js";
import type { GameState, LawDraft, Position } from "./types.js";

/**
 * The only mutating surface used by the DeepSeek-to-35 black-box runner.
 * It deliberately omits cat placement/removal, parcel expansion, direct state
 * access helpers, item injection, recipe injection and save-store access.
 */
export function createAuditedPlayerFacade(state: GameState) {
  return Object.freeze({
    advanceTime(milliseconds: number) {
      const ok = Number.isFinite(milliseconds) && milliseconds > 0;
      if (ok) advanceGame(state, milliseconds);
      recordPlayerCommand(state, "advance-time", String(milliseconds), ok);
      return { ok };
    },
    buyRecipe(recipeId: string) {
      const result = unlockRecipe(state, recipeId);
      recordPlayerCommand(state, "buy-recipe", recipeId, result.ok, result.error);
      return result;
    },
    buyCatItem(catId: string, itemId: string) {
      const result = buyCatItem(state, catId, itemId);
      recordPlayerCommand(state, "buy-cat-stock", `${catId}:${itemId}`, result.ok, result.ok
        ? JSON.stringify({ source: "cat-purchase", sourceCatId: result.sellerCatId ?? catId, itemId, quantity: 1, costCents: result.cost ?? null })
        : result.error);
      return result;
    },
    buyWarehouseItem(itemId: string) {
      const result = buyWarehouseItem(state, itemId);
      recordPlayerCommand(state, "buy-cat-stock", `warehouse:${itemId}`, result.ok, result.ok
        ? JSON.stringify({ source: "cat-purchase", sourceCatId: result.sellerCatId ?? null, itemId, quantity: 1, costCents: result.cost ?? null })
        : result.error);
      return result;
    },
    buyAllCatStock() {
      const result = buyAllCatStock(state);
      recordPlayerCommand(state, "buy-cat-stock", "all", result.ok, result.error);
      return result;
    },
    buyAllCatStockAndSell() {
      const result = buyAllCatStockAndSell(state);
      recordPlayerCommand(state, "buy-cat-stock", "all-and-sell", result.ok, result.error);
      return result;
    },
    sellWarehouseItem(itemId: string, quantity = 1) {
      const result = sellWarehouseItem(state, itemId, quantity);
      recordPlayerCommand(state, "sell-warehouse", `${itemId}:${quantity}`, result.ok, result.error);
      return result;
    },
    sellAllWarehouse() {
      const result = sellAllUnlockedWarehouseItems(state);
      recordPlayerCommand(state, "sell-warehouse", "all-unlocked", result.ok, result.error);
      return result;
    },
    buyBuilding(offerId: string) {
      const offer = state.buildingOffers.find((entry) => entry.id === offerId);
      const result = buyBuildingOffer(state, offerId);
      recordPlayerCommand(state, "buy-building", offerId, result.ok, result.ok
        ? JSON.stringify({
          source: "cat-building-offer",
          sourceCatId: offer?.sellerCatId ?? null,
          itemId: offer?.itemId ?? null,
          quantity: 1,
          costCents: offer?.askCents ?? null,
        })
        : result.error);
      return result;
    },
    placeBuilding(itemId: string, position: Position) {
      const result = placeOwnedBuilding(state, itemId, position);
      recordPlayerCommand(state, "place-building", `${itemId}@${position.x},${position.y}`, result.ok, result.error);
      return result;
    },
    enact(draft: LawDraft, insertionIndex = 0) {
      const result = enactLaw(state, draft, insertionIndex);
      recordPlayerCommand(state, "enact-law", draft.title, result.ok, result.error);
      return result;
    },
    reorder(lawId: string, delta: -1 | 1) {
      const ok = reorderLaw(state, lawId, delta);
      recordPlayerCommand(state, "reorder-law", lawId, ok, String(delta));
      return { ok };
    },
    repeal(lawId: string) {
      const result = repealLaw(state, lawId);
      recordPlayerCommand(state, "repeal-law", lawId, result.ok, result.error);
      return result;
    },
  });
}

export type AuditedPlayerFacade = ReturnType<typeof createAuditedPlayerFacade>;
