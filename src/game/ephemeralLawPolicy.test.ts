import { describe, expect, it } from "vitest";
import { createInitialState, decideIdleCats, enactLaw, itemPrice, repealLaw } from "./engine";
import { ephemeralLawPolicy, ephemeralLawPolicyCount } from "./ephemeralLawPolicy";
import { hashSource } from "./lawInterpreter";
import { creditLimitCents, effectiveBountyAmountCents, externalNetCentsAt } from "./market";
import { migrateSaveSnapshot, serializeGameState } from "./persistence";
import type { LawDraft } from "./types";

function draft(sourceCode: string): LawDraft {
  return {
    title: "temporary test law",
    playerText: "test",
    summary: "test",
    explanation: "This law is a temporary runtime overlay and is removed when the law is repealed.",
    sourceCode,
    astHash: hashSource(sourceCode),
    examples: [],
    warnings: [],
    program: { version: 2 },
    validation: { syntax: true, safety: true, examplesPassed: 0, examplesTotal: 0, messages: [] },
  };
}

function evaluate(state: ReturnType<typeof createInitialState>): void {
  state.cats.forEach((cat) => { cat.action = null; });
  decideIdleCats(state);
}

describe("temporary law effects", () => {
  it("applies a flat coin addition temporarily and removes it on repeal", () => {
    const state = createInitialState({ withStarter: false });
    const cat = state.cats[0];
    const basePrice = itemPrice(state, "fuel", cat);
    const result = enactLaw(state, draft("function decide(ctx) { addPrice('fuel', 300); return null; }"));
    expect(result.ok).toBe(true);
    evaluate(state);
    expect(itemPrice(state, "fuel", cat)).toBe(basePrice + 300);
    expect(ephemeralLawPolicy(state, cat).priceAdditionsCents.fuel).toBe(300);
    expect(repealLaw(state, result.law!.id).ok).toBe(true);
    expect(itemPrice(state, "fuel", cat)).toBe(basePrice);
  });

  it("keeps price and credit overlays outside GameState and removes them on repeal", () => {
    const state = createInitialState({ withStarter: false });
    const cat = state.cats[0];
    const basePrice = itemPrice(state, "gear", cat);
    const baseNet = externalNetCentsAt(state, "gear", (itemId) => itemPrice(state, itemId, cat), cat);
    const baseCredit = creditLimitCents(state, cat, (itemId) => itemPrice(state, itemId, cat));
    const result = enactLaw(state, draft("function decide(ctx) { setPrice('gear', 2); setCredit(9000, 0); return null; }"));
    expect(result.ok).toBe(true);

    evaluate(state);
    expect(itemPrice(state, "gear", cat)).toBe(basePrice * 2);
    expect(externalNetCentsAt(state, "gear", (itemId) => itemPrice(state, itemId, cat), cat)).toBe(
      itemPrice(state, "gear", cat),
    );
    expect(creditLimitCents(state, cat, (itemId) => itemPrice(state, itemId, cat))).toBe(9_000);
    expect(ephemeralLawPolicyCount(state)).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(cat, "lawPolicy")).toBe(false);

    const lawId = result.law!.id;
    expect(repealLaw(state, lawId).ok).toBe(true);
    expect(ephemeralLawPolicyCount(state)).toBe(0);
    expect(itemPrice(state, "gear", cat)).toBe(basePrice);
    expect(externalNetCentsAt(state, "gear", (itemId) => itemPrice(state, itemId, cat), cat)).toBe(baseNet);
    expect(creditLimitCents(state, cat, (itemId) => itemPrice(state, itemId, cat))).toBe(baseCredit);
  });

  it("treats bounty changes as a temporary multiplier without mutating the bounty ledger", () => {
    const state = createInitialState({ withStarter: false });
    const cat = state.cats[0];
    const bounty = state.discoveryBounties.find((entry) => entry.itemId === "wood")!;
    const baseline = bounty.amountCents;
    const result = enactLaw(state, draft("function decide(ctx) { setBounty(4); return null; }"));
    expect(result.ok).toBe(true);
    evaluate(state);
    expect(effectiveBountyAmountCents(state, "wood", cat)).toBe(baseline * 4 / 3);
    expect(bounty.amountCents).toBe(baseline);
    expect(repealLaw(state, result.law!.id).ok).toBe(true);
    expect(effectiveBountyAmountCents(state, "wood", cat)).toBe(baseline);
    expect(bounty.amountCents).toBe(baseline);
  });

  it("drops legacy per-cat law policies while loading old saves", () => {
    const raw = structuredClone(createInitialState({ withStarter: false })) as any;
    raw.cats[0].lawPolicy = {
      priceMultipliers: { gear: 10 },
      taxRate: 0.9,
      creditBaseCents: 999_999,
      creditNetWorthFactor: 1,
      bountyMultiplier: 10,
      bountyMultiplierSet: true,
    };
    const migrated = migrateSaveSnapshot(raw);
    expect(Object.prototype.hasOwnProperty.call(migrated.cats[0], "lawPolicy")).toBe(false);
    expect(ephemeralLawPolicy(migrated, migrated.cats[0]).priceMultipliers).toEqual({});
  });

  it("never serializes an evaluated overlay or a legacy policy field", () => {
    const state = createInitialState({ withStarter: false });
    const baseline = itemPrice(state, "gear", state.cats[0]);
    expect(enactLaw(state, draft("function decide(ctx) { setPrice('gear', 2); addPrice('gear', 300); return null; }")).ok).toBe(true);
    evaluate(state);
    expect(ephemeralLawPolicyCount(state)).toBe(1);
    expect(itemPrice(state, "gear", state.cats[0])).toBe(baseline * 2 + 300);
    expect(ephemeralLawPolicy(state, state.cats[0]).priceAdditionsCents.gear).toBe(300);
    const cat = state.cats[0] as typeof state.cats[0] & { lawPolicy?: unknown };
    cat.lawPolicy = { priceMultipliers: { gear: 10 } };
    const persisted = serializeGameState(state) as typeof state & {
      cats: Array<typeof state.cats[number] & { lawPolicy?: unknown }>;
    };
    expect(persisted.cats.every((entry) => !Object.prototype.hasOwnProperty.call(entry, "lawPolicy"))).toBe(true);
    expect(itemPrice(persisted, "gear", persisted.cats[0])).toBe(baseline);
    expect(Object.prototype.hasOwnProperty.call(state.cats[0], "lawPolicy")).toBe(true);
  });
});
