import { CATALOG_ANALYSIS } from "./catalog";
import { ephemeralLawPolicy } from "./ephemeralLawPolicy";
import type { CatState, GameState, ItemId } from "./types";

export function itemPrice(state: GameState, itemId: ItemId, cat: CatState | undefined = state.cats[0]): number {
  const base = CATALOG_ANALYSIS.basePrices[itemId] ?? 1;
  const policy = ephemeralLawPolicy(state, cat);
  const multiplier = policy.priceMultipliers[itemId]
    ?? policy.priceMultipliers["*"]
    ?? 1;
  const additionCents = policy.priceAdditionsCents[itemId]
    ?? policy.priceAdditionsCents["*"]
    ?? 0;
  return Math.max(1, Math.ceil(base * 100 * multiplier + additionCents));
}

export function formatMoney(cents: number): string {
  return `${(Math.max(0, cents) / 100).toFixed(2)} 🪙`;
}
