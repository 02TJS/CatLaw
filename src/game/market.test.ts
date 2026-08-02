import { describe, expect, it } from "vitest";
import { RECIPE_BY_ID, RECIPE_BY_OUTPUT, TUTORIAL_RECIPE_IDS } from "./catalog";
import {
  advanceGame,
  buyBuildingOffer,
  createInitialState,
  decideIdleCats,
  itemPrice,
  reorderLaw,
  repealLaw,
} from "./engine";
import { hashSource } from "./lawInterpreter";
import {
  acceptProfitableOrders,
  applyPrivateIncome,
  bountyBroadcastsForCat,
  broadcastsForCat,
  buildingOfferBroadcastsForCat,
  cancelDemandOrder,
  claimDiscoveryBounty,
  completeProcurementPlan,
  findTransportRoute,
  openDemandOrder,
  publishBountySignal,
  propagateOrderSignals,
  refreshCatMarket,
  settleContractLeg,
  signalsForCat,
} from "./market";
import type { CatState, GameState } from "./types";

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
  };
}

function lineState(length: number): GameState {
  const state = createInitialState({ withStarter: false, worldSeed: 7 });
  const systemLaws = createInitialState({ worldSeed: 7 }).laws.filter((law) => law.category === "system");
  state.cats = Array.from({ length }, (_, index) => cat(index, index, 0));
  state.nextCatIndex = length;
  state.resourceNodes = [];
  state.laws = structuredClone(systemLaws);
  state.lawHistory = structuredClone(systemLaws);
  state.discoveryBounties.forEach((bounty) => { bounty.paid = true; });
  state.marketBroadcasts = [];
  state.discoveredItems = TUTORIAL_RECIPE_IDS.map((id) => RECIPE_BY_ID.get(id)!.output);
  state.unlockedRecipes = [RECIPE_BY_OUTPUT.get("wood")!.id];
  state.dirtyDecisions = false;
  return state;
}

function price(state: GameState) {
  return (itemId: string) => itemPrice(state, itemId);
}

function orderWood(state: GameState, destinationCatId = "cat-0") {
  return openDemandOrder(state, {
    buyerKind: "cat",
    buyerCatId: destinationCatId,
    destinationCatId,
    itemId: "wood",
    maxDeliveredCents: 200,
    reservedCents: 200,
    planId: null,
  }, price(state));
}

describe("self-interested broadcast market", () => {
  it("makes a cat-authored order globally visible immediately without copying it per cat", () => {
    const state = lineState(3);
    const order = orderWood(state)!;
    expect(state.orderSignals.filter((signal) => signal.orderId === order.id)).toHaveLength(1);
    expect(state.orderSignals[0].catId).toBe("*");
    expect(signalsForCat(state, "cat-0").some((signal) => signal.orderId === order.id)).toBe(true);
    expect(signalsForCat(state, "cat-2").some((signal) => signal.orderId === order.id)).toBe(true);
    expect(broadcastsForCat(state, "cat-2").find((entry) => entry.subjectId === order.id)).toMatchObject({
      kind: "demand-open",
      sourceCatId: "cat-0",
    });
    expect(propagateOrderSignals(state)).toBe(false);
  });

  it("keeps the global broadcast immediate while exposing at most two orders per item to each cat", () => {
    const state = lineState(2);
    state.cats[0].coins = 10_000;
    const orders = [orderWood(state)!, orderWood(state)!, orderWood(state)!];
    expect(state.orderSignals.filter((signal) => orders.some((order) => order.id === signal.orderId))).toHaveLength(3);
    const initiallyVisible = signalsForCat(state, "cat-1").filter((signal) => orders.some((order) => order.id === signal.orderId));
    expect(initiallyVisible).toHaveLength(2);

    expect(cancelDemandOrder(state, initiallyVisible[0].orderId, "test rotation")).toBe(true);
    const visibleAfterClose = signalsForCat(state, "cat-1").filter((signal) => orders.some((order) => order.id === signal.orderId));
    expect(visibleAfterClose).toHaveLength(2);
    expect(visibleAfterClose.some((signal) => !initiallyVisible.some((entry) => entry.orderId === signal.orderId))).toBe(true);
  });

  it("closes an order with an immediate global lifecycle broadcast", () => {
    const state = lineState(3);
    const order = orderWood(state)!;
    expect(cancelDemandOrder(state, order.id, "预算失效")).toBe(true);
    expect(signalsForCat(state, "cat-0").some((signal) => signal.orderId === order.id)).toBe(false);
    expect(signalsForCat(state, "cat-2").some((signal) => signal.orderId === order.id)).toBe(false);
    expect(state.orderSignals.some((signal) => signal.orderId === order.id)).toBe(false);
    expect(broadcastsForCat(state, "cat-2").find((entry) => entry.subjectId === order.id)).toMatchObject({
      kind: "demand-cancelled",
      sourceCatId: "cat-0",
    });
    expect(state.marketEvents.at(-1)).toMatchObject({ orderId: order.id, kind: "cancelled" });
  });

  it("lets a connected remote cat react to an order in the same decision cycle", () => {
    const state = lineState(4);
    state.unlockedRecipes.push(RECIPE_BY_OUTPUT.get("plank")!.id);
    state.cats[0].coins = 10_000;
    state.cats[3].coins = 10_000;
    const order = openDemandOrder(state, {
      buyerKind: "cat", buyerCatId: "cat-0", destinationCatId: "cat-0",
      itemId: "plank", maxDeliveredCents: 10_000, reservedCents: 10_000, planId: null,
    }, price(state))!;
    refreshCatMarket(state, state.cats[3], price(state));
    expect(state.procurementPlans.some((plan) => plan.catId === "cat-3" && plan.terminalOrderId === order.id)).toBe(true);
    expect(findTransportRoute(state, "cat-3", "cat-0")).toEqual(["cat-3", "cat-2", "cat-1", "cat-0"]);
  });

  it("lets an order producer quote above input opportunity cost and locks that price into the contract", () => {
    const state = lineState(2);
    const taxLaw = createInitialState({ worldSeed: 7 }).laws.find((law) => law.category === "tax")!;
    state.laws.push(structuredClone(taxLaw));
    state.unlockedRecipes.push(
      RECIPE_BY_OUTPUT.get("sand")!.id,
      RECIPE_BY_OUTPUT.get("fire")!.id,
      RECIPE_BY_OUTPUT.get("glass")!.id,
    );
    state.cats[0].coins = 10_000;
    state.cats[1].coins = 10_000;
    const order = openDemandOrder(state, {
      buyerKind: "cat", buyerCatId: "cat-0", destinationCatId: "cat-0",
      itemId: "glass", maxDeliveredCents: 400, reservedCents: 400, planId: null,
    }, price(state))!;

    refreshCatMarket(state, state.cats[1], price(state));
    const plan = state.procurementPlans.find((entry) => entry.terminalOrderId === order.id)!;
    expect(plan).toMatchObject({ outputItemId: "glass", expectedRevenueCents: 326, status: "active" });

    state.cats[1].inventory.glass = 1;
    acceptProfitableOrders(state, price(state));
    expect(state.shipmentContracts[0]).toMatchObject({ orderId: order.id, sellerPriceCents: 326 });
    expect(state.orderSignals.some((signal) => signal.orderId === order.id)).toBe(false);
  });

  it("lets a cat claim only a locally valid public bounty without selecting a global owner", () => {
    const state = lineState(2);
    state.discoveryBounties.forEach((bounty) => { bounty.paid = bounty.itemId !== "wood"; bounty.claimedByCatId = null; });
    publishBountySignal(state, "wood", "open", "cat-0");
    state.resourceNodes = [{ id: "wood-node", itemId: "wood", position: { x: -1, y: -1 } }];
    refreshCatMarket(state, state.cats[1], price(state));
    expect(state.procurementPlans.some((plan) => plan.catId === "cat-1" && plan.outputItemId === "wood")).toBe(false);
    refreshCatMarket(state, state.cats[0], price(state));
    expect(state.procurementPlans).toHaveLength(1);
    expect(state.procurementPlans[0]).toMatchObject({ catId: "cat-0", outputItemId: "wood", reason: "bounty" });
  });

  it("announces and closes a bounty globally while the ledger pays it only once", () => {
    const state = lineState(3);
    state.discoveryBounties.forEach((bounty) => { bounty.paid = bounty.itemId !== "wood"; bounty.claimedByCatId = null; });
    publishBountySignal(state, "wood", "open", "cat-1");
    expect(bountyBroadcastsForCat(state, "cat-0")[0]).toMatchObject({ itemId: "wood", sourceCatId: "cat-1" });
    expect(bountyBroadcastsForCat(state, "cat-2")[0]).toMatchObject({ itemId: "wood", sourceCatId: "cat-1" });
    expect(state.discoveryBounties.find((entry) => entry.itemId === "wood")?.claimedByCatId).toBeNull();
    expect(claimDiscoveryBounty(state, "cat-0", "wood")).toBe(true);
    expect(claimDiscoveryBounty(state, "cat-1", "wood")).toBe(false);
    const amount = state.discoveryBounties.find((entry) => entry.itemId === "wood")!.amountCents;
    expect(completeProcurementPlan(state, "cat-0", "wood")).toBe(amount);
    expect(completeProcurementPlan(state, "cat-1", "wood")).toBe(0);
    expect(bountyBroadcastsForCat(state, "cat-2")).toEqual([]);
    expect(broadcastsForCat(state, "cat-2")[0]).toMatchObject({ kind: "bounty-closed", sourceCatId: "cat-0" });
  });

  it("keeps post-tutorial bounties visible but waits for positive price guidance", () => {
    const state = lineState(2);
    state.unlockedRecipes.push(RECIPE_BY_OUTPUT.get("cable")!.id);
    state.discoveryBounties.forEach((bounty) => {
      bounty.paid = bounty.itemId !== "cable";
      bounty.claimedByCatId = null;
    });
    publishBountySignal(state, "cable", "open", "cat-0");
    state.cats[1].coins = 10_000;

    refreshCatMarket(state, state.cats[1], price(state));
    expect(bountyBroadcastsForCat(state, "cat-1")).toEqual([
      expect.objectContaining({ itemId: "cable", kind: "bounty-open" }),
    ]);
    expect(state.procurementPlans.some((plan) => plan.outputItemId === "cable")).toBe(false);

    const starterPriceLaw = createInitialState({ worldSeed: 7 }).laws.find((law) => law.category === "price")!;
    state.laws.push({
      ...structuredClone(starterPriceLaw),
      id: "cable-guidance",
      priceItemId: "cable",
      priceMultiplier: 2,
    });
    refreshCatMarket(state, state.cats[1], price(state));
    expect(state.procurementPlans.some((plan) => plan.outputItemId === "cable" && plan.reason === "bounty")).toBe(true);
  });

  it("broadcasts building offers and their purchase closure from the seller cat", () => {
    const state = lineState(2);
    state.cats[1].inventory.factory = 1;
    state.treasuryCoins = 1_000_000;
    refreshCatMarket(state, state.cats[1], price(state));
    const offer = state.buildingOffers[0];
    expect(buildingOfferBroadcastsForCat(state, "cat-0")[0]).toMatchObject({
      subjectId: offer.id,
      itemId: "factory",
      sourceCatId: "cat-1",
    });
    expect(buyBuildingOffer(state, offer.id)).toEqual({ ok: true });
    expect(buildingOfferBroadcastsForCat(state, "cat-0")).toEqual([]);
    expect(broadcastsForCat(state, "cat-0")[0]).toMatchObject({ kind: "building-offer-closed", sourceCatId: "cat-1" });
  });

  it("shares order information across a broken chain but refuses physical delivery without a route", () => {
    const state = lineState(3);
    state.cats[2].position = { x: 5, y: 0 };
    state.cats[2].inventory.wood = 1;
    const order = orderWood(state)!;
    expect(signalsForCat(state, "cat-2").some((signal) => signal.orderId === order.id)).toBe(true);
    expect(findTransportRoute(state, "cat-2", "cat-0")).toBeNull();
    acceptProfitableOrders(state, price(state));
    expect(state.shipmentContracts).toEqual([]);
    expect(order.status).toBe("open");
  });

  it("accepts a concurrently visible single-item order only once", () => {
    const state = lineState(4);
    state.cats[2].inventory.wood = 1;
    state.cats[3].position = { x: 1, y: 1 };
    state.cats[3].inventory.wood = 1;
    const order = orderWood(state)!;
    propagateOrderSignals(state);
    propagateOrderSignals(state);
    acceptProfitableOrders(state, price(state));
    expect(state.shipmentContracts).toHaveLength(1);
    expect(order.status).toBe("contracted");
    expect(signalsForCat(state, "cat-3").some((signal) => signal.orderId === order.id)).toBe(false);
    expect(state.orderSignals.some((signal) => signal.orderId === order.id)).toBe(false);
    expect(broadcastsForCat(state, "cat-3").find((entry) => entry.subjectId === order.id)).toMatchObject({ kind: "demand-contracted" });
    expect((state.cats[2].inventory.wood ?? 0) + (state.cats[3].inventory.wood ?? 0)).toBe(1);
    expect(cancelDemandOrder(state, order.id, "成交后反悔")).toBe(false);
  });

  it("charges 2% credit with a one-cent minimum and repays debt before cash", () => {
    const state = lineState(2);
    state.cats[1].inventory.wood = 1;
    orderWood(state);
    propagateOrderSignals(state);
    acceptProfitableOrders(state, price(state));
    expect(state.cats[0].debtCents).toBe(104);
    expect(state.laws.find((law) => law.id === "starter-law-private-credit")?.hitCount).toBe(1);
    applyPrivateIncome(state.cats[0], 60);
    expect(state.cats[0]).toMatchObject({ debtCents: 44, coins: 0 });
    applyPrivateIncome(state.cats[0], 50);
    expect(state.cats[0]).toMatchObject({ debtCents: 0, coins: 6 });
  });

  it("keeps in-transit cargo out of carrier inventory and pays each completed leg", () => {
    const state = lineState(3);
    state.cats[2].inventory.wood = 1;
    orderWood(state);
    propagateOrderSignals(state);
    propagateOrderSignals(state);
    acceptProfitableOrders(state, price(state));
    const contract = state.shipmentContracts[0];
    expect(contract.routeCatIds).toEqual(["cat-2", "cat-1", "cat-0"]);
    const first = settleContractLeg(state, contract.id)!;
    expect(first.delivered).toBe(false);
    expect(contract.custodianCatId).toBe("cat-1");
    expect(state.cats[1].inventory.wood).toBeUndefined();
    expect(state.cats[2].coins).toBe(contract.sellerPriceCents);
    const second = settleContractLeg(state, contract.id)!;
    expect(second.delivered).toBe(true);
    expect(state.cats[0].inventory.wood).toBe(1);
    expect(state.cats[1].coins).toBe(contract.feesByCatId["cat-1"]);
    expect(state.laws.find((law) => law.id === "starter-law-cent-settlement")?.hitCount).toBe(2);
  });

  it("rejects free passing even when generated shared logic requests it", () => {
    const state = lineState(2);
    state.cats[0].inventory.wood = 1;
    const sourceCode = 'function decide(ctx) { return { type: "pass", direction: "east", itemId: "wood" }; }';
    state.laws.unshift({
      id: "law-free-pass",
      title: "无偿传递测试",
      playerText: "向东传木材",
      summary: "应被经济门槛拒绝",
      sourceCode,
      astHash: hashSource(sourceCode),
      examples: [],
      warnings: [],
      enactedAt: 0,
      category: "behavior",
      taxRate: null,
      priceItemId: null,
      priceMultiplier: null,
      hitCount: 0,
      invalidCount: 0,
      consecutiveFaults: 0,
      status: "active",
    });
    state.dirtyDecisions = true;
    decideIdleCats(state);
    expect(state.cats[0].action?.type).not.toBe("pass");
    expect(state.cats[0].decisionTrace.join(" ")).toContain("没有对价");
    expect(state.shipmentContracts).toHaveLength(0);
    expect(state.laws.find((law) => law.id === "law-free-pass")?.invalidCount).toBeGreaterThanOrEqual(1);
  });

  it("lists and atomically sells a cat-owned building into the player building inventory", () => {
    const state = lineState(1);
    state.cats[0].inventory.factory = 1;
    state.treasuryCoins = 1_000_000;
    const before = state.treasuryCoins;
    decideIdleCats(state);
    const offer = state.buildingOffers.find((entry) => entry.status === "open" && entry.itemId === "factory")!;
    expect(offer).toBeDefined();
    expect(buyBuildingOffer(state, offer.id)).toEqual({ ok: true });
    expect(buyBuildingOffer(state, offer.id)).toMatchObject({ ok: false });
    expect(state.playerBuildingInventory.factory).toBe(1);
    expect(state.buildings).toHaveLength(0);
    expect(state.cats[0].inventory.factory).toBeUndefined();
    expect(state.cats[0].coins).toBeGreaterThan(0);
    expect(state.treasuryCoins).toBeLessThan(before);
  });

  it("presents cents, credit and discovery bounty as locked system laws", () => {
    const state = createInitialState({ worldSeed: 11 });
    const systemLaws = state.laws.filter((law) => law.category === "system");
    expect(systemLaws.map((law) => law.title)).toEqual(["分币结算法", "猫咪信用法", "全品类首次发现悬赏法"]);
    expect(systemLaws.every((law) => law.locked && law.status === "active")).toBe(true);
    expect(reorderLaw(state, systemLaws[0].id, 1)).toBe(false);
    expect(repealLaw(state, systemLaws[1].id)).toMatchObject({ ok: false, error: "基础经济法不可废止" });
    advanceGame(state, 5_000);
    expect(state.discoveryBounties.some((bounty) => bounty.paid)).toBe(true);
    expect(state.laws.find((law) => law.id === "starter-law-discovery-bounty")?.hitCount).toBeGreaterThan(0);
  });
});
