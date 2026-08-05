import { describe, expect, it } from "vitest";
import { CATALOG_ANALYSIS, ITEMS, RECIPES, RECIPE_BY_OUTPUT } from "./catalog";
import {
  buildingPlacementFailure,
  buyBuildingOffer,
  buyWarehouseItem,
  createInitialState,
  dismantleBuilding,
  itemPrice,
  placeOwnedBuilding,
  warehouseQuote,
} from "./engine";
import {
  claimDiscoveryBounty,
  completeProcurementPlan,
  createDiscoveryBounties,
  syncBuildingOffers,
  unreservedOwnedQuantity,
} from "./market";
import { migrateSaveSnapshot } from "./persistence";
import { resourceHarvestTiles } from "./world";

describe("0.8.0 building market and all-item bounties", () => {
  it("creates exactly 65 one-time bounties at three times each base price", () => {
    const bounties = createDiscoveryBounties();
    expect(bounties).toHaveLength(65);
    expect(new Set(bounties.map((entry) => entry.itemId)).size).toBe(65);
    for (const bounty of bounties) {
      expect(bounty.amountCents).toBe(CATALOG_ANALYSIS.basePrices[bounty.itemId] * 300);
    }
  });

  it("locks a bounty to one starter and pays it only once", () => {
    const state = createInitialState({ worldSeed: 81 });
    claimDiscoveryBounty(state, "cat-0", "wood");
    claimDiscoveryBounty(state, "cat-1", "wood");
    const bounty = state.discoveryBounties.find((entry) => entry.itemId === "wood")!;
    expect(bounty.claimedByCatId).toBe("cat-0");
    expect(completeProcurementPlan(state, "cat-1", "wood")).toBe(0);
    expect(completeProcurementPlan(state, "cat-0", "wood")).toBe(bounty.amountCents);
    expect(completeProcurementPlan(state, "cat-0", "wood")).toBe(0);
    expect(bounty.paid).toBe(true);
  });

  it("reserves one offered building and keeps its quoted price fixed", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 82 });
    const seller = state.cats[0];
    seller.inventory.factory = 2;
    syncBuildingOffers(state, (itemId) => itemPrice(state, itemId));
    const offer = state.buildingOffers[0];
    expect(offer.askCents).toBe(Math.ceil(itemPrice(state, "factory") * 1.1));
    expect(unreservedOwnedQuantity(state, seller, "factory")).toBe(1);
    syncBuildingOffers(state, () => 9_999_999);
    expect(state.buildingOffers.filter((entry) => entry.status === "open")).toHaveLength(1);
    expect(offer.askCents).toBe(Math.ceil(itemPrice(state, "factory") * 1.1));
  });

  it("leaves every balance and reservation unchanged when treasury funds are insufficient", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 83 });
    const seller = state.cats[0];
    seller.inventory.factory = 1;
    syncBuildingOffers(state, (itemId) => itemPrice(state, itemId));
    const offer = state.buildingOffers[0];
    state.treasuryCoins = offer.askCents - 1;
    const before = structuredClone({ treasury: state.treasuryCoins, inventory: seller.inventory, offer });
    expect(buyBuildingOffer(state, offer.id)).toMatchObject({ ok: false });
    expect(state.treasuryCoins).toBe(before.treasury);
    expect(seller.inventory).toEqual(before.inventory);
    expect(offer).toEqual(before.offer);
    expect(state.playerBuildingInventory.factory).toBeUndefined();
  });

  it("settles a tax-free purchase once and repays seller debt before adding cash", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 84 });
    const seller = state.cats[0];
    seller.inventory.factory = 1;
    seller.debtCents = 500;
    state.laws.unshift({
      ...createInitialState({ worldSeed: 84 }).laws[0], id: "test-tax", title: "全额税",
      sourceCode: "function decide(ctx) { setTax(1); return null; }", program: { version: 2 }, locked: false,
    });
    syncBuildingOffers(state, (itemId) => itemPrice(state, itemId));
    const offer = state.buildingOffers[0];
    state.treasuryCoins = offer.askCents + 1_000;
    const treasuryBefore = state.treasuryCoins;
    const salesBefore = state.totalSales;
    expect(buyBuildingOffer(state, offer.id)).toEqual({ ok: true });
    expect(state.treasuryCoins).toBe(treasuryBefore - offer.askCents);
    expect(seller.debtCents).toBe(Math.max(0, 500 - offer.askCents));
    expect(seller.coins).toBe(Math.max(0, offer.askCents - 500));
    expect(state.totalSales).toBe(salesBefore);
    expect(buyBuildingOffer(state, offer.id)).toMatchObject({ ok: false });
  });

  it("lets the treasury buy ordinary unreserved goods into the player warehouse", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 841 });
    const seller = state.cats[0];
    seller.inventory.wood = 2;
    seller.debtCents = 1;
    state.treasuryCoins = 10_000;
    const quote = warehouseQuote(state, "wood");
    const treasuryBefore = state.treasuryCoins;
    const salesBefore = state.totalSales;

    expect(quote.availableQuantity).toBe(2);
    expect(buyWarehouseItem(state, "wood")).toEqual({
      ok: true,
      cost: quote.unitPriceCents,
      sellerCatId: seller.id,
    });
    expect(state.treasuryCoins).toBe(treasuryBefore - quote.unitPriceCents);
    expect(seller.inventory.wood).toBe(1);
    expect(seller.debtCents).toBe(0);
    expect(seller.coins).toBe(quote.unitPriceCents - 1);
    expect(state.playerBuildingInventory.wood).toBe(1);
    expect(state.totalSales).toBe(salesBefore);
  });

  it("keeps plan inputs protected and an unaffordable warehouse purchase atomic", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 842 });
    const seller = state.cats[0];
    seller.inventory.wood = 2;
    state.procurementPlans.push({
      id: "plan-plank", catId: seller.id, outputItemId: "plank", recipeId: RECIPE_BY_OUTPUT.get("plank")!.id,
      terminalOrderId: null, expectedRevenueCents: 100, createdAt: 0, status: "active", reason: "bounty",
    });
    expect(warehouseQuote(state, "wood").availableQuantity).toBe(0);
    expect(buyWarehouseItem(state, "wood")).toMatchObject({ ok: false });

    state.procurementPlans[0].status = "cancelled";
    const quote = warehouseQuote(state, "wood");
    expect(quote.availableQuantity).toBe(2);
    state.treasuryCoins = quote.unitPriceCents - 1;
    const before = structuredClone({
      treasuryCoins: state.treasuryCoins,
      sellerInventory: seller.inventory,
      sellerCoins: seller.coins,
      warehouse: state.playerBuildingInventory,
    });
    expect(buyWarehouseItem(state, "wood")).toMatchObject({ ok: false });
    expect({
      treasuryCoins: state.treasuryCoins,
      sellerInventory: seller.inventory,
      sellerCoins: seller.coins,
      warehouse: state.playerBuildingInventory,
    }).toEqual(before);
  });

  it("exposes a valid deterministic warehouse quote for every catalog item", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 843 });
    const quotes = ITEMS.map((item) => warehouseQuote(state, item.id));
    expect(quotes).toHaveLength(65);
    expect(quotes.every((quote) => quote.itemId && quote.availableQuantity >= 0 && quote.unitPriceCents > 0)).toBe(true);
    expect(warehouseQuote(state, "missing-item")).toEqual({ itemId: "missing-item", availableQuantity: 0, unitPriceCents: 0 });
    expect(buyWarehouseItem(state, "missing-item")).toMatchObject({ ok: false });
  });

  it("never offers a factory protected as an input of the cat's active fabricator plan", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 85 });
    const cat = state.cats[0];
    cat.inventory.factory = 1;
    const recipe = RECIPE_BY_OUTPUT.get("fabricator")!;
    state.procurementPlans.push({
      id: "plan-fabricator", catId: cat.id, outputItemId: "fabricator", recipeId: recipe.id,
      terminalOrderId: null, expectedRevenueCents: 100_000, createdAt: 0, status: "active", reason: "bounty",
    });
    syncBuildingOffers(state, (itemId) => itemPrice(state, itemId));
    expect(state.buildingOffers).toHaveLength(0);
    state.procurementPlans[0].status = "cancelled";
    syncBuildingOffers(state, (itemId) => itemPrice(state, itemId));
    expect(state.buildingOffers[0]).toMatchObject({ sellerCatId: cat.id, itemId: "factory", status: "open" });
  });

  it("places factories beside resources while keeping centers blocked and dismantles back to inventory", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 86 });
    state.playerBuildingInventory.factory = 2;
    const catPosition = state.cats[0].position;
    const node = state.resourceNodes[0];
    expect(buildingPlacementFailure(state, "factory", catPosition)).toContain("猫咪");
    expect(buildingPlacementFailure(state, "factory", node.position)).toContain("资源");
    const harvestTile = resourceHarvestTiles(node).find((position) => !state.cats.some((cat) => cat.position.x === position.x && cat.position.y === position.y))!;
    expect(buildingPlacementFailure(state, "factory", harvestTile)).toBeNull();
    expect(buildingPlacementFailure(state, "lab", harvestTile)).toContain("只有工厂");
    expect(buildingPlacementFailure(state, "factory", { x: 99, y: 99 })).toContain("已开拓");
    const placed = placeOwnedBuilding(state, "factory", harvestTile);
    expect(placed).toMatchObject({ ok: true });
    expect(buildingPlacementFailure(state, "factory", harvestTile)).toContain("建筑");
    expect(dismantleBuilding(state, placed.building!.id)).toEqual({ ok: true });
    expect(state.playerBuildingInventory.factory).toBe(2);
  });

  it("migrates schema 4 ground buildings and open orders without losing assets", () => {
    const original = createInitialState({ withStarter: false, worldSeed: 87 });
    const legacy: any = structuredClone(original);
    legacy.schemaVersion = 4;
    legacy.buildings = [{ id: "legacy-factory", itemId: "factory", hostCatId: "cat-0", position: { x: 1, y: 0 }, deployedAt: 0 }];
    legacy.treasuryCoins = 10_000;
    legacy.demandOrders = [{
      id: "open-building", buyerKind: "treasury", buyerCatId: null, destinationCatId: "cat-0", itemId: "lab",
      maxDeliveredCents: 900, reservedCents: 900, planId: null, createdAt: 0, status: "open", closedAt: null, closeReason: null,
    }, {
      id: "contracted-building", buyerKind: "treasury", buyerCatId: null, destinationCatId: "cat-0", itemId: "reactor",
      maxDeliveredCents: 1_200, reservedCents: 1_200, planId: null, createdAt: 0, status: "contracted", closedAt: 0, closeReason: "contracted",
    }];
    legacy.buildingOrders = [
      { id: "old-open", itemId: "lab", targetCatId: "cat-0", createdAt: 0, demandOrderId: "open-building", budgetCents: 900 },
      { id: "old-contracted", itemId: "reactor", targetCatId: "cat-0", createdAt: 0, demandOrderId: "contracted-building", contractId: "contract-legacy", budgetCents: 1_200 },
    ];
    legacy.discoveryBounties = legacy.discoveryBounties.slice(0, 15);
    legacy.discoveredItems = ["wood", "cable"];
    const migrated = migrateSaveSnapshot(legacy);
    expect(migrated.schemaVersion).toBe(14);
    expect(migrated.buildings).toEqual([]);
    expect(migrated.playerBuildingInventory.factory).toBe(1);
    expect(migrated.treasuryCoins).toBe(10_900);
    expect(migrated.buildingOrders.map((order) => order.id)).toEqual(["old-contracted"]);
    expect(migrated.demandOrders.find((order) => order.id === "open-building")?.status).toBe("cancelled");
    expect(migrated.discoveryBounties).toHaveLength(ITEMS.length);
    expect(migrated.discoveryBounties.find((entry) => entry.itemId === "cable")?.paid).toBe(true);
    expect(RECIPES).toHaveLength(65);
  });
});
