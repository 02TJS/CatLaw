import { describe, expect, it } from "vitest";
import { RECIPE_BY_OUTPUT } from "./catalog";
import { createInitialState, decideIdleCats, itemPrice, removeCat } from "./engine";
import { resourceItemAt } from "./logistics";
import {
  contractActionForCat,
  publishBountySignal,
  readyContractForCat,
  refreshCatMarket,
  repairBrokenMarketReferences,
} from "./market";
import { migrateSaveSnapshot } from "./persistence";
import type { CatState, DemandOrder, GameState, ProcurementPlan, ShipmentContract } from "./types";

function cat(createdIndex: number, x: number, y: number): CatState {
  return {
    id: `cat-${createdIndex}`,
    createdIndex,
    position: { x, y },
    inventory: {},
    coins: 0,
    debtCents: 0,
    escrowReservedCents: 0,
    action: null,
    lastDecision: "",
    decisionTrace: [],
    decisionSerial: 0,
    lastSpeechAt: null,
  };
}

function marketState(): GameState {
  const state = createInitialState({ withStarter: false, worldSeed: 23 });
  state.cats = [cat(0, 0, 0), cat(1, 1, 0), cat(2, 2, 0)];
  state.nextCatIndex = 3;
  state.resourceNodes = [];
  state.procurementPlans = [];
  state.demandOrders = [];
  state.shipmentContracts = [];
  state.marketBroadcasts = [];
  return state;
}

function contractedOrder(id: string, sellerId: string, buyerId = "cat-0"): DemandOrder {
  return {
    id,
    buyerKind: "cat",
    buyerCatId: buyerId,
    destinationCatId: buyerId,
    itemId: "wood",
    maxDeliveredCents: 100,
    reservedCents: 102,
    planId: null,
    createdAt: 0,
    status: "contracted",
    closedAt: 0,
    closeReason: `由 ${sellerId} 成交`,
    committedSellerCatId: sellerId,
  };
}

function contract(
  id: string,
  orderId: string,
  routeCatIds: string[],
  currentLeg = 0,
  escrowCents = 100,
): ShipmentContract {
  return {
    id,
    orderId,
    itemId: "wood",
    sellerCatId: routeCatIds[0],
    buyerKind: "cat",
    buyerCatId: "cat-0",
    destinationCatId: "cat-0",
    routeCatIds,
    currentLeg,
    custodianCatId: routeCatIds[currentLeg],
    sellerPriceCents: 95,
    feesByCatId: { "cat-1": 5 },
    escrowCents,
    acceptedAt: Number(id.slice(id.lastIndexOf("-") + 1)) || 0,
    deliveredAt: null,
    status: currentLeg === 0 ? "awaiting-pickup" : "in-transit",
  };
}

describe("market deadlock repair", () => {
  it("removes a broken oldest contract without masking the next executable contract", () => {
    const state = marketState();
    state.cats[0].debtCents = 100;
    const brokenOrder = contractedOrder("order-broken", "cat-1");
    const validOrder = contractedOrder("order-valid", "cat-1");
    const broken = contract("contract-1", brokenOrder.id, ["cat-1", "deleted-cat", "cat-0"]);
    const valid = contract("contract-2", validOrder.id, ["cat-1", "cat-0"]);
    state.demandOrders.push(brokenOrder, validOrder);
    state.shipmentContracts.push(broken, valid);

    const beforeCargo = state.shipmentContracts.length + (state.cats[1].inventory.wood ?? 0);
    const repaired = repairBrokenMarketReferences(state);

    expect(repaired.repairedContractIds).toEqual([broken.id]);
    expect(state.shipmentContracts.map((entry) => entry.id)).toEqual([valid.id]);
    expect(state.cats[1].inventory.wood).toBe(1);
    expect(state.cats[0].debtCents).toBe(0);
    expect(brokenOrder.status).toBe("cancelled");
    expect(readyContractForCat(state, "cat-1")?.id).toBe(valid.id);
    expect(contractActionForCat(state, state.cats[1])).toMatchObject({ type: "pass", direction: "west", itemId: "wood" });
    expect(state.shipmentContracts.length + (state.cats[1].inventory.wood ?? 0)).toBe(beforeCargo);
  });

  it("returns in-transit buyer cargo, refunds only remaining escrow, and clears the carrier action", () => {
    const state = marketState();
    state.cats = state.cats.slice(0, 2);
    const order = contractedOrder("order-transit", "deleted-seller");
    order.planId = "plan-buyer";
    const plan: ProcurementPlan = {
      id: "plan-buyer",
      catId: "cat-0",
      outputItemId: "plank",
      recipeId: RECIPE_BY_OUTPUT.get("plank")!.id,
      terminalOrderId: null,
      expectedRevenueCents: 500,
      createdAt: 0,
      status: "active",
      reason: "external-sale",
      phase: "procuring",
      bundleOrderIds: [order.id],
    };
    const shipment = contract("contract-3", order.id, ["deleted-seller", "cat-1", "cat-0"], 1, 7);
    state.cats[0].debtCents = 10;
    state.cats[1].action = {
      type: "pass",
      itemId: "wood",
      direction: "west",
      startedAt: 0,
      endsAt: 5_000,
      reserved: {},
      lawId: "test-law",
      contractId: shipment.id,
    };
    state.demandOrders.push(order);
    state.procurementPlans.push(plan);
    state.shipmentContracts.push(shipment);

    const repaired = repairBrokenMarketReferences(state);

    expect(repaired).toMatchObject({ repairedContractIds: [shipment.id], refundedEscrowCents: 7 });
    expect(state.cats[0]).toMatchObject({ debtCents: 3, inventory: { wood: 1 } });
    expect(state.cats[1].action).toBeNull();
    expect(plan.status).toBe("cancelled");
    expect(order.status).toBe("cancelled");
    expect(state.shipmentContracts).toHaveLength(0);
  });

  it("clears a stale standalone quote so the order can be quoted again", () => {
    const state = marketState();
    const order: DemandOrder = {
      id: "order-open",
      buyerKind: "cat",
      buyerCatId: "cat-0",
      destinationCatId: "cat-0",
      itemId: "wood",
      maxDeliveredCents: 500,
      reservedCents: 500,
      planId: null,
      createdAt: 0,
      status: "open",
      closedAt: null,
      closeReason: null,
      committedSellerCatId: "cat-2",
      quotedSellerCents: 100,
      quotedRouteCatIds: ["cat-2", "deleted-cat", "cat-0"],
      quotedFeesByCatId: { "deleted-cat": 1 },
    };
    state.demandOrders.push(order);

    repairBrokenMarketReferences(state);

    expect(order.status).toBe("open");
    expect(order.committedSellerCatId).toBeNull();
    expect(order.quotedRouteCatIds).toBeUndefined();
    expect(state.marketBroadcasts.at(-1)).toMatchObject({ subjectId: order.id, kind: "demand-open" });
  });

  it("clears surviving open quotes immediately when their committed seller is removed", () => {
    const state = marketState();
    const order: DemandOrder = {
      id: "order-removed-seller",
      buyerKind: "cat",
      buyerCatId: "cat-0",
      destinationCatId: "cat-0",
      itemId: "wood",
      maxDeliveredCents: 500,
      reservedCents: 500,
      planId: null,
      createdAt: 0,
      status: "open",
      closedAt: null,
      closeReason: null,
      committedSellerCatId: "cat-2",
      quotedSellerCents: 100,
      quotedRouteCatIds: ["cat-2", "cat-1", "cat-0"],
      quotedFeesByCatId: { "cat-1": 1 },
    };
    state.demandOrders.push(order);

    expect(removeCat(state, "cat-2").ok).toBe(true);

    expect(order.status).toBe("open");
    expect(order.committedSellerCatId).toBeNull();
    expect(order.quotedRouteCatIds).toBeUndefined();
    expect(state.cats.some((entry) => entry.id === "cat-2")).toBe(false);
  });

  it("cancels a circular procurement graph and releases both cats' reservations", () => {
    const state = marketState();
    state.cats = state.cats.slice(0, 2);
    state.cats[0].escrowReservedCents = 100;
    state.cats[1].escrowReservedCents = 100;
    const orderAB: DemandOrder = {
      id: "order-ab", buyerKind: "cat", buyerCatId: "cat-0", destinationCatId: "cat-0",
      itemId: "wood", maxDeliveredCents: 100, reservedCents: 100, planId: "plan-a",
      createdAt: 0, status: "open", closedAt: null, closeReason: null,
      committedSellerCatId: "cat-1", quotedSellerCents: 100, quotedRouteCatIds: ["cat-1", "cat-0"], quotedFeesByCatId: {},
    };
    const orderBA: DemandOrder = {
      id: "order-ba", buyerKind: "cat", buyerCatId: "cat-1", destinationCatId: "cat-1",
      itemId: "wood", maxDeliveredCents: 100, reservedCents: 100, planId: "plan-b",
      createdAt: 0, status: "open", closedAt: null, closeReason: null,
      committedSellerCatId: "cat-0", quotedSellerCents: 100, quotedRouteCatIds: ["cat-0", "cat-1"], quotedFeesByCatId: {},
    };
    const planA: ProcurementPlan = {
      id: "plan-a", catId: "cat-0", outputItemId: "plank", recipeId: RECIPE_BY_OUTPUT.get("plank")!.id,
      terminalOrderId: orderBA.id, expectedRevenueCents: 200, createdAt: 0, status: "active", reason: "order",
      phase: "funded", bundleOrderIds: [orderAB.id],
    };
    const planB: ProcurementPlan = {
      id: "plan-b", catId: "cat-1", outputItemId: "plank", recipeId: RECIPE_BY_OUTPUT.get("plank")!.id,
      terminalOrderId: orderAB.id, expectedRevenueCents: 200, createdAt: 0, status: "active", reason: "order",
      phase: "funded", bundleOrderIds: [orderBA.id],
    };
    state.demandOrders.push(orderAB, orderBA);
    state.procurementPlans.push(planA, planB);

    const repaired = repairBrokenMarketReferences(state);

    expect(new Set(repaired.cancelledPlanIds)).toEqual(new Set([planA.id, planB.id]));
    expect(state.procurementPlans.every((plan) => plan.status === "cancelled")).toBe(true);
    expect(state.demandOrders.every((order) => order.status === "cancelled")).toBe(true);
    expect(state.cats.map((entry) => entry.escrowReservedCents)).toEqual([0, 0]);
  });

  it("keeps only the oldest persisted active plan for one cat and releases the duplicate bill", () => {
    const state = marketState();
    const order: DemandOrder = {
      id: "order-duplicate", buyerKind: "cat", buyerCatId: "cat-0", destinationCatId: "cat-0",
      itemId: "wood", maxDeliveredCents: 100, reservedCents: 100, planId: "plan-new",
      createdAt: 10, status: "open", closedAt: null, closeReason: null,
      committedSellerCatId: "cat-1", quotedSellerCents: 100, quotedRouteCatIds: ["cat-1", "cat-0"], quotedFeesByCatId: {},
    };
    const oldPlan: ProcurementPlan = {
      id: "plan-old", catId: "cat-0", outputItemId: "wood", recipeId: RECIPE_BY_OUTPUT.get("wood")!.id,
      terminalOrderId: null, expectedRevenueCents: 200, createdAt: 0, status: "active", reason: "external-sale",
      phase: "ready", bundleOrderIds: [],
    };
    const duplicatePlan: ProcurementPlan = {
      id: "plan-new", catId: "cat-0", outputItemId: "plank", recipeId: RECIPE_BY_OUTPUT.get("plank")!.id,
      terminalOrderId: null, expectedRevenueCents: 500, createdAt: 10, status: "active", reason: "external-sale",
      phase: "funded", bundleOrderIds: [order.id],
    };
    state.cats[0].escrowReservedCents = 100;
    state.demandOrders.push(order);
    state.procurementPlans.push(oldPlan, duplicatePlan);

    const repaired = repairBrokenMarketReferences(state);

    expect(repaired.cancelledPlanIds).toContain(duplicatePlan.id);
    expect(oldPlan.status).toBe("active");
    expect(duplicatePlan.status).toBe("cancelled");
    expect(order.status).toBe("cancelled");
    expect(state.cats[0].escrowReservedCents).toBe(0);
  });

  it("creates one sequential supplier plan when a basket needs two units from the same empty cat", () => {
    const state = marketState();
    state.cats = state.cats.slice(0, 2);
    state.cats[0].coins = 100_000;
    state.cats[1].coins = 100_000;
    state.resourceNodes = [{ id: "wood-node", itemId: "wood", position: { x: 2, y: 0 } }];
    state.unlockedRecipes = [RECIPE_BY_OUTPUT.get("wood")!.id, RECIPE_BY_OUTPUT.get("plank")!.id];
    state.discoveryBounties.forEach((bounty) => { bounty.paid = true; bounty.claimedByCatId = null; });
    const plankBounty = state.discoveryBounties.find((bounty) => bounty.itemId === "plank")!;
    plankBounty.paid = false;
    plankBounty.amountCents = 100_000;
    publishBountySignal(state, "plank", "open", "cat-0");

    refreshCatMarket(state, state.cats[0], (itemId) => itemPrice(state, itemId, state.cats[0]));

    const buyerPlan = state.procurementPlans.find((plan) => plan.catId === "cat-0" && plan.outputItemId === "plank");
    const supplierPlans = state.procurementPlans.filter((plan) => plan.status === "active" && plan.catId === "cat-1");
    expect(buyerPlan?.bundleOrderIds).toHaveLength(2);
    expect(supplierPlans).toHaveLength(1);
    expect(supplierPlans[0]).toMatchObject({ outputItemId: "wood", terminalOrderId: buyerPlan?.bundleOrderIds?.[0] });
  });

  it("repairs a schema 14 save with a deleted route cat before scheduling work", () => {
    const raw = structuredClone(marketState());
    const order = contractedOrder("order-save", "cat-2");
    const shipment = contract("contract-4", order.id, ["cat-2", "deleted-cat", "cat-0"]);
    raw.cats[0].debtCents = 100;
    raw.demandOrders.push(order);
    raw.shipmentContracts.push(shipment);

    const migrated = migrateSaveSnapshot(raw);

    expect(migrated.shipmentContracts.some((entry) => entry.id === shipment.id)).toBe(false);
    expect(migrated.demandOrders.find((entry) => entry.id === order.id)?.status).toBe("cancelled");
    expect(migrated.cats.find((entry) => entry.id === "cat-2")?.inventory.wood).toBe(1);
    expect(migrated.cats.find((entry) => entry.id === "cat-0")?.debtCents).toBe(0);
  });

  it("lets an empty resource cat and an empty contract custodian resume legal work", () => {
    const resourceState = createInitialState({ worldSeed: 31 });
    resourceState.procurementPlans = [];
    resourceState.demandOrders = [];
    resourceState.shipmentContracts = [];
    resourceState.discoveryBounties.forEach((bounty) => { bounty.paid = true; bounty.claimedByCatId = null; });
    const resourceCat = resourceState.cats.find((entry) => resourceItemAt(resourceState, entry.position));
    expect(resourceCat).toBeDefined();
    resourceCat!.inventory = {};
    resourceCat!.action = null;
    const siteItem = resourceItemAt(resourceState, resourceCat!.position)!;
    resourceState.unlockedRecipes = [RECIPE_BY_OUTPUT.get(siteItem)!.id];
    decideIdleCats(resourceState, new Set([resourceCat!.id]));
    expect(resourceCat!.action).toMatchObject({ type: "craft", itemId: siteItem });

    const carrierState = createInitialState({ worldSeed: 37 });
    carrierState.cats = [cat(0, 0, 0), cat(1, 1, 0), cat(2, 2, 0)];
    carrierState.resourceNodes = [];
    carrierState.procurementPlans = [];
    carrierState.demandOrders = [contractedOrder("order-carrier", "cat-2")];
    carrierState.shipmentContracts = [contract("contract-5", "order-carrier", ["cat-2", "cat-1", "cat-0"], 1, 5)];
    carrierState.cats[1].inventory = {};
    carrierState.cats[1].action = null;
    decideIdleCats(carrierState, new Set(["cat-1"]));
    expect(carrierState.cats[1].action).toMatchObject({ type: "pass", direction: "west", itemId: "wood", contractId: "contract-5" });
    expect(itemPrice(carrierState, "wood")).toBeGreaterThan(0);
  });
});
