import { describe, expect, it } from "vitest";
import { RECIPE_BY_OUTPUT } from "./catalog";
import { createInitialState, itemPrice } from "./engine";
import { migrateSaveSnapshot } from "./persistence";
import { openDemandOrder, publishBountySignal, refreshCatMarket } from "./market";
import type { CatState, GameState, ItemId } from "./types";

function makeCat(createdIndex: number, x: number, y: number): CatState {
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
  const state = createInitialState({ withStarter: false, worldSeed: 19 });
  state.cats = [
    makeCat(0, 0, 0),
    makeCat(1, 1, 0),
    makeCat(2, 0, 1),
    makeCat(3, -1, 0),
    makeCat(4, 0, -1),
  ];
  state.nextCatIndex = state.cats.length;
  state.resourceNodes = [];
  state.discoveryBounties.forEach((bounty) => {
    bounty.paid = true;
    bounty.claimedByCatId = null;
  });
  state.marketBroadcasts = [];
  state.procurementPlans = [];
  state.demandOrders = [];
  state.shipmentContracts = [];
  state.unlockedRecipes = [
    RECIPE_BY_OUTPUT.get("wood")!.id,
    RECIPE_BY_OUTPUT.get("water")!.id,
    RECIPE_BY_OUTPUT.get("plank")!.id,
    RECIPE_BY_OUTPUT.get("paper")!.id,
    RECIPE_BY_OUTPUT.get("fire")!.id,
    RECIPE_BY_OUTPUT.get("sand")!.id,
    RECIPE_BY_OUTPUT.get("glass")!.id,
  ];
  return state;
}

function price(state: GameState): (itemId: ItemId) => number {
  return (itemId) => itemPrice(state, itemId, state.cats[0]);
}

function openOnlyBounty(state: GameState, itemId: ItemId, amountCents: number): void {
  const bounty = state.discoveryBounties.find((entry) => entry.itemId === itemId)!;
  bounty.paid = false;
  bounty.claimedByCatId = null;
  bounty.amountCents = amountCents;
  publishBountySignal(state, itemId, "open", state.cats[0].id);
}

describe("reliable quotes and atomic bundle funding", () => {
  it("creates every missing-input order together or creates none", () => {
    const state = marketState();
    state.cats[1].inventory.wood = 1;
    state.cats[2].inventory.water = 1;
    openOnlyBounty(state, "paper", 100_000);

    state.cats[0].coins = 1;
    refreshCatMarket(state, state.cats[0], price(state));
    expect(state.procurementPlans).toHaveLength(0);
    expect(state.demandOrders).toHaveLength(0);
    expect(state.cats[0].escrowReservedCents).toBe(0);
    expect(state.discoveryBounties.find((entry) => entry.itemId === "paper")?.claimedByCatId).toBeNull();

    state.cats[0].coins = 100_000;
    refreshCatMarket(state, state.cats[0], price(state));
    const plan = state.procurementPlans.find((entry) => entry.catId === "cat-0")!;
    const orders = state.demandOrders.filter((entry) => entry.planId === plan.id);
    expect(plan.phase).toBe("funded");
    expect(new Set(orders.map((entry) => entry.itemId))).toEqual(new Set(["wood", "water"]));
    expect(plan.bundleOrderIds).toEqual(orders.map((entry) => entry.id));
    expect(state.cats[0].escrowReservedCents).toBe(orders.reduce((sum, order) => sum + order.reservedCents, 0));
  });

  it("uses exactly the committed bundle costs in the profitability certificate", () => {
    const state = marketState();
    state.cats[0].coins = 100_000;
    state.cats[1].inventory.wood = 1;
    state.cats[2].inventory.water = 1;
    openOnlyBounty(state, "paper", 100_000);

    refreshCatMarket(state, state.cats[0], price(state));
    const plan = state.procurementPlans[0];
    const orders = state.demandOrders.filter((entry) => entry.planId === plan.id);
    expect(orders.every((order) => order.committedSellerCatId && order.quotedRouteCatIds?.length)).toBe(true);
    expect(plan.bundleCostCents).toBe(orders.reduce((sum, order) => sum + order.maxDeliveredCents, 0));
    expect(plan.financingReserveCents).toBe(orders.reduce((sum, order) => sum + order.reservedCents - order.maxDeliveredCents, 0));
    expect(plan.expectedProfitCents).toBe(
      plan.terminalRevenueCents! - plan.bundleCostCents! - plan.financingReserveCents! - plan.alternativeGainCents!,
    );
    expect(plan.expectedProfitCents).toBeGreaterThanOrEqual(1);
    expect(plan.budgetSlackCents).toBe(plan.expectedProfitCents);
  });

  it("chooses the lowest reliable delivered quote and breaks exact ties by cat creation order", () => {
    const state = marketState();
    state.cats[0].coins = 100_000;
    state.cats[1].inventory.wood = 1;
    state.cats[2].inventory.wood = 1;
    state.cats[3].inventory.water = 1;
    openOnlyBounty(state, "paper", 100_000);

    refreshCatMarket(state, state.cats[0], price(state));
    const woodOrder = state.demandOrders.find((entry) => entry.itemId === "wood")!;
    expect(woodOrder.committedSellerCatId).toBe("cat-1");
    expect(woodOrder.maxDeliveredCents).toBe(
      woodOrder.quotedSellerCents! + Object.values(woodOrder.quotedFeesByCatId ?? {}).reduce((sum, fee) => sum + fee, 0),
    );
  });

  it("does not let an unfunded producer monopolize a terminal order", () => {
    const state = marketState();
    state.cats[0].coins = 100_000;
    state.cats[2].inventory.wood = 2;
    state.procurementPlans.push({
      id: "busy-plan", catId: "cat-2", outputItemId: "water", recipeId: "collect_water",
      terminalOrderId: null, expectedRevenueCents: 1, createdAt: 0, status: "active", reason: "bounty",
    });
    const terminal = openDemandOrder(state, {
      buyerKind: "cat",
      buyerCatId: "cat-0",
      destinationCatId: "cat-0",
      itemId: "plank",
      maxDeliveredCents: 50_000,
      reservedCents: 50_000,
      planId: null,
    }, price(state))!;

    refreshCatMarket(state, state.cats[1], price(state));
    expect(state.procurementPlans.some((plan) => plan.terminalOrderId === terminal.id)).toBe(false);

    state.cats[4].coins = 100_000;
    refreshCatMarket(state, state.cats[4], price(state));
    expect(state.procurementPlans.filter((plan) => plan.terminalOrderId === terminal.id)).toHaveLength(1);
  });

  it("cannot turn an economically invalid bundle valid with a score multiplier or bonus", () => {
    const state = marketState();
    state.cats[1].inventory.wood = 1;
    state.cats[2].inventory.water = 1;
    openOnlyBounty(state, "paper", 1);
    state.cats[0].coins = 100_000;

    const hostilePrice = (itemId: ItemId) => itemId === "paper" ? 1 : 10_000;
    refreshCatMarket(state, state.cats[0], hostilePrice, [
      { actionType: "craft", itemId: "paper", multiplier: 100, bonus: 1_000_000 },
    ]);
    expect(state.procurementPlans).toHaveLength(0);
    expect(state.demandOrders).toHaveLength(0);
  });

  it("migrates schema 13 by releasing open reservations while retaining contracted cargo", () => {
    const raw = marketState() as any;
    raw.schemaVersion = 13;
    raw.cats[0].escrowReservedCents = 500;
    raw.procurementPlans.push({
      id: "old-plan", catId: "cat-0", outputItemId: "paper", recipeId: "make_paper",
      terminalOrderId: null, expectedRevenueCents: 1_000, createdAt: 0, status: "active", reason: "external-sale",
    });
    raw.demandOrders.push(
      {
        id: "open-order", buyerKind: "cat", buyerCatId: "cat-0", destinationCatId: "cat-0",
        itemId: "wood", maxDeliveredCents: 500, reservedCents: 500, planId: "old-plan",
        createdAt: 0, status: "open", closedAt: null, closeReason: null,
      },
      {
        id: "contracted-order", buyerKind: "cat", buyerCatId: "cat-0", destinationCatId: "cat-0",
        itemId: "water", maxDeliveredCents: 200, reservedCents: 200, planId: null,
        createdAt: 0, status: "contracted", closedAt: 0, closeReason: "contracted",
      },
    );
    raw.shipmentContracts.push({
      id: "live-contract", orderId: "contracted-order", itemId: "water", sellerCatId: "cat-2",
      buyerKind: "cat", buyerCatId: "cat-0", destinationCatId: "cat-0", routeCatIds: ["cat-2", "cat-0"],
      currentLeg: 0, custodianCatId: "cat-2", sellerPriceCents: 200, feesByCatId: {}, escrowCents: 200,
      acceptedAt: 0, deliveredAt: null, status: "awaiting-pickup",
    });

    const migrated = migrateSaveSnapshot(raw);
    expect(migrated.schemaVersion).toBe(17);
    expect(migrated.cats[0].escrowReservedCents).toBe(0);
    expect(migrated.procurementPlans.find((plan) => plan.id === "old-plan")?.status).toBe("cancelled");
    expect(migrated.demandOrders.find((order) => order.id === "open-order")?.status).toBe("cancelled");
    expect(migrated.demandOrders.find((order) => order.id === "contracted-order")?.status).toBe("contracted");
    expect(migrated.shipmentContracts.find((contract) => contract.id === "live-contract")?.status).toBe("awaiting-pickup");
  });
});
