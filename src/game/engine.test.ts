import { describe, expect, it } from "vitest";
import {
  INDUSTRIAL_GATE_RECIPE_IDS,
  INTRO_RECIPE_IDS,
  ITEMS,
  MARKET_CERTIFICATION_ITEM_IDS,
  MARKET_CHALLENGE_RECIPE_IDS,
  RECIPE_BY_OUTPUT,
  recipeUnlockCost,
} from "./catalog";
import {
  advanceGame,
  createInitialState,
  enactLaw,
  itemPrice,
  nextEnactmentCost,
  placeCat,
  removeCat,
  repealLaw,
  unlockRecipe,
} from "./engine";
import { hashSource } from "./lawInterpreter";
import { openDemandOrder } from "./market";
import { GameController } from "./controller";
import type { LawDraft } from "./types";

const PASSIVE_SOURCE = "function decide(ctx) { return null; }";

function draft(category: "behavior" | "price" | "tax" = "price", options: { taxRate?: number; itemId?: string | "*"; multiplier?: number; sourceCode?: string } = {}): LawDraft {
  const sourceCode = options.sourceCode ?? PASSIVE_SOURCE;
  return {
    title: category === "tax" ? "测试税法" : category === "behavior" ? "测试共享逻辑" : "测试价格法",
    playerText: "test",
    summary: "test",
    sourceCode,
    astHash: hashSource(sourceCode),
    examples: [],
    warnings: [],
    category,
    taxRate: category === "tax" ? options.taxRate ?? 1 : null,
    priceItemId: category === "price" ? options.itemId ?? "gear" : null,
    priceMultiplier: category === "price" ? options.multiplier ?? 1.5 : null,
    validation: { syntax: true, safety: true, examplesPassed: 0, examplesTotal: 0, messages: [] },
  };
}

function markIntroDiscovered(state: ReturnType<typeof createInitialState>): void {
  const discovered = new Set(ITEMS.slice(0, 9).map((item) => item.id));
  state.discoveredItems = [...discovered];
  for (const bounty of state.discoveryBounties) {
    if (discovered.has(bounty.itemId)) bounty.paid = true;
  }
  state.marketBroadcasts = state.marketBroadcasts.filter((broadcast) => (
    !discovered.has(broadcast.itemId) || broadcast.kind !== "bounty-open"
  ));
  state.dirtyDecisions = true;
}

function unlockMarketChallenge(state: ReturnType<typeof createInitialState>): void {
  state.treasuryCoins = 1_000_000;
  for (const recipeId of MARKET_CHALLENGE_RECIPE_IDS) expect(unlockRecipe(state, recipeId).ok).toBe(true);
}

describe("deterministic engine", () => {
  it("automatically unlocks and autonomously crafts only the first nine items", () => {
    const state = createInitialState();
    expect(state.cats).toHaveLength(11);
    expect(state.laws).toHaveLength(7);
    expect(state.laws.filter((law) => law.category === "system")).toHaveLength(3);
    expect(state.unlockedRecipes).toEqual(INTRO_RECIPE_IDS);
    expect(state.laws.filter((law) => law.category === "behavior")).toHaveLength(1);

    advanceGame(state, 180_000);
    expect(new Set(state.discoveredItems)).toEqual(new Set(ITEMS.slice(0, 9).map((item) => item.id)));
    expect(state.discoveredItems).not.toContain("thread");
  });

  it("keeps items 10–15 paid but continues the teaching sequence through all fifteen goods", () => {
    const state = createInitialState();
    expect(state.unlockedRecipes).toEqual(INTRO_RECIPE_IDS);
    expect(MARKET_CHALLENGE_RECIPE_IDS.every((id) => !state.unlockedRecipes.includes(id))).toBe(true);
    expect(INDUSTRIAL_GATE_RECIPE_IDS.every((id) => !state.unlockedRecipes.includes(id))).toBe(true);

    unlockMarketChallenge(state);
    expect(unlockRecipe(state, "make_cable")).toMatchObject({ ok: false, error: expect.stringContaining("产业认证") });

    advanceGame(state, 300_000);
    const certified = MARKET_CERTIFICATION_ITEM_IDS.filter((id) => state.itemStats[id].crafted > 0);
    expect(certified).toEqual(MARKET_CERTIFICATION_ITEM_IDS);
    expect(new Set(state.discoveredItems)).toEqual(new Set(ITEMS.slice(0, 15).map((item) => item.id)));
    expect(unlockRecipe(state, "make_cable")).toMatchObject({ ok: true });
  });

  it("lets a price law correct the market and earn a missing certification", () => {
    const state = createInitialState({ worldSeed: 123 });
    markIntroDiscovered(state);
    unlockMarketChallenge(state);
    enactLaw(state, draft("price", { itemId: "thread", multiplier: 10 }));
    advanceGame(state, 120_000);
    expect(state.itemStats.thread.crafted).toBeGreaterThan(0);
  });

  it("keeps a base price and applies only the highest-priority matching price law", () => {
    const state = createInitialState({ withStarter: false });
    const base = itemPrice(state, "gear");
    enactLaw(state, draft("price", { itemId: "gear", multiplier: 2 }));
    expect(itemPrice(state, "gear")).toBe(base * 2);
    enactLaw(state, draft("price", { itemId: "gear", multiplier: 3 }));
    expect(itemPrice(state, "gear")).toBe(base * 3);
    expect(itemPrice(state, "wood")).toBe(100);
  });

  it("opens items 16–20 only after all six production certifications", () => {
    const state = createInitialState({ withStarter: false });
    unlockMarketChallenge(state);
    expect(unlockRecipe(state, "make_memory")).toMatchObject({ ok: false });
    for (const itemId of MARKET_CERTIFICATION_ITEM_IDS) state.itemStats[itemId].crafted = 1;
    const cost = recipeUnlockCost("make_cable");
    expect(cost).toBeGreaterThan(0);
    expect(unlockRecipe(state, "make_cable")).toEqual({ ok: true, cost });
    expect(state.treasuryCoins).toBe(1_000_000 - MARKET_CHALLENGE_RECIPE_IDS.reduce((sum, id) => sum + recipeUnlockCost(id), 0) - cost);
    expect(unlockRecipe(state, "make_cable")).toMatchObject({ ok: false });
  });

  it("settles exactly at 5000ms, only once", () => {
    const state = createInitialState({ withStarter: false });
    state.resourceNodes = [{ id: "wood-test", itemId: "wood", position: { x: 0, y: -1 } }];
    advanceGame(state, 4_999);
    expect(state.cats[0].inventory.wood ?? 0).toBe(0);
    expect(state.cats[0].action?.endsAt).toBe(5_000);
    advanceGame(state, 1);
    expect(state.itemStats.wood.crafted).toBe(1);
    expect(state.discoveryBounties.find((bounty) => bounty.itemId === "wood")?.paid).toBe(true);
    advanceGame(state, 1);
    expect(state.itemStats.wood.crafted).toBe(1);
  });

  it("preserves the action boundary under an explicit test speed multiplier", () => {
    const state = createInitialState({ withStarter: false, simulationSpeed: 5_000 });
    state.resourceNodes = [{ id: "wood-test-fast", itemId: "wood", position: { x: 0, y: -1 } }];
    advanceGame(state, 0.9);
    expect(state.cats[0].inventory.wood ?? 0).toBe(0);
    expect(state.cats[0].action?.endsAt).toBe(1);
    advanceGame(state, 0.1);
    expect(state.itemStats.wood.crafted).toBe(1);
  });

  it("recursively self-supplies an upstream ingredient for its own profitable plan", () => {
    const state = createInitialState({ withStarter: false });
    state.resourceNodes = [{ id: "wood-upstream", itemId: "wood", position: { x: 1, y: 1 } }];
    placeCat(state, { x: 1, y: 0 });
    state.discoveryBounties.forEach((bounty) => { bounty.paid = true; });
    state.marketBroadcasts = [];
    state.unlockedRecipes = ["wood", "fire", "battery"].map((itemId) => RECIPE_BY_OUTPUT.get(itemId)!.id);
    state.procurementPlans.push({
      id: "plan-upstream",
      catId: "cat-0",
      outputItemId: "battery",
      recipeId: RECIPE_BY_OUTPUT.get("battery")!.id,
      terminalOrderId: null,
      expectedRevenueCents: 5_000,
      createdAt: 0,
      status: "active",
      reason: "external-sale",
    });
    state.cats[1].coins = 10_000;
    openDemandOrder(state, {
      buyerKind: "cat",
      buyerCatId: "cat-1",
      destinationCatId: "cat-1",
      itemId: "fire",
      maxDeliveredCents: 1_000,
      reservedCents: 1_000,
      planId: null,
    }, (itemId) => itemPrice(state, itemId));

    advanceGame(state, 1);
    expect(state.cats[0].action).toMatchObject({ type: "craft", recipeId: "make_wood" });
    advanceGame(state, 4_999);
    expect(state.cats[0].action).toMatchObject({ type: "craft", recipeId: "make_fire" });
  });

  it("taxes sales made at the price-law-adjusted value", () => {
    const state = createInitialState({ withStarter: false });
    markIntroDiscovered(state);
    unlockMarketChallenge(state);
    state.treasuryCoins = 0;
    enactLaw(state, draft("tax", { taxRate: 0.5 }));
    enactLaw(state, draft("price", { itemId: "gear", multiplier: 2 }));
    state.cats[0].inventory.gear = 1;
    const expected = itemPrice(state, "gear");
    advanceGame(state, 5_000);
    expect(state.totalSales).toBe(expected);
    expect(state.treasuryCoins).toBe(Math.ceil(expected * 0.5));
    expect(state.cats[0].coins).toBe(expected - Math.ceil(expected * 0.5));
  });

  it("price laws guide the autonomous profit target without action laws", () => {
    const state = createInitialState({ withStarter: false });
    markIntroDiscovered(state);
    unlockMarketChallenge(state);
    enactLaw(state, draft("price", { itemId: "glass", multiplier: 10 }));
    state.cats[0].inventory.glass = 1;
    state.cats[0].inventory.gear = 1;
    advanceGame(state, 1);
    expect(state.cats[0].action).toMatchObject({ type: "sell", itemId: "glass", lawId: "local-greedy" });
  });

  it("replaces the one shared logic function and applies it to every cat", () => {
    const state = createInitialState({ withStarter: false });
    placeCat(state, { x: 1, y: 0 });
    markIntroDiscovered(state);
    state.cats[0].inventory.wood = 1;
    state.cats[1].inventory.wood = 1;
    const source = "function decide(ctx) { if (has(\"wood\")) return { type: \"sell\", itemId: \"wood\" }; return weighted(1, 1, 1); }";
    expect(enactLaw(state, draft("behavior", { sourceCode: source })).ok).toBe(true);
    advanceGame(state, 1);
    expect(state.laws.filter((law) => law.category === "behavior")).toHaveLength(1);
    expect(state.cats.map((cat) => cat.action?.type)).toEqual(["sell", "sell"]);

    const replacement = "function decide(ctx) { return weighted(2, 0.5, 0.25); }";
    expect(enactLaw(state, draft("behavior", { sourceCode: replacement })).ok).toBe(true);
    expect(state.laws.filter((law) => law.category === "behavior")).toHaveLength(1);
    expect(state.lawHistory.some((law) => law.category === "behavior" && law.status === "repealed")).toBe(true);
  });

  it("lets the shared function intervene inside local candidate scoring", () => {
    const state = createInitialState({ withStarter: false });
    markIntroDiscovered(state);
    state.resourceNodes = [];
    state.cats[0].inventory.brick = 1;
    state.cats[0].inventory.gear = 1;
    const source = `function decide(ctx) {
      adjust("sell", "brick", 20, 0);
      return choose();
    }`;
    expect(enactLaw(state, draft("behavior", { sourceCode: source })).ok).toBe(true);
    advanceGame(state, 1);
    expect(state.cats[0].action).toMatchObject({ type: "sell", itemId: "brick" });
  });

  it("resolves simultaneous sales in stable creation order", () => {
    const state = createInitialState({ withStarter: false });
    placeCat(state, { x: 2, y: 0 });
    markIntroDiscovered(state);
    unlockMarketChallenge(state);
    state.cats[0].inventory.gear = 1;
    state.cats[1].inventory.gear = 1;
    const value = itemPrice(state, "gear");
    advanceGame(state, 5_000);
    expect(state.itemStats.gear.sold).toBe(2);
    expect(state.totalSales).toBe(value * 2);
  });

  it("charges lifetime enactments after five free laws and charges repeal from treasury", () => {
    const state = createInitialState({ withStarter: false });
    state.treasuryCoins = 0;
    for (let index = 0; index < 5; index += 1) expect(enactLaw(state, draft()).ok).toBe(true);
    expect(nextEnactmentCost(state)).toBe(500);
    expect(enactLaw(state, draft()).ok).toBe(false);
    state.treasuryCoins = 1_000;
    expect(enactLaw(state, draft()).ok).toBe(true);
    expect(state.treasuryCoins).toBe(500);
    expect(repealLaw(state, state.laws[0].id).ok).toBe(true);
    expect(state.treasuryCoins).toBe(0);
  });

  it("liquidates a deleted cat into the treasury after repaying debt", () => {
    const state = createInitialState({ withStarter: false });
    placeCat(state, { x: 1, y: 0 });
    const cat = state.cats[0];
    cat.coins = 500;
    cat.debtCents = 200;
    cat.inventory.wood = 2;
    state.treasuryCoins = 1_000;
    const woodValue = itemPrice(state, "wood");
    const result = removeCat(state, cat.id);
    expect(result).toMatchObject({
      ok: true,
      settledCents: 500 + woodValue * 2,
      debtRepaidCents: 200,
      treasuryDeltaCents: 500 + woodValue * 2 - 200,
    });
    expect(state.treasuryCoins).toBe(1_000 + 500 + woodValue * 2 - 200);
    expect(state.cats.map((entry) => entry.id)).toEqual(["cat-1"]);
    expect(state.cats[0].inventory.wood).toBeUndefined();
  });

  it("cancels a deleted cat's open orders and rejects deleting the last cat", () => {
    const state = createInitialState({ withStarter: false });
    placeCat(state, { x: 1, y: 0 });
    state.cats[0].coins = 5_000;
    const order = openDemandOrder(state, {
      buyerKind: "cat",
      buyerCatId: state.cats[0].id,
      destinationCatId: state.cats[0].id,
      itemId: "wood",
      maxDeliveredCents: 100,
      reservedCents: 100,
      planId: null,
    }, (itemId) => itemPrice(state, itemId));
    expect(order).not.toBeNull();
    expect(removeCat(state, state.cats[0].id).ok).toBe(true);
    expect(state.demandOrders).toHaveLength(0);
    expect(state.orderSignals).toHaveLength(0);
    expect(removeCat(state, "cat-0")).toMatchObject({ ok: false, error: "cat-not-found" });
    expect(removeCat(state, state.cats[0].id)).toMatchObject({ ok: false, error: "keep-one-cat" });
  });

  it("refunds in-flight escrow without counting contract cargo as deleted-cat stock", () => {
    const state = createInitialState({ withStarter: false });
    placeCat(state, { x: 1, y: 0 });
    const seller = state.cats[0];
    const buyer = state.cats[1];
    buyer.debtCents = 110;
    state.demandOrders.push({
      id: "order-contract",
      buyerKind: "cat",
      buyerCatId: buyer.id,
      destinationCatId: buyer.id,
      itemId: "wood",
      maxDeliveredCents: 110,
      reservedCents: 110,
      planId: null,
      createdAt: 0,
      status: "contracted",
      closedAt: 0,
      closeReason: "test",
    });
    state.shipmentContracts.push({
      id: "contract-test",
      orderId: "order-contract",
      itemId: "wood",
      sellerCatId: seller.id,
      buyerKind: "cat",
      buyerCatId: buyer.id,
      destinationCatId: buyer.id,
      routeCatIds: [seller.id, buyer.id],
      currentLeg: 0,
      custodianCatId: seller.id,
      sellerPriceCents: 110,
      feesByCatId: {},
      escrowCents: 110,
      acceptedAt: 0,
      deliveredAt: null,
      status: "awaiting-pickup",
    });
    seller.action = {
      type: "pass",
      itemId: "wood",
      direction: "east",
      startedAt: 0,
      endsAt: 5_000,
      reserved: { wood: 1 },
      lawId: "binding-contract",
      contractId: "contract-test",
    };
    const result = removeCat(state, seller.id);
    expect(result).toMatchObject({ ok: true, settledCents: 0, treasuryDeltaCents: 0 });
    expect(state.shipmentContracts).toHaveLength(0);
    expect(state.demandOrders).toHaveLength(0);
    expect(state.cats[0]).toMatchObject({ id: buyer.id, debtCents: 0, coins: 0 });
    expect(state.cats[0].inventory.wood).toBeUndefined();
  });

  it("uses keyboard-speed runtime multipliers without changing saved simulation speed", () => {
    const controller = new GameController();
    controller.state = createInitialState({ withStarter: false });
    controller.setSpeed(4);
    expect(controller.getSpeedMultiplier()).toBe(4);
    expect(controller.state.simulationSpeed).toBe(1);
    controller.advance(1_250);
    expect(controller.state.simTime).toBe(5_000);
    controller.setSpeed(1);
    expect(controller.getSpeedMultiplier()).toBe(1);
  });
});
