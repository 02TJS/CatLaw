import { describe, expect, it } from "vitest";
import {
  advanceGame,
  buildObservation,
  buyAllCatStock,
  buyAllCatStockAndSell,
  buyCatItem,
  buyWarehouseItem,
  catStockPurchaseQuote,
  createInitialState,
  sellAllUnlockedWarehouseItems,
  sellWarehouseItem,
  toggleWarehouseItemLock,
  warehouseBulkSellQuote,
  warehouseSellPrice,
} from "./engine";
import { migrateSaveSnapshot } from "./persistence";
import { executeLawSource } from "./lawInterpreter";
import { warehousePurchasedQuantity } from "./warehouse";
import type { GameState, LawVersion } from "./types";

function priceLaw(itemId: string, multiplier: number): LawVersion {
  const sourceCode = `function decide(ctx) { setPrice(${JSON.stringify(itemId)}, ${multiplier}); return null; }`;
  return {
    id: `price-${itemId}`,
    title: "测试价格法",
    playerText: "",
    summary: "",
    sourceCode,
    astHash: "",
    examples: [],
    warnings: [],
    enactedAt: 0,
    program: { version: 2 },
    hitCount: 0,
    invalidCount: 0,
    consecutiveFaults: 0,
    status: "active",
  };
}

function blank(): GameState {
  const state = createInitialState({ withStarter: false, worldSeed: 701 });
  state.resourceNodes = [];
  state.discoveryBounties.forEach((bounty) => { bounty.paid = true; });
  state.marketBroadcasts = [];
  state.procurementPlans = [];
  state.dirtyDecisions = true;
  return state;
}

describe("0.12.0 player warehouse trading", () => {
  it("never lets a cat begin an external sell action", () => {
    const state = blank();
    state.cats[0].inventory.wood = 1;
    state.laws = [{
      ...priceLaw("wood", 1),
      id: "sell-behavior",
      program: { version: 2 },
      sourceCode: 'function decide(ctx) { return { type: "sell", itemId: "wood" }; }',
    }];
    advanceGame(state, 5_000);
    expect(state.cats[0].action?.type).toBe("wait");
  });

  it("buys one selected cat item and pays that cat before adding warehouse stock", () => {
    const state = blank();
    const cat = state.cats[0];
    cat.inventory.wood = 2;
    cat.debtCents = 50;
    state.treasuryCoins = 10_000;
    const line = catStockPurchaseQuote(state, cat.id).lines.find((entry) => entry.itemId === "wood")!;
    const before = state.treasuryCoins;
    expect(buyCatItem(state, cat.id, "wood")).toEqual({ ok: true, cost: line.unitPriceCents, sellerCatId: cat.id });
    expect(state.treasuryCoins).toBe(before - line.unitPriceCents);
    expect(cat.inventory.wood).toBe(1);
    expect(cat.debtCents).toBe(0);
    expect(cat.coins).toBe(line.unitPriceCents - 50);
    expect(state.playerBuildingInventory.wood).toBe(1);
    expect(warehousePurchasedQuantity(state, "wood")).toBe(1);
  });

  it("lets a minimum-inventory law react to purchased stock without adding it to cat inventory", () => {
    const state = blank();
    const cat = state.cats[0];
    cat.inventory.wood = 2;
    state.treasuryCoins = 10_000;
    expect(buyCatItem(state, cat.id, "wood").ok).toBe(true);
    const observation = buildObservation(state, cat);
    const adjustments: unknown[][] = [];
    const result = executeLawSource(
      "function decide(ctx) { if (warehouseCount('wood') < 2) adjust('craft', 'wood', 8, 180000); return choose(); }",
      observation,
      10_000,
      { adjust: (...args) => adjustments.push(args), choose: () => null },
    );
    expect(result.error).toBeUndefined();
    expect(adjustments).toEqual([["craft", "wood", 8, 180000]]);
    expect(cat.inventory.wood).toBe(1);
    expect(state.playerBuildingInventory.wood).toBe(1);
    expect(warehousePurchasedQuantity(state, "wood")).toBe(1);
  });

  it("keeps minimum-inventory replenishment cat-owned after the player buys the warehouse signal", () => {
    const state = createInitialState({ worldSeed: 7, simulationSpeed: 8 });
    advanceGame(state, 10_000);
    expect(buyWarehouseItem(state, "wood").ok).toBe(true);

    const craftedBeforeLaw = state.itemStats.wood.crafted;
    const sourceCode = "function decide(ctx) { if (warehouseCount('wood') < 5) adjust('craft', 'wood', 8, 180000); return choose(); }";
    const law = {
      ...priceLaw("wood", 1),
      id: "warehouse-minimum-wood",
      title: "Wood warehouse minimum",
      sourceCode,
    };
    state.laws.unshift(law);
    state.dirtyDecisions = true;

    advanceGame(state, 10_000);

    expect(law.hitCount).toBeGreaterThan(0);
    expect(state.itemStats.wood.crafted).toBeGreaterThan(craftedBeforeLaw);
    expect(state.cats.reduce((total, cat) => total + (cat.inventory.wood ?? 0), 0)).toBeGreaterThan(0);
    expect(state.playerBuildingInventory.wood).toBe(1);
    expect(warehousePurchasedQuantity(state, "wood")).toBe(1);
    expect(state.marketBroadcasts.find((entry) => entry.subjectId === "warehouse:wood")?.amountCents).toBe(1);
  });

  it("quotes all available cat stock and leaves every balance unchanged when full purchase funds are short", () => {
    const state = blank();
    state.cats[0].inventory = { wood: 2, stone: 1 };
    const quote = catStockPurchaseQuote(state);
    state.treasuryCoins = quote.totalCostCents - 1;
    const before = structuredClone(state);
    expect(buyAllCatStock(state)).toMatchObject({ ok: false });
    expect(state).toEqual(before);
  });

  it("buys all stock atomically when the treasury can pay the displayed total", () => {
    const state = blank();
    state.cats[0].inventory = { wood: 2, stone: 1 };
    const quote = catStockPurchaseQuote(state);
    state.treasuryCoins = quote.totalCostCents;
    expect(buyAllCatStock(state)).toEqual({ ok: true, costCents: quote.totalCostCents, quantity: 3 });
    expect(state.treasuryCoins).toBe(0);
    expect(state.playerBuildingInventory).toMatchObject({ wood: 2, stone: 1 });
    expect(warehousePurchasedQuantity(state, "wood")).toBe(2);
    expect(warehousePurchasedQuantity(state, "stone")).toBe(1);
    expect(state.cats[0].inventory).toEqual({});
  });

  it("uses same-transaction resale proceeds when revenue covers the purchase", () => {
    const state = blank();
    state.cats[0].inventory.wood = 1;
    state.treasuryCoins = 0;
    const quote = catStockPurchaseQuote(state);
    expect(quote.requiredTreasuryCents).toBe(0);
    const result = buyAllCatStockAndSell(state);
    expect(result).toMatchObject({ ok: true, costCents: quote.totalCostCents, revenueCents: warehouseSellPrice("wood") });
    expect(state.treasuryCoins).toBe(quote.netCents);
    expect(state.playerBuildingInventory.wood).toBeUndefined();
    expect(warehousePurchasedQuantity(state, "wood")).toBe(0);
    expect(state.itemStats.wood.sold).toBe(1);
  });

  it("requires only the positive purchase/resale difference and stays atomic when that difference is short", () => {
    const state = blank();
    state.laws = [priceLaw("wood", 10)];
    state.cats[0].inventory.wood = 1;
    advanceGame(state, 5_000);
    const quote = catStockPurchaseQuote(state);
    expect(quote.totalCostCents).toBeGreaterThan(quote.resaleRevenueCents);
    state.treasuryCoins = quote.requiredTreasuryCents - 1;
    const before = structuredClone(state);
    expect(buyAllCatStockAndSell(state)).toMatchObject({ ok: false });
    expect(state).toEqual(before);

    state.treasuryCoins = quote.requiredTreasuryCents;
    expect(buyAllCatStockAndSell(state)).toMatchObject({ ok: true, netCents: -quote.requiredTreasuryCents });
    expect(state.treasuryCoins).toBe(0);
  });

  it("sells one warehouse item at immutable base x2 and excludes locked kinds from bulk sale", () => {
    const state = blank();
    state.laws = [priceLaw("wood", 100)];
    state.playerBuildingInventory = { wood: 2, stone: 1 };
    expect(toggleWarehouseItemLock(state, "wood")).toEqual({ ok: true, locked: true });
    expect(warehouseBulkSellQuote(state)).toEqual({
      lines: [{
        itemId: "stone",
        quantity: 1,
        unitPriceCents: warehouseSellPrice("stone"),
        subtotalCents: warehouseSellPrice("stone"),
      }],
      totalQuantity: 1,
      totalRevenueCents: warehouseSellPrice("stone"),
    });
    expect(sellAllUnlockedWarehouseItems(state)).toEqual({
      ok: true,
      revenueCents: warehouseSellPrice("stone"),
      quantity: 1,
    });
    expect(state.playerBuildingInventory).toEqual({ wood: 2 });
    expect(sellWarehouseItem(state, "wood")).toEqual({
      ok: true,
      revenueCents: warehouseSellPrice("wood"),
      quantity: 1,
    });
    expect(state.playerBuildingInventory.wood).toBe(1);
    expect(warehousePurchasedQuantity(state, "wood")).toBe(0);
    expect(state.itemStats.wood.sold).toBe(1);
    expect(state.itemStats.stone.sold).toBe(1);
  });

  it("migrates schema 7 locks and returns reserved legacy sell stock", () => {
    const legacy: any = structuredClone(blank());
    legacy.schemaVersion = 7;
    delete legacy.lockedWarehouseItemIds;
    legacy.cats[0].inventory = {};
    legacy.cats[0].action = {
      type: "sell",
      itemId: "wood",
      startedAt: 0,
      endsAt: 5_000,
      reserved: { wood: 1 },
      lawId: "legacy",
    };
    const migrated = migrateSaveSnapshot(legacy);
    expect(migrated.schemaVersion).toBe(17);
    expect(migrated.lockedWarehouseItemIds).toEqual([]);
    expect(migrated.playerWarehousePurchases).toEqual({});
    expect(migrated.cats[0].action?.type).toBe("wait");
    expect(migrated.cats[0].inventory.wood).toBe(1);
  });
});
