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
  buyAllCatStockAndSell,
  buildObservation,
  catStockPurchaseQuote,
  createInitialState,
  enactLaw,
  itemPrice,
  nextEnactmentCost,
  placeCat,
  removeCat,
  reorderLaw,
  repealLaw,
  sellWarehouseItem,
  unlockRecipe,
  warehouseSellPrice,
} from "./engine";
import { hashSource, validateLawSource } from "./lawInterpreter";
import { openDemandOrder } from "./market";
import { GameController } from "./controller";
import type { LawDraft } from "./types";

const PASSIVE_SOURCE = "function decide(ctx) { return null; }";

function draft(kind: "behavior" | "price" = "price", options: { itemId?: string | "*"; multiplier?: number; sourceCode?: string } = {}): LawDraft {
  const sourceCode = options.sourceCode ?? (kind === "price"
      ? `function decide(ctx) { setPrice(${JSON.stringify(options.itemId ?? "gear")}, ${options.multiplier ?? 1.5}); return null; }`
      : "function decide(ctx) { return choose(); }");
  return {
    title: kind === "behavior" ? "测试共享逻辑" : "测试价格法",
    playerText: "test",
    summary: "test",
    sourceCode,
    astHash: hashSource(sourceCode),
    examples: [],
    warnings: [],
    program: { version: 2 },
    validation: { syntax: true, safety: true, examplesPassed: 0, examplesTotal: 0, messages: [] },
  };
}

function markIntroDiscovered(state: ReturnType<typeof createInitialState>): void {
  const discovered = new Set(ITEMS.slice(0, 10).map((item) => item.id));
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
  it("exposes production only through cat-authored broadcasts", () => {
    const state = createInitialState({ worldSeed: 1, simulationSpeed: 5_000 });
    advanceGame(state, 30_000 / state.simulationSpeed);
    const observation = buildObservation(state, state.cats[0]);
    expect(observation.broadcasts?.some((entry) => entry.kind === "production-event")).toBe(true);
    const craftedBefore = observation.broadcasts?.find((entry) => entry.kind === "production-total" && entry.itemId === "wood")?.amountCents ?? 0;
    state.playerBuildingInventory.wood = 50;
    expect("warehouse" in buildObservation(state, state.cats[0])).toBe(false);
    expect(buildObservation(state, state.cats[0]).broadcasts?.find((entry) => entry.kind === "production-total" && entry.itemId === "wood")?.amountCents).toBe(craftedBefore);
    advanceGame(state, 61_000 / state.simulationSpeed);
    expect(state.recentProductionEvents.every((event) => state.simTime - event.at <= 60_000 / state.simulationSpeed)).toBe(true);
  });

  it("automatically unlocks and autonomously crafts only the first ten items", () => {
    const state = createInitialState();
    expect(state.cats).toHaveLength(11);
    expect(state.laws).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "starter-law-local-greedy" }),
      expect.objectContaining({ id: "starter-law-workshop-cycle" }),
      expect.objectContaining({ id: "starter-law-discovery-bounty", locked: true }),
    ]));
    expect(state.laws).toHaveLength(6);
    expect(state.laws.filter((law) => law.locked)).toHaveLength(2);
    expect(state.unlockedRecipes).toEqual(INTRO_RECIPE_IDS);
    expect(state.laws.every((law) => law.program.version === 2)).toBe(true);
    expect(state.laws.every((law) => validateLawSource(law.sourceCode).ok)).toBe(true);

    advanceGame(state, 180_000);
    const sharedBehaviorLaw = state.laws.find((law) => law.id === "starter-law-local-greedy")!;
    expect(state.procurementPlans.every((plan) => plan.createdByBehaviorLawId === sharedBehaviorLaw.id)).toBe(true);
    const activeLawIds = new Set(state.laws.filter((law) => law.status === "active").map((law) => law.id));
    expect(state.cats.filter((cat) => cat.action?.type !== "wait").every((cat) => activeLawIds.has(cat.action?.lawId ?? ""))).toBe(true);
    expect(new Set(state.discoveredItems)).toEqual(new Set(ITEMS.slice(0, 10).map((item) => item.id)));
    expect(state.discoveredItems).toContain("thread");
    expect(state.discoveredItems).not.toContain("paper");
  });

  it("keeps items 11–15 paid while asset greed naturally reaches all fifteen goods", () => {
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
    advanceGame(state, 5_000);
    expect(itemPrice(state, "gear")).toBe(base * 2);
    enactLaw(state, draft("price", { itemId: "gear", multiplier: 3 }));
    advanceGame(state, 5_000);
    expect(itemPrice(state, "gear")).toBe(base * 3);
    expect(itemPrice(state, "wood")).toBe(200);
  });

  it("opens items 16–20 only after all five paid production certifications", () => {
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

  it("waits for entry, then settles a 5000ms action exactly once", () => {
    const state = createInitialState({ withStarter: false });
    expect(enactLaw(state, draft("behavior", { sourceCode: "function decide(ctx) { return earnCoins(); }" })).ok).toBe(true);
    state.resourceNodes = [{ id: "wood-test", itemId: "wood", position: { x: 0, y: -1 } }];
    advanceGame(state, 4_999);
    expect(state.cats[0].inventory.wood ?? 0).toBe(0);
    expect(state.cats[0].action?.endsAt).toBe(5_000);
    advanceGame(state, 1);
    expect(state.cats[0].action).toMatchObject({ type: "craft", itemId: "wood", endsAt: 10_000 });
    expect(state.itemStats.wood.crafted).toBe(0);
    advanceGame(state, 4_999);
    expect(state.itemStats.wood.crafted).toBe(0);
    advanceGame(state, 1);
    expect(state.itemStats.wood.crafted).toBe(1);
    expect(state.discoveryBounties.find((bounty) => bounty.itemId === "wood")?.paid).toBe(true);
    advanceGame(state, 1);
    expect(state.itemStats.wood.crafted).toBe(1);
  });

  it("preserves the action boundary under an explicit test speed multiplier", () => {
    const state = createInitialState({ withStarter: false, simulationSpeed: 5_000 });
    expect(enactLaw(state, draft("behavior", { sourceCode: "function decide(ctx) { return earnCoins(); }" })).ok).toBe(true);
    state.resourceNodes = [{ id: "wood-test-fast", itemId: "wood", position: { x: 0, y: -1 } }];
    advanceGame(state, 0.9);
    expect(state.cats[0].inventory.wood ?? 0).toBe(0);
    expect(state.cats[0].action?.endsAt).toBe(1);
    advanceGame(state, 0.1);
    expect(state.cats[0].action).toMatchObject({ type: "craft", endsAt: 2 });
    expect(state.itemStats.wood.crafted).toBe(0);
    advanceGame(state, 0.9);
    expect(state.itemStats.wood.crafted).toBe(0);
    advanceGame(state, 0.1);
    expect(state.itemStats.wood.crafted).toBe(1);
  });

  it("keeps one plan per cat while a seller fulfills a paid order", () => {
    const state = createInitialState({ withStarter: false });
    expect(enactLaw(state, draft("behavior", { sourceCode: "function decide(ctx) { return earnCoins(); }" })).ok).toBe(true);
    state.resourceNodes = [{ id: "wood-upstream", itemId: "wood", position: { x: 1, y: 1 } }];
    placeCat(state, { x: 1, y: 0 });
    state.discoveryBounties.forEach((bounty) => { bounty.paid = true; });
    state.marketBroadcasts = [];
    state.unlockedRecipes = ["wood", "fire"].map((itemId) => RECIPE_BY_OUTPUT.get(itemId)!.id);
    state.cats[1].inventory.wood = 1;
    state.cats[0].coins = 10_000;
    openDemandOrder(state, {
      buyerKind: "cat",
      buyerCatId: "cat-0",
      destinationCatId: "cat-0",
      itemId: "fire",
      maxDeliveredCents: 1_000,
      reservedCents: 1_000,
      planId: null,
    }, (itemId) => itemPrice(state, itemId));

    advanceGame(state, 5_000);
    expect(state.cats[0].action).toMatchObject({ type: "craft", recipeId: "make_wood" });
    expect(state.cats[1].action).toMatchObject({ type: "craft", recipeId: "make_fire" });
    expect(state.procurementPlans.filter((plan) => plan.catId === "cat-0" && plan.status === "active")).toHaveLength(1);
    expect(state.procurementPlans.filter((plan) => plan.catId === "cat-1" && plan.status === "active")).toHaveLength(1);
    expect(state.procurementPlans.find((plan) => plan.catId === "cat-1" && plan.outputItemId === "fire"))
      .toMatchObject({ terminalOrderId: expect.any(String), createdByBehaviorLawId: expect.any(String) });
  });

  it("sells player warehouse stock at fixed base x2 without price-law effects", () => {
    const state = createInitialState({ withStarter: false });
    markIntroDiscovered(state);
    unlockMarketChallenge(state);
    state.treasuryCoins = 0;
    enactLaw(state, draft("price", { itemId: "gear", multiplier: 2 }));
    state.playerBuildingInventory.gear = 1;
    const expected = warehouseSellPrice("gear");
    expect(sellWarehouseItem(state, "gear")).toMatchObject({ ok: true, revenueCents: expected });
    expect(state.totalSales).toBe(expected);
    expect(state.treasuryCoins).toBe(expected);
    expect(state.cats[0].coins).toBe(0);
  });

  it("price laws change acquisition quotes but never make a cat sell", () => {
    const state = createInitialState({ withStarter: false });
    markIntroDiscovered(state);
    unlockMarketChallenge(state);
    enactLaw(state, draft("price", { itemId: "glass", multiplier: 10 }));
    state.cats[0].inventory.glass = 1;
    state.cats[0].inventory.gear = 1;
    advanceGame(state, 5_000);
    const quote = catStockPurchaseQuote(state, state.cats[0].id);
    expect(quote.lines.find((line) => line.itemId === "glass")?.unitPriceCents).toBeGreaterThan(warehouseSellPrice("glass"));
    expect(state.cats[0].action?.type).toBe("wait");
  });

  it("keeps immutable decision laws independently ordered instead of replacing them", () => {
    const state = createInitialState({ withStarter: false });
    placeCat(state, { x: 1, y: 0 });
    markIntroDiscovered(state);
    state.cats[0].inventory.wood = 1;
    state.cats[1].inventory.wood = 1;
    const source = "function decide(ctx) { if (has(\"wood\")) return { type: \"sell\", itemId: \"wood\" }; return weighted(1, 1, 1); }";
    expect(enactLaw(state, draft("behavior", { sourceCode: source })).ok).toBe(true);
    advanceGame(state, 5_000);
    expect(state.laws).toHaveLength(1);
    expect(state.cats.every((cat) => ["craft", "pass", "wait", undefined].includes(cat.action?.type))).toBe(true);

    const replacement = "function decide(ctx) { return weighted(2, 0.5, 0.25); }";
    expect(enactLaw(state, draft("behavior", { sourceCode: replacement })).ok).toBe(true);
    expect(state.laws).toHaveLength(2);
    expect(state.lawHistory).toHaveLength(2);
  });

  it("does not plan or act outside the active shared behavior law", () => {
    const state = createInitialState({ withStarter: false });
    expect(enactLaw(state, draft("behavior", { sourceCode: PASSIVE_SOURCE })).ok).toBe(true);

    advanceGame(state, 30_000);

    expect(state.laws.filter((law) => law.status === "active")).toHaveLength(1);
    expect(state.cats.every((cat) => cat.action?.type === "wait")).toBe(true);
    expect(state.procurementPlans).toHaveLength(0);
    expect(state.demandOrders).toHaveLength(0);
    expect(state.shipmentContracts).toHaveLength(0);
    expect(state.discoveredItems).toHaveLength(0);
    expect(state.logisticsStatus).toHaveLength(0);
  });

  it("attributes every new plan and action to the one active shared behavior function", () => {
    const state = createInitialState({ worldSeed: 37 });
    advanceGame(state, 5_000);

    const behavior = state.laws.find((law) => law.id === "starter-law-local-greedy")!;
    expect(behavior).toBeDefined();
    expect(state.procurementPlans.length).toBeGreaterThan(0);
    expect(state.procurementPlans.every((plan) => plan.createdByBehaviorLawId === behavior.id)).toBe(true);
    const activeLawIds = new Set(state.laws.filter((law) => law.status === "active").map((law) => law.id));
    expect(state.cats.filter((cat) => cat.action?.type !== "wait").every((cat) => activeLawIds.has(cat.action?.lawId ?? ""))).toBe(true);
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
    advanceGame(state, 5_000);
    expect(state.cats[0].action?.type).toBe("wait");
  });

  it("atomically buys and resells simultaneous stock from cats in stable order", () => {
    const state = createInitialState({ withStarter: false });
    placeCat(state, { x: 2, y: 0 });
    markIntroDiscovered(state);
    unlockMarketChallenge(state);
    state.cats[0].inventory.gear = 1;
    state.cats[1].inventory.gear = 1;
    const quote = catStockPurchaseQuote(state);
    state.treasuryCoins = quote.requiredTreasuryCents;
    expect(buyAllCatStockAndSell(state)).toMatchObject({ ok: true, quantity: 2 });
    expect(state.itemStats.gear.sold).toBe(2);
    expect(state.totalSales).toBe(warehouseSellPrice("gear") * 2);
    expect(state.cats.every((cat) => (cat.inventory.gear ?? 0) === 0)).toBe(true);
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
    expect(removeCat(state, "cat-0")).toMatchObject({ ok: false, error: "cat-not-found" });
    expect(removeCat(state, state.cats[0].id)).toMatchObject({ ok: false, error: "keep-one-cat" });
  });

  it("returns contract cargo before liquidating a deleted seller and refunds the buyer escrow", () => {
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
    const recoveredCargoValue = itemPrice(state, "wood", seller);
    expect(result).toMatchObject({ ok: true, settledCents: recoveredCargoValue, treasuryDeltaCents: recoveredCargoValue });
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

  it("interprets every active decision law exactly once for each cat that just completed", () => {
    const state = createInitialState({ withStarter: false });
    const source = "function decide(ctx) { adjust('craft', '*', 1, 1); return choose(); }";
    expect(enactLaw(state, draft("behavior", { sourceCode: source })).ok).toBe(true);
    expect(enactLaw(state, draft("behavior", { sourceCode: source })).ok).toBe(true);
    const decisionLaws = state.laws;

    advanceGame(state, 4_999);
    expect(decisionLaws.map((law) => law.hitCount)).toEqual([0, 0]);
    advanceGame(state, 1);
    expect(decisionLaws.map((law) => law.hitCount)).toEqual([1, 1]);
    advanceGame(state, 4_999);
    expect(decisionLaws.map((law) => law.hitCount)).toEqual([1, 1]);
    advanceGame(state, 1);
    expect(decisionLaws.map((law) => law.hitCount)).toEqual([2, 2]);
  });

  it("does not let one completed cat trigger a staggered cat's decision", () => {
    const state = createInitialState({ withStarter: false });
    placeCat(state, { x: 1, y: 0 });
    const source = "function decide(ctx) { return choose(); }";
    expect(enactLaw(state, draft("behavior", { sourceCode: source })).ok).toBe(true);
    const law = state.laws[0]!;
    state.cats[1].action!.endsAt = 7_000;

    advanceGame(state, 5_000);
    expect(law.hitCount).toBe(1);
    expect(state.cats[1].action?.endsAt).toBe(7_000);
    advanceGame(state, 1_999);
    expect(law.hitCount).toBe(1);
    advanceGame(state, 1);
    expect(law.hitCount).toBe(2);
  });

  it("does not wake cats for received stock or law enact, reorder and repeal", () => {
    const state = createInitialState({ withStarter: false });
    const source = "function decide(ctx) { return choose(); }";
    const first = enactLaw(state, draft("behavior", { sourceCode: source })).law!;
    const second = enactLaw(state, draft("behavior", { sourceCode: source })).law!;
    advanceGame(state, 1_000);
    const originalEnd = state.cats[0].action?.endsAt;

    state.cats[0].inventory.wood = 1; // Receiving a shipment mutates inventory immediately.
    expect(reorderLaw(state, second.id, 1)).toBe(true);
    state.treasuryCoins = 500;
    expect(repealLaw(state, first.id).ok).toBe(true);
    expect(state.cats[0].action?.endsAt).toBe(originalEnd);
    expect(second.hitCount).toBe(0);

    advanceGame(state, 3_999);
    expect(second.hitCount).toBe(0);
    advanceGame(state, 1);
    expect(second.hitCount).toBe(1);
  });
});
