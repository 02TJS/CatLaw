import { describe, expect, it } from "vitest";
import { advanceGame, createInitialState, setPaused, setSpeechFrequency } from "./engine";
import { hashSource } from "./lawInterpreter";
import {
  DEFAULT_LAW_SPEECH_TEMPLATES,
  DEFAULT_SPEECH_FREQUENCY,
  fillSpeechTemplate,
  formatSpeechAction,
  formatSpeechGain,
  MAX_ACTIVE_SPEECH_BUBBLES,
  normalizeSpeechFrequency,
  SPEECH_DURATION_MS,
  SPEECH_MAX_DELAY_MS,
  SPEECH_MIN_DELAY_MS,
  speechCapacityForFrequency,
  speechEventIsVisible,
  speechRoll,
  validateSpeechTemplates,
} from "./speech";

describe("regulation-driven cat speech", () => {
  it("accepts only five concise meow templates with decision context", () => {
    expect(validateSpeechTemplates(DEFAULT_LAW_SPEECH_TEMPLATES)).toEqual({ ok: true, messages: [] });
    expect(validateSpeechTemplates(DEFAULT_LAW_SPEECH_TEMPLATES.slice(0, 4)).ok).toBe(false);
    expect(validateSpeechTemplates(DEFAULT_LAW_SPEECH_TEMPLATES.map((line, index) => index ? line : "{reason}，我要{action}！")).ok).toBe(false);
    expect(validateSpeechTemplates(DEFAULT_LAW_SPEECH_TEMPLATES.map((line, index) => index ? line : "{unknown}，我要{action}喵！")).ok).toBe(false);
    expect(validateSpeechTemplates(DEFAULT_LAW_SPEECH_TEMPLATES.map((line, index) => index ? line : "只有{reason}但没有动作喵。")).ok).toBe(false);
    expect(validateSpeechTemplates(DEFAULT_LAW_SPEECH_TEMPLATES.map((line, index) => index ? line : "{reason}，所以{action}喵。")).ok).toBe(false);
  });

  it("rejects five copies or punctuation-only variants", () => {
    const copies = DEFAULT_LAW_SPEECH_TEMPLATES.map(() => DEFAULT_LAW_SPEECH_TEMPLATES[0]);
    const punctuationOnly = DEFAULT_LAW_SPEECH_TEMPLATES.map((_line, index) =>
      `按{law}，因{reason}，{action}能赚{gain}${index % 2 ? "喵。" : "喵！"}`);
    expect(validateSpeechTemplates(copies)).toMatchObject({ ok: false });
    expect(validateSpeechTemplates(punctuationOnly)).toMatchObject({ ok: false });
    expect(validateSpeechTemplates(copies).messages.join(" ")).toContain("不能重复");
    expect(validateSpeechTemplates(punctuationOnly).messages.join(" ")).toContain("至少要有四种不同句式");
  });

  it("fills only the whitelisted runtime placeholders", () => {
    expect(fillSpeechTemplate("根据{law}，{reason}，{action}能赚{gain}喵！", {
      law: "《木材法》",
      reason: "预计有利可图",
      action: "制作 🪵 木材",
      gain: "2.50金币",
    })).toBe("根据《木材法》，预计有利可图，制作 🪵 木材能赚2.50金币喵！");
    expect(formatSpeechAction("pass", "🪵木材", "东边的8号猫")).toBe("把🪵木材运到东边的8号猫");
    expect(formatSpeechGain(251)).toBe("2.51金币");
  });

  it("uses a deterministic default 70 percent speech roll", () => {
    const first = Array.from({ length: 10_000 }, (_, index) => speechRoll(`seed|cat|${index}`));
    const second = Array.from({ length: 10_000 }, (_, index) => speechRoll(`seed|cat|${index}`));
    expect(second).toEqual(first);
    const spoken = first.filter((entry) => entry.speaks).length;
    expect(DEFAULT_SPEECH_FREQUENCY).toBe(70);
    expect(spoken).toBeGreaterThanOrEqual(6_800);
    expect(spoken).toBeLessThanOrEqual(7_200);
    expect(first.every((entry) => entry.templateIndex >= 0 && entry.templateIndex < 5)).toBe(true);
    expect(first.every((entry) => entry.delayMs >= SPEECH_MIN_DELAY_MS && entry.delayMs <= SPEECH_MAX_DELAY_MS)).toBe(true);
    expect(new Set(first.map((entry) => entry.delayMs)).size).toBeGreaterThan(3_500);
  });

  it("clamps the player setting and makes zero silent while 100 always speaks", () => {
    expect(normalizeSpeechFrequency(-20)).toBe(0);
    expect(normalizeSpeechFrequency(71.6)).toBe(72);
    expect(normalizeSpeechFrequency(120)).toBe(100);
    expect(normalizeSpeechFrequency(Number.NaN)).toBe(DEFAULT_SPEECH_FREQUENCY);
    const keys = Array.from({ length: 1_000 }, (_, index) => `frequency|${index}`);
    expect(keys.every((key) => !speechRoll(key, 0).speaks)).toBe(true);
    expect(keys.every((key) => speechRoll(key, 100).speaks)).toBe(true);
    expect(speechCapacityForFrequency(0)).toBe(0);
    expect(speechCapacityForFrequency(1)).toBe(1);
    expect(speechCapacityForFrequency(40)).toBe(2);
    expect(speechCapacityForFrequency(DEFAULT_SPEECH_FREQUENCY)).toBe(4);
    expect(speechCapacityForFrequency(100)).toBe(MAX_ACTIVE_SPEECH_BUBBLES);
    expect(SPEECH_DURATION_MS).toBe(4_500);

    const state = createInitialState({ worldSeed: 7 });
    expect(state.speechFrequency).toBe(DEFAULT_SPEECH_FREQUENCY);
    expect(setSpeechFrequency(state, 0)).toBe(0);
    advanceGame(state, 5_000);
    expect(state.floatingEvents.some((event) => event.kind === "speech")).toBe(false);
    expect(setSpeechFrequency(state, 100)).toBe(100);
    advanceGame(state, 5_000);
    const newlyActingCats = state.cats.filter((cat) => cat.action?.type !== "wait" && cat.action?.startedAt === state.simTime);
    const speechEvents = state.floatingEvents.filter((event) => event.kind === "speech");
    expect(speechEvents).toHaveLength(Math.min(MAX_ACTIVE_SPEECH_BUBBLES, newlyActingCats.length));
    expect(speechEvents.every((event) => newlyActingCats.some((cat) => cat.id === event.catId))).toBe(true);
    expect(setSpeechFrequency(state, 40)).toBe(40);
    expect(state.floatingEvents.filter((event) => event.kind === "speech")).toHaveLength(2);
    setSpeechFrequency(state, 0);
    expect(state.floatingEvents.some((event) => event.kind === "speech")).toBe(false);
  });

  it("emits contextual bubbles deterministically without exceeding the global cap", () => {
    const state = createInitialState({ worldSeed: 7 });
    advanceGame(state, 5_000);
    const bubbles = state.floatingEvents.filter((event) => event.kind === "speech");
    expect(bubbles).toHaveLength(speechCapacityForFrequency(DEFAULT_SPEECH_FREQUENCY));
    expect(bubbles.every((event) => event.text.includes("喵") && event.lawId && event.reason && event.itemId)).toBe(true);
    expect(bubbles.every((event) => event.gainCents !== undefined
      && event.text.includes(formatSpeechGain(event.gainCents))
      && event.scheduledDelayMs !== undefined
      && event.scheduledDelayMs >= SPEECH_MIN_DELAY_MS
      && event.scheduledDelayMs <= SPEECH_MAX_DELAY_MS)).toBe(true);
    expect(bubbles.every((event) => event.createdAt > state.simTime && !speechEventIsVisible(event, state.simTime))).toBe(true);
    expect(new Set(bubbles.map((event) => event.createdAt)).size).toBeGreaterThan(1);
    expect(bubbles.every((event) => {
      const cat = state.cats.find((entry) => entry.id === event.catId);
      return cat?.action?.itemId === event.itemId && cat?.action?.lawId === event.lawId;
    })).toBe(true);

    const replay = createInitialState({ worldSeed: 7 });
    advanceGame(replay, 5_000);
    expect(replay.floatingEvents.filter((event) => event.kind === "speech")).toEqual(bubbles);
  });

  it("attributes a direct craft to the proposing regulation", () => {
    const state = createInitialState({ worldSeed: 1 });
    const sourceCode = "function decide(ctx) { if (canCraft('wood')) return { type: 'craft', recipeId: 'make_wood' }; return null; }";
    state.laws = [{
      id: "direct-wood",
      title: "木材直达法",
      playerText: "能采木材就直接采集。",
      summary: "直接采集木材。",
      sourceCode,
      astHash: hashSource(sourceCode),
      examples: [],
      warnings: [],
      speechTemplates: [...DEFAULT_LAW_SPEECH_TEMPLATES],
      enactedAt: 0,
      program: { version: 2 },
      hitCount: 0,
      invalidCount: 0,
      consecutiveFaults: 0,
      status: "active",
    }];
    advanceGame(state, 5_000);
    const actionCat = state.cats.find((cat) => cat.action?.lawId === "direct-wood");
    expect(actionCat?.action).toMatchObject({ type: "craft", itemId: "wood", lawId: "direct-wood" });
    expect(actionCat?.action?.decisionReason).toContain("木材直达法");
    const bubble = state.floatingEvents.find((event) => event.kind === "speech" && event.catId === actionCat?.id);
    expect(bubble).toMatchObject({ lawId: "direct-wood", itemId: "wood" });
    expect(bubble?.text).toContain("喵");
  });

  it("names the real fee and next cat for a paid shipment", () => {
    let state = createInitialState({ worldSeed: 1 });
    let receiver = state.cats.find((cat) => Math.abs(cat.position.x - state.cats[0].position.x)
      + Math.abs(cat.position.y - state.cats[0].position.y) === 1)!;
    let direction = receiver.position.x > state.cats[0].position.x ? "east"
      : receiver.position.x < state.cats[0].position.x ? "west"
        : receiver.position.y > state.cats[0].position.y ? "south" : "north";
    for (let seed = 1; seed <= 1_000; seed += 1) {
      const candidate = createInitialState({ worldSeed: seed });
      const next = candidate.cats.find((cat) => Math.abs(cat.position.x - candidate.cats[0].position.x)
        + Math.abs(cat.position.y - candidate.cats[0].position.y) === 1)!;
      const nextDirection = next.position.x > candidate.cats[0].position.x ? "east"
        : next.position.x < candidate.cats[0].position.x ? "west"
          : next.position.y > candidate.cats[0].position.y ? "south" : "north";
      const key = [seed, 0, 1, "starter-law-local-greedy", "pass", "wood", nextDirection].join("|");
      if (!speechRoll(key).speaks) continue;
      state = candidate;
      receiver = next;
      direction = nextDirection;
      break;
    }
    const seller = state.cats[0];
    seller.inventory.wood = 1;
    state.demandOrders.push({
      id: "order-speech",
      buyerKind: "cat",
      buyerCatId: receiver.id,
      destinationCatId: receiver.id,
      itemId: "wood",
      maxDeliveredCents: 1_234,
      reservedCents: 1_234,
      planId: null,
      createdAt: 0,
      status: "contracted",
      closedAt: 0,
      closeReason: `由 ${seller.id} 成交`,
      committedSellerCatId: seller.id,
    });
    state.shipmentContracts.push({
      id: "contract-speech",
      orderId: "order-speech",
      itemId: "wood",
      sellerCatId: seller.id,
      buyerKind: "cat",
      buyerCatId: receiver.id,
      destinationCatId: receiver.id,
      routeCatIds: [seller.id, receiver.id],
      currentLeg: 0,
      custodianCatId: seller.id,
      sellerPriceCents: 1_234,
      feesByCatId: { [seller.id]: 1_234 },
      escrowCents: 1_234,
      acceptedAt: 0,
      deliveredAt: null,
      status: "awaiting-pickup",
    });

    advanceGame(state, 5_000);
    expect(seller.action).toMatchObject({ type: "pass", itemId: "wood", direction, contractId: "contract-speech" });
    const bubble = state.floatingEvents.find((event) => event.kind === "speech" && event.catId === seller.id);
    const directionLabel = { north: "北", east: "东", south: "南", west: "西" }[direction];
    expect(bubble).toMatchObject({ gainCents: 1_234, destinationCatId: receiver.id, direction });
    expect(bubble?.text).toContain("12.34金币");
    expect(bubble?.text).toContain(`运到${directionLabel}边的${receiver.createdIndex + 1}号猫`);
    expect(bubble?.text).toContain("履行有偿运输合同");
  });

  it("keeps accelerated decisions on a five-second per-cat cooldown and pauses cleanly", () => {
    const state = createInitialState({ worldSeed: 37, simulationSpeed: 8 });
    advanceGame(state, 5_000);
    const bubbles = state.floatingEvents.filter((event) => event.kind === "speech");
    expect(bubbles.length).toBeLessThanOrEqual(MAX_ACTIVE_SPEECH_BUBBLES);
    expect(new Set(bubbles.map((event) => event.catId)).size).toBe(bubbles.length);
    const serials = state.cats.map((cat) => cat.decisionSerial);
    setPaused(state, true);
    advanceGame(state, 20_000);
    expect(state.cats.map((cat) => cat.decisionSerial)).toEqual(serials);
  });
});
