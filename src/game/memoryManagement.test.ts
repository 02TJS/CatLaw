import { describe, expect, it } from "vitest";
import { EmojiCanvasCache } from "../ui/emojiCanvasCache";
import {
  CLOSED_MARKET_HISTORY_LIMIT,
  LAW_HISTORY_LIMIT,
  advanceGame,
  buyBuildingOffer,
  compactGameStateHistory,
  createInitialState,
  itemPrice,
} from "./engine";
import { MAX_CACHED_LAW_ASTS, cachedLawAstCount, validateLawSource } from "./lawInterpreter";
import { syncBuildingOffers } from "./market";

describe("memory management bounds", () => {
  it("keeps only the current DPR and applies an LRU bound to emoji canvases", () => {
    const cache = new EmojiCanvasCache<{ id: number; ratio: number }>(3);
    let created = 0;
    const get = (emoji: string, dpr: number) => cache.get(emoji, 25, dpr, (ratio) => ({ id: ++created, ratio }));

    const first = get("A", 1);
    expect(get("A", 1)).toBe(first);
    get("B", 1);
    get("C", 1);
    get("D", 1);
    expect(cache.size).toBe(3);
    expect(get("A", 1)).not.toBe(first);

    const newScale = get("A", 1.234);
    expect(newScale.ratio).toBe(1.23);
    expect(cache.size).toBe(1);
  });

  it("caps parsed law ASTs even after many distinct valid programs", () => {
    for (let index = 0; index < MAX_CACHED_LAW_ASTS + 24; index += 1) {
      const source = `function decide(ctx) { if (count('wood') > ${index}) return choose(); return null; }`;
      expect(validateLawSource(source).ok).toBe(true);
    }
    expect(cachedLawAstCount()).toBeLessThanOrEqual(MAX_CACHED_LAW_ASTS);
  });

  it("retains open offers but bounds closed offers and their broadcasts", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 9_901 });
    const seller = state.cats[0];
    state.treasuryCoins = 1_000_000_000;
    for (let index = 0; index < CLOSED_MARKET_HISTORY_LIMIT + 40; index += 1) {
      seller.inventory.factory = (seller.inventory.factory ?? 0) + 1;
      syncBuildingOffers(state, (itemId) => itemPrice(state, itemId, seller));
      const offer = state.buildingOffers.find((entry) => entry.status === "open")!;
      expect(buyBuildingOffer(state, offer.id)).toEqual({ ok: true });
    }
    seller.inventory.factory = 1;
    syncBuildingOffers(state, (itemId) => itemPrice(state, itemId, seller));
    compactGameStateHistory(state);

    expect(state.buildingOffers.filter((offer) => offer.status !== "open")).toHaveLength(CLOSED_MARKET_HISTORY_LIMIT);
    expect(state.buildingOffers.filter((offer) => offer.status === "open")).toHaveLength(1);
    expect(state.marketBroadcasts.filter((broadcast) => broadcast.kind.startsWith("building-offer"))).toHaveLength(CLOSED_MARKET_HISTORY_LIMIT + 1);
  });

  it("bounds law history and prunes ephemeral events during accelerated advances", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 9_902 });
    const template = state.laws[0] ?? createInitialState({ worldSeed: 9_903 }).laws[0];
    state.lawHistory = Array.from({ length: LAW_HISTORY_LIMIT + 25 }, (_, index) => ({
      ...structuredClone(template),
      id: `history-${index}`,
      enactedAt: index,
    }));
    state.recentProductionEvents = Array.from({ length: 5_000 }, (_, index) => ({
      itemId: "wood",
      catId: state.cats[0].id,
      at: index,
    }));
    state.simTime = 120_000;
    advanceGame(state, 1);

    expect(state.lawHistory).toHaveLength(LAW_HISTORY_LIMIT);
    expect(state.lawHistory[0].id).toBe("history-25");
    expect(state.recentProductionEvents).toHaveLength(0);
  });
});
