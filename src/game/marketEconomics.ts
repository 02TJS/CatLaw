import { landmarkEffectsAt } from "./landmarks";
import { ephemeralLawPolicy } from "./ephemeralLawPolicy";
import type { CatState, GameState, ItemId } from "./types";

export const BASE_CREDIT_CENTS = 2_500;
export const LOAN_RATE = 0.02;
export const MIN_PLAN_PROFIT_CENTS = 1;

export function externalNetCents(_state: GameState, itemId: ItemId, priceOf: (itemId: ItemId) => number): number {
  return Math.max(0, priceOf(itemId));
}

/** Net liquidation value at a cat's current site, including landmark sale bonus. */
export function externalNetCentsAt(state: GameState, itemId: ItemId, priceOf: (itemId: ItemId) => number, cat: CatState): number {
  const gross = Math.ceil(priceOf(itemId) * (1 + landmarkEffectsAt(state, cat.position).saleValueBonus));
  return Math.max(0, gross);
}

export function netWorthCents(state: GameState, cat: CatState, priceOf: (itemId: ItemId) => number): number {
  const inventoryValue = Object.entries(cat.inventory).reduce((sum, [itemId, quantity]) => (
    sum + Math.max(0, quantity) * externalNetCents(state, itemId, priceOf)
  ), 0);
  const inTransit = state.shipmentContracts.reduce((sum, contract) => (
    contract.status !== "delivered" && contract.buyerKind === "cat" && contract.buyerCatId === cat.id
      ? sum + Math.min(contract.escrowCents, externalNetCents(state, contract.itemId, priceOf))
      : sum
  ), 0);
  return cat.coins + inventoryValue + inTransit - cat.debtCents;
}

export function creditLimitCents(state: GameState, cat: CatState, priceOf: (itemId: ItemId) => number): number {
  const policy = ephemeralLawPolicy(state, cat);
  return policy.creditBaseCents
    + landmarkEffectsAt(state, cat.position).creditBonusCents
    + Math.round(Math.max(0, netWorthCents(state, cat, priceOf)) * policy.creditNetWorthFactor);
}

export function creditAvailableCents(state: GameState, cat: CatState, priceOf: (itemId: ItemId) => number): number {
  return Math.max(0, creditLimitCents(state, cat, priceOf) - cat.debtCents);
}

export function buyingPowerCents(state: GameState, cat: CatState, priceOf: (itemId: ItemId) => number): number {
  return Math.max(0, cat.coins + creditAvailableCents(state, cat, priceOf) - cat.escrowReservedCents);
}

export function applyPrivateIncome(cat: CatState, amountCents: number): void {
  let remaining = Math.max(0, Math.floor(amountCents));
  const repaid = Math.min(cat.debtCents, remaining);
  cat.debtCents -= repaid;
  remaining -= repaid;
  cat.coins += remaining;
}
