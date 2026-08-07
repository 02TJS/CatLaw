import { CATALOG_ANALYSIS, ITEM_BY_ID, ITEMS } from "./catalog";
import { difficultyProfile } from "./difficulty";
import {
  buyBuildingOffer as purchaseBuildingOffer,
  publishWarehouseBroadcast,
  unreservedOwnedQuantity,
} from "./market";
import { applyPrivateIncome } from "./marketEconomics";
import { formatMoney, itemPrice } from "./marketPricing";
import type { CatState, GameState, ItemId } from "./types";
import { consumeWarehousePurchase, recordWarehousePurchase } from "./warehouse";

export interface WarehouseQuote {
  itemId: ItemId;
  availableQuantity: number;
  unitPriceCents: number;
}

export interface CatStockPurchaseLine {
  kind: "offer" | "direct";
  catId: string;
  itemId: ItemId;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
  offerId?: string;
}

export interface CatStockPurchaseQuote {
  lines: CatStockPurchaseLine[];
  totalQuantity: number;
  totalCostCents: number;
  resaleQuantity: number;
  resaleRevenueCents: number;
  netCents: number;
  requiredTreasuryCents: number;
}

export interface WarehouseBulkSellLine {
  itemId: ItemId;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
}

export interface WarehouseBulkSellQuote {
  lines: WarehouseBulkSellLine[];
  totalQuantity: number;
  totalRevenueCents: number;
}

function take(inventory: Record<ItemId, number>, itemId: ItemId, quantity: number): boolean {
  if ((inventory[itemId] ?? 0) < quantity) return false;
  inventory[itemId] -= quantity;
  if (inventory[itemId] === 0) delete inventory[itemId];
  return true;
}

function give(inventory: Record<ItemId, number>, itemId: ItemId, quantity: number): void {
  inventory[itemId] = (inventory[itemId] ?? 0) + quantity;
}

function warehouseDirectPrice(state: GameState, itemId: ItemId): number {
  return Math.ceil(itemPrice(state, itemId) * difficultyProfile(state.difficulty).buildingAskMultiplier);
}

/** Player warehouse sales always use the immutable catalog base value, never a law or landmark price. */
export function warehouseSellPrice(itemId: ItemId): number {
  return ITEM_BY_ID.has(itemId) ? (CATALOG_ANALYSIS.basePrices[itemId] ?? 0) * 100 * 2 : 0;
}

export function warehouseBulkSellQuote(state: GameState): WarehouseBulkSellQuote {
  const locked = new Set(state.lockedWarehouseItemIds);
  const lines = ITEMS.map((item) => {
    const quantity = locked.has(item.id) ? 0 : state.playerBuildingInventory[item.id] ?? 0;
    const unitPriceCents = warehouseSellPrice(item.id);
    return { itemId: item.id, quantity, unitPriceCents, subtotalCents: unitPriceCents * quantity };
  }).filter((line) => line.quantity > 0);
  return {
    lines,
    totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0),
    totalRevenueCents: lines.reduce((sum, line) => sum + line.subtotalCents, 0),
  };
}

function catStockLines(state: GameState, onlyCatId?: string, onlyItemId?: ItemId): CatStockPurchaseLine[] {
  const lines: CatStockPurchaseLine[] = [];
  const cats = [...state.cats]
    .filter((cat) => !onlyCatId || cat.id === onlyCatId)
    .sort((left, right) => left.createdIndex - right.createdIndex);
  for (const cat of cats) {
    const itemIds = ITEMS.map((item) => item.id).filter((itemId) => !onlyItemId || itemId === onlyItemId);
    for (const itemId of itemIds) {
      const offers = state.buildingOffers
        .filter((offer) => offer.status === "open" && offer.sellerCatId === cat.id && offer.itemId === itemId)
        .sort((left, right) => left.askCents - right.askCents || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      const validOfferCount = Math.min(cat.inventory[itemId] ?? 0, offers.length);
      for (const offer of offers.slice(0, validOfferCount)) {
        lines.push({
          kind: "offer",
          catId: cat.id,
          itemId,
          quantity: 1,
          unitPriceCents: offer.askCents,
          subtotalCents: offer.askCents,
          offerId: offer.id,
        });
      }
      const directQuantity = unreservedOwnedQuantity(state, cat, itemId);
      if (directQuantity > 0) {
        const unitPriceCents = warehouseDirectPrice(state, itemId);
        lines.push({
          kind: "direct",
          catId: cat.id,
          itemId,
          quantity: directQuantity,
          unitPriceCents,
          subtotalCents: directQuantity * unitPriceCents,
        });
      }
    }
  }
  return lines;
}

export function catStockPurchaseQuote(state: GameState, catId?: string): CatStockPurchaseQuote {
  const lines = catStockLines(state, catId);
  const locked = new Set(state.lockedWarehouseItemIds);
  const totalQuantity = lines.reduce((sum, line) => sum + line.quantity, 0);
  const totalCostCents = lines.reduce((sum, line) => sum + line.subtotalCents, 0);
  const resaleQuantity = lines.reduce((sum, line) => sum + (locked.has(line.itemId) ? 0 : line.quantity), 0);
  const resaleRevenueCents = lines.reduce((sum, line) => (
    sum + (locked.has(line.itemId) ? 0 : warehouseSellPrice(line.itemId) * line.quantity)
  ), 0);
  return {
    lines,
    totalQuantity,
    totalCostCents,
    resaleQuantity,
    resaleRevenueCents,
    netCents: resaleRevenueCents - totalCostCents,
    requiredTreasuryCents: Math.max(0, totalCostCents - resaleRevenueCents),
  };
}

export function warehouseQuote(state: GameState, itemId: ItemId): WarehouseQuote {
  if (!ITEM_BY_ID.has(itemId)) return { itemId, availableQuantity: 0, unitPriceCents: 0 };
  const offered = state.buildingOffers.filter((offer) => offer.status === "open" && offer.itemId === itemId
    && state.cats.some((cat) => cat.id === offer.sellerCatId && (cat.inventory[itemId] ?? 0) >= 1));
  const directQuantity = state.cats.reduce((total, cat) => total + unreservedOwnedQuantity(state, cat, itemId), 0);
  const directPrice = warehouseDirectPrice(state, itemId);
  const prices = [...offered.map((offer) => offer.askCents), ...(directQuantity > 0 ? [directPrice] : [])];
  return {
    itemId,
    availableQuantity: offered.length + directQuantity,
    unitPriceCents: prices.length > 0 ? Math.min(...prices) : directPrice,
  };
}

export function buyWarehouseItem(state: GameState, itemId: ItemId): { ok: boolean; error?: string; cost?: number; sellerCatId?: string } {
  if (!ITEM_BY_ID.has(itemId)) return { ok: false, error: "商品不存在" };
  const directPrice = warehouseDirectPrice(state, itemId);
  const candidates: Array<{ kind: "offer" | "direct"; price: number; seller: CatState; offerId?: string }> = [];
  for (const offer of state.buildingOffers.filter((entry) => entry.status === "open" && entry.itemId === itemId)) {
    const seller = state.cats.find((cat) => cat.id === offer.sellerCatId);
    if (seller && (seller.inventory[itemId] ?? 0) >= 1) candidates.push({ kind: "offer", price: offer.askCents, seller, offerId: offer.id });
  }
  for (const seller of state.cats) {
    if (unreservedOwnedQuantity(state, seller, itemId) >= 1) candidates.push({ kind: "direct", price: directPrice, seller });
  }
  candidates.sort((left, right) => left.price - right.price
    || left.seller.createdIndex - right.seller.createdIndex
    || Number(left.kind === "direct") - Number(right.kind === "direct"));
  const selected = candidates[0];
  if (!selected) return { ok: false, error: "猫咪目前没有可收购的现货" };
  if (state.treasuryCoins < selected.price) return { ok: false, error: `国库还差 ${formatMoney(selected.price - state.treasuryCoins)}` };
  if (selected.kind === "offer") {
    const result = purchaseBuildingOffer(state, selected.offerId!);
    return result.ok ? { ok: true, cost: selected.price, sellerCatId: selected.seller.id } : result;
  }
  state.treasuryCoins -= selected.price;
  take(selected.seller.inventory, itemId, 1);
  applyPrivateIncome(selected.seller, selected.price);
  state.playerBuildingInventory[itemId] = (state.playerBuildingInventory[itemId] ?? 0) + 1;
  recordWarehousePurchase(state, itemId, 1);
  publishWarehouseBroadcast(state, selected.seller.id, itemId);
  state.dirtyDecisions = true;
  return { ok: true, cost: selected.price, sellerCatId: selected.seller.id };
}

export function buyCatItem(state: GameState, catId: string, itemId: ItemId): { ok: boolean; error?: string; cost?: number; sellerCatId?: string } {
  if (!ITEM_BY_ID.has(itemId)) return { ok: false, error: "商品不存在" };
  const seller = state.cats.find((cat) => cat.id === catId);
  if (!seller) return { ok: false, error: "猫咪不存在" };
  const selected = catStockLines(state, catId, itemId).sort((left, right) => (
    left.unitPriceCents - right.unitPriceCents
    || Number(left.kind === "direct") - Number(right.kind === "direct")
    || (left.offerId ?? "").localeCompare(right.offerId ?? "")
  ))[0];
  if (!selected) return { ok: false, error: "这件商品正在被作业、计划、合同或报价占用，暂无可收购现货" };
  if (state.treasuryCoins < selected.unitPriceCents) {
    return { ok: false, error: `国库还差 ${formatMoney(selected.unitPriceCents - state.treasuryCoins)}` };
  }
  if (selected.kind === "offer") {
    const result = purchaseBuildingOffer(state, selected.offerId!);
    return result.ok ? { ok: true, cost: selected.unitPriceCents, sellerCatId: seller.id } : result;
  }
  state.treasuryCoins -= selected.unitPriceCents;
  take(seller.inventory, itemId, 1);
  applyPrivateIncome(seller, selected.unitPriceCents);
  give(state.playerBuildingInventory, itemId, 1);
  recordWarehousePurchase(state, itemId, 1);
  publishWarehouseBroadcast(state, seller.id, itemId);
  state.dirtyDecisions = true;
  return { ok: true, cost: selected.unitPriceCents, sellerCatId: seller.id };
}

function buyQuotedCatStock(state: GameState, quote: CatStockPurchaseQuote): { ok: boolean; error?: string } {
  for (const line of quote.lines) {
    const seller = state.cats.find((cat) => cat.id === line.catId);
    if (!seller) return { ok: false, error: "报价中的猫咪已不存在" };
    if (line.kind === "offer") {
      const result = purchaseBuildingOffer(state, line.offerId!);
      if (!result.ok) return result;
      continue;
    }
    if (unreservedOwnedQuantity(state, seller, line.itemId) < line.quantity) {
      return { ok: false, error: "猫咪现货在结算前发生变化" };
    }
    state.treasuryCoins -= line.subtotalCents;
    take(seller.inventory, line.itemId, line.quantity);
    applyPrivateIncome(seller, line.subtotalCents);
    give(state.playerBuildingInventory, line.itemId, line.quantity);
    recordWarehousePurchase(state, line.itemId, line.quantity);
    publishWarehouseBroadcast(state, seller.id, line.itemId);
  }
  state.dirtyDecisions = true;
  return { ok: true };
}

export function buyAllCatStock(state: GameState): { ok: boolean; error?: string; costCents?: number; quantity?: number } {
  const quote = catStockPurchaseQuote(state);
  if (quote.totalQuantity === 0) return { ok: false, error: "所有猫咪目前都没有可收购现货" };
  if (state.treasuryCoins < quote.totalCostCents) {
    return { ok: false, error: `国库还差 ${formatMoney(quote.totalCostCents - state.treasuryCoins)}` };
  }
  const result = buyQuotedCatStock(state, quote);
  return result.ok
    ? { ok: true, costCents: quote.totalCostCents, quantity: quote.totalQuantity }
    : result;
}

function recordWarehouseSale(state: GameState, itemId: ItemId, quantity: number, creditTreasury = true): number {
  const revenueCents = warehouseSellPrice(itemId) * quantity;
  if (creditTreasury) state.treasuryCoins += revenueCents;
  state.totalSales += revenueCents;
  state.itemStats[itemId].sold += quantity;
  state.itemStats[itemId].revenue += revenueCents;
  return revenueCents;
}

export function buyAllCatStockAndSell(state: GameState): { ok: boolean; error?: string; costCents?: number; revenueCents?: number; netCents?: number; quantity?: number } {
  const quote = catStockPurchaseQuote(state);
  if (quote.totalQuantity === 0) return { ok: false, error: "所有猫咪目前都没有可收购现货" };
  if (state.treasuryCoins < quote.requiredTreasuryCents) {
    return { ok: false, error: `完成净额结算还差 ${formatMoney(quote.requiredTreasuryCents - state.treasuryCoins)}` };
  }

  // Treat the resale proceeds as same-transaction settlement funds. This is why
  // only the positive purchase/resale difference must exist in the treasury.
  state.treasuryCoins += quote.resaleRevenueCents;
  const result = buyQuotedCatStock(state, quote);
  if (!result.ok) return result;
  const locked = new Set(state.lockedWarehouseItemIds);
  for (const line of quote.lines) {
    if (locked.has(line.itemId)) continue;
    take(state.playerBuildingInventory, line.itemId, line.quantity);
    consumeWarehousePurchase(state, line.itemId, line.quantity);
    recordWarehouseSale(state, line.itemId, line.quantity, false);
    publishWarehouseBroadcast(state, state.cats[0]?.id ?? "", line.itemId);
  }
  return {
    ok: true,
    costCents: quote.totalCostCents,
    revenueCents: quote.resaleRevenueCents,
    netCents: quote.netCents,
    quantity: quote.totalQuantity,
  };
}

export function sellWarehouseItem(state: GameState, itemId: ItemId, quantity = 1): { ok: boolean; error?: string; revenueCents?: number; quantity?: number } {
  if (!ITEM_BY_ID.has(itemId)) return { ok: false, error: "商品不存在" };
  if (!Number.isInteger(quantity) || quantity <= 0) return { ok: false, error: "出售数量必须是正整数" };
  if ((state.playerBuildingInventory[itemId] ?? 0) < quantity) return { ok: false, error: "仓库库存不足" };
  take(state.playerBuildingInventory, itemId, quantity);
  consumeWarehousePurchase(state, itemId, quantity);
  const revenueCents = recordWarehouseSale(state, itemId, quantity);
  publishWarehouseBroadcast(state, state.cats[0]?.id ?? "", itemId);
  state.dirtyDecisions = true;
  return { ok: true, revenueCents, quantity };
}

export function sellAllUnlockedWarehouseItems(state: GameState): { ok: boolean; error?: string; revenueCents?: number; quantity?: number } {
  const quote = warehouseBulkSellQuote(state);
  if (quote.lines.length === 0) return { ok: false, error: "没有可一键出售的未锁定商品" };
  let revenueCents = 0;
  let quantity = 0;
  for (const line of quote.lines) {
    take(state.playerBuildingInventory, line.itemId, line.quantity);
    consumeWarehousePurchase(state, line.itemId, line.quantity);
    revenueCents += recordWarehouseSale(state, line.itemId, line.quantity);
    publishWarehouseBroadcast(state, state.cats[0]?.id ?? "", line.itemId);
    quantity += line.quantity;
  }
  state.dirtyDecisions = true;
  return { ok: true, revenueCents, quantity };
}

export function toggleWarehouseItemLock(state: GameState, itemId: ItemId): { ok: boolean; error?: string; locked?: boolean } {
  if (!ITEM_BY_ID.has(itemId)) return { ok: false, error: "商品不存在" };
  const locked = new Set(state.lockedWarehouseItemIds);
  const nextLocked = !locked.has(itemId);
  if (nextLocked) locked.add(itemId);
  else locked.delete(itemId);
  state.lockedWarehouseItemIds = ITEMS.map((item) => item.id).filter((id) => locked.has(id));
  return { ok: true, locked: nextLocked };
}
