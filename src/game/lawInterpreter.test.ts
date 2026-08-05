import { describe, expect, it } from "vitest";
import {
  executeLawSource,
  MAX_LAW_AST_DEPTH,
  MAX_LAW_AST_NODES,
  MAX_LAW_SOURCE_BYTES,
  STARTER_LAW_SOURCE,
  STARTER_LIGHT_INDUSTRY_STOCK_SOURCE,
  validateLawSource,
} from "./lawInterpreter";
import type { CatObservation } from "./types";

const observation = (inventory: Record<string, number> = {}): CatObservation => ({
  position: { x: 0, y: 0 },
  inventory,
  neighbors: { north: null, east: null, south: null, west: null },
});

describe("safe law interpreter", () => {
  it("delegates the starter law to the deterministic coin goal", () => {
    expect(executeLawSource(STARTER_LAW_SOURCE, observation(), 200, {
      earnCoins: () => ({ type: "craft", recipeId: "make_wood" }),
    }).action).toEqual({ type: "craft", recipeId: "make_wood" });
    expect(executeLawSource(STARTER_LAW_SOURCE, observation({ wood: 1 }), 200, {
      earnCoins: () => ({ type: "pass", direction: "east", itemId: "wood" }),
    }).action).toEqual({ type: "pass", direction: "east", itemId: "wood" });
  });

  it.each([
    ["loop", "function decide(ctx) { while (true) {} }"],
    ["network", "function decide(ctx) { return fetch('https://example.com'); }"],
    ["prototype", "function decide(ctx) { return ctx.constructor; }"],
    ["mutation", "function decide(ctx) { ctx.inventory.wood = 999; return null; }"],
    ["dynamic code", "function decide(ctx) { return eval('null'); }"],
    ["removed tax helper", "function decide(ctx) { setTax(0.5); return null; }"],
  ])("rejects %s access", (_label, source) => {
    expect(validateLawSource(source).ok).toBe(false);
  });

  it("accepts 4096 AST nodes and rejects the 4097th", () => {
    const exact = `function decide(ctx) {${"0;".repeat(2_044)}return !null;}`;
    const over = `function decide(ctx) {${"0;".repeat(2_044)}return !!null;}`;

    expect(MAX_LAW_AST_NODES).toBe(4_096);
    expect(validateLawSource(exact)).toMatchObject({ ok: true, messages: [] });
    expect(validateLawSource(over)).toMatchObject({
      ok: false,
      messages: expect.arrayContaining([`AST 超过 ${MAX_LAW_AST_NODES} 个节点。`]),
    });
    const executable = `function decide(ctx) {${"0;".repeat(2_044)}return null;}`;
    const executed = executeLawSource(executable, observation());
    expect(executed.action).toBeNull();
    expect(executed.error).toBeUndefined();
  });

  it("measures the source ceiling in UTF-8 bytes", () => {
    const encoder = new TextEncoder();
    const prefix = "function decide(ctx) { return null; }\n/*猫";
    const suffix = "*/";
    const padding = "a".repeat(MAX_LAW_SOURCE_BYTES - encoder.encode(prefix + suffix).byteLength);
    const exact = `${prefix}${padding}${suffix}`;
    const over = `${prefix}${padding}a${suffix}`;

    expect(encoder.encode(exact)).toHaveLength(MAX_LAW_SOURCE_BYTES);
    expect(validateLawSource(exact).ok).toBe(true);
    expect(validateLawSource(over)).toMatchObject({
      ok: false,
      messages: expect.arrayContaining([expect.stringContaining(`源码超过 ${MAX_LAW_SOURCE_BYTES} 字节`)]),
    });
  });

  it("accepts depth 64 and rejects depth 65", () => {
    const atLimit = `function decide(ctx) { return ${"!".repeat(59)}null; }`;
    const overLimit = `function decide(ctx) { return ${"!".repeat(60)}null; }`;

    expect(MAX_LAW_AST_DEPTH).toBe(64);
    expect(validateLawSource(atLimit).ok).toBe(true);
    expect(validateLawSource(overLimit)).toMatchObject({
      ok: false,
      messages: expect.arrayContaining([`AST 深度超过 ${MAX_LAW_AST_DEPTH} 层。`]),
    });
  });

  it("allows coordinate and neighbor helpers", () => {
    const source = `function decide(ctx) {
      if (at(0, 0) && neighborExists("east") && has("wood")) return { type: "pass", direction: "east", itemId: "wood" };
      return null;
    }`;
    const input = observation({ wood: 1 });
    input.neighbors.east = { position: { x: 1, y: 0 }, inventory: {} };
    expect(validateLawSource(source).ok).toBe(true);
    expect(executeLawSource(source, input).action).toEqual({ type: "pass", direction: "east", itemId: "wood" });
  });

  it("lets the shared function mix local conditions with weighted scoring", () => {
    const source = `function decide(ctx) {
      if (nearbyCatCount() >= 2 && nearbyCount("wood") > 0) return weighted(3, 1.5, 0.25);
      return earnCoins();
    }`;
    const input = observation();
    input.nearby = [
      { position: { x: 1, y: 0 }, inventory: { wood: 1 }, distance: 1, resourceItemId: "wood", buildingItemId: null },
      { position: { x: 0, y: 2 }, inventory: {}, distance: 2, resourceItemId: null, buildingItemId: "factory" },
    ];
    const result = executeLawSource(source, input, 200, {
      earnCoins: () => ({ type: "craft", recipeId: "make_stone" }),
      weighted: (craft, pass, sell) => craft === 3 && pass === 1.5 && sell === 0.25
        ? { type: "craft", recipeId: "make_plank" }
        : null,
    });
    expect(validateLawSource(source).ok).toBe(true);
    expect(result.action).toEqual({ type: "craft", recipeId: "make_plank" });
  });

  it("lets DeepSeek alter candidate scoring mid-function and still return a direct action elsewhere", () => {
    const source = `function decide(ctx) {
      if (has("ore") && neighborExists("east")) return { type: "pass", direction: "east", itemId: "ore" };
      if (nearbyCount("wood") >= 2) adjust("pass", "wood", 4, 30);
      adjust("craft", "*", 1.25, 0);
      return choose();
    }`;
    const calls: unknown[][] = [];
    const input = observation();
    input.nearby = [{ position: { x: 0, y: 2 }, inventory: { wood: 2 }, distance: 2, resourceItemId: null, buildingItemId: null }];
    const result = executeLawSource(source, input, 200, {
      adjust: (...args) => { calls.push(args); },
      choose: () => ({ type: "pass", direction: "north", itemId: "wood" }),
    });
    expect(validateLawSource(source).ok).toBe(true);
    expect(calls).toEqual([["pass", "wood", 4, 30], ["craft", "*", 1.25, 0]]);
    expect(result.action).toEqual({ type: "pass", direction: "north", itemId: "wood" });
  });

  it("lets laws prioritize craft candidates when the player warehouse is below a limit", () => {
    const source = `function decide(ctx) {
      if (warehouseCount("plank") < 5) adjust("craft", "plank", 8, 180000);
      return choose();
    }`;
    const low = observation();
    const high = observation();
    const lowCalls: unknown[][] = [];
    const highCalls: unknown[][] = [];

    expect(validateLawSource(source).ok).toBe(true);
    executeLawSource(source, low, 200, { warehouseCount: () => 4, adjust: (...args) => { lowCalls.push(args); }, choose: () => null });
    executeLawSource(source, high, 200, { warehouseCount: () => 5, adjust: (...args) => { highCalls.push(args); }, choose: () => null });

    expect(lowCalls).toEqual([["craft", "plank", 8, 180000]]);
    expect(highCalls).toEqual([]);
  });

  it("exposes cat-authored global broadcasts through read-only helpers", () => {
    const source = `function decide(ctx) {
      if (broadcastCount("demand-open", "wood") > 0 && bestBid("wood") >= 200 && bounty("gear") > 0 && buildingAsk("factory") < 5000) return earnCoins();
      return null;
    }`;
    const input = observation();
    input.heardOrders = [{ id: "order-1", itemId: "wood", effectiveBidCents: 200, sourceCatId: "cat-3" }];
    input.heardBounties = [{ itemId: "gear", amountCents: 4500, sourceCatId: "cat-0" }];
    input.heardBuildingOffers = [{ offerId: "offer-1", itemId: "factory", askCents: 4290, sourceCatId: "cat-7" }];
    input.broadcasts = [{
      id: "broadcast-1",
      kind: "demand-open",
      subjectId: "order-1",
      itemId: "wood",
      sourceCatId: "cat-3",
      amountCents: 200,
      publishedAt: 0,
      reason: null,
    }];
    const result = executeLawSource(source, input, 200, {
      earnCoins: () => ({ type: "craft", recipeId: "make_wood" }),
    });
    expect(validateLawSource(source).ok).toBe(true);
    expect(result.action).toEqual({ type: "craft", recipeId: "make_wood" });
  });

  it("keeps the shipped light-industry regulation inside the deterministic runtime budget", () => {
    const input = observation();
    input.site = { resourceItemId: "ore", resourceItemIds: ["ore"], buildingItemId: null };
    const calls: unknown[][] = [];
    const result = executeLawSource(STARTER_LIGHT_INDUSTRY_STOCK_SOURCE, input, undefined, {
      crafted: () => 0,
      recentCrafted: () => 0,
      adjust: (...args) => { calls.push(args); },
    });

    expect(result.error).toBeUndefined();
    expect(calls).toHaveLength(6);
    expect(calls.at(-1)?.slice(0, 2)).toEqual(["craft", "cable"]);
  });
});
