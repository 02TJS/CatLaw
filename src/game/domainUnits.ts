/** Integer-cent currency amount. Alias-only by design so schema 1-17 values remain plain numbers. */
export type Cents = number;

declare const internalSimulationRateBrand: unique symbol;

/**
 * Deterministic engine-only duration divisor used by accelerated tests.
 * It is stored under the legacy `simulationSpeed` key and always resets to 1
 * when a save is loaded; it is not the player's 1x/2x/4x/8x playback control.
 */
export type InternalSimulationRate = number & {
  readonly [internalSimulationRateBrand]: "InternalSimulationRate";
};

export const DEFAULT_INTERNAL_SIMULATION_RATE = 1 as InternalSimulationRate;

export function normalizeInternalSimulationRate(value: unknown): InternalSimulationRate {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_INTERNAL_SIMULATION_RATE;
  return Math.max(1, Math.floor(value)) as InternalSimulationRate;
}

/** Runtime-only player playback choices; these never enter GameState or a save. */
export const RUNTIME_SPEED_MULTIPLIERS = [1, 2, 4, 8] as const;
export type RuntimeSpeedMultiplier = typeof RUNTIME_SPEED_MULTIPLIERS[number];

/** Preserve the controller's historical nearest-preset and earlier-value tie break. */
export function normalizeRuntimeSpeedMultiplier(value: number): RuntimeSpeedMultiplier {
  return RUNTIME_SPEED_MULTIPLIERS.reduce<RuntimeSpeedMultiplier>((best, candidate) => (
    Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best
  ), 1);
}
