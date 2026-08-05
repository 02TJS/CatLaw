import type { CatState, GameState, LawRuntimePolicy } from "./types.js";
import { freshLawPolicy } from "./lawProgram.js";

/**
 * Law effects are runtime overlays, never GameState data. A WeakMap keeps the
 * current decision results available to pricing/market calculations while
 * making them impossible to serialize into IndexedDB or clone into a save.
 */
const policiesByState = new WeakMap<GameState, Map<string, LawRuntimePolicy>>();

function clonePolicy(policy: LawRuntimePolicy): LawRuntimePolicy {
  return {
    priceMultipliers: { ...policy.priceMultipliers },
    priceAdditionsCents: { ...(policy.priceAdditionsCents ?? {}) },
    creditBaseCents: policy.creditBaseCents,
    creditNetWorthFactor: policy.creditNetWorthFactor,
    bountyMultiplier: policy.bountyMultiplier,
    bountyMultiplierSet: policy.bountyMultiplierSet === true,
  };
}

export function setEphemeralLawPolicy(state: GameState, catId: string, policy: LawRuntimePolicy): void {
  const policies = policiesByState.get(state) ?? new Map<string, LawRuntimePolicy>();
  policies.set(catId, clonePolicy(policy));
  policiesByState.set(state, policies);
}

export function replaceEphemeralLawPolicies(
  state: GameState,
  policies: ReadonlyMap<string, LawRuntimePolicy>,
): void {
  const next = new Map<string, LawRuntimePolicy>();
  for (const [catId, policy] of policies) next.set(catId, clonePolicy(policy));
  policiesByState.set(state, next);
}

export function invalidateEphemeralLawPolicies(state: GameState): void {
  policiesByState.delete(state);
}

/** Drop only one cat's previous decision overlay before its next snapshot. */
export function clearEphemeralLawPolicy(state: GameState, catId: string): void {
  const policies = policiesByState.get(state);
  if (!policies) return;
  policies.delete(catId);
  if (policies.size === 0) policiesByState.delete(state);
}

export function ephemeralLawPolicy(state: GameState, cat: CatState | undefined): LawRuntimePolicy {
  if (!cat) return freshLawPolicy();
  const current = policiesByState.get(state)?.get(cat.id);
  return current ? clonePolicy(current) : freshLawPolicy();
}

export function ephemeralLawPolicyCount(state: GameState): number {
  return policiesByState.get(state)?.size ?? 0;
}
