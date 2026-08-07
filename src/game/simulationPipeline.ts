import { WEALTH_HISTORY_SAMPLE_INTERVAL_MS } from "./gameHistory";
import type { CatState, GameState } from "./types";

export interface SimulationPipelineOperations {
  catMap: (state: GameState) => Map<string, CatState>;
  resolveAction: (state: GameState, cat: CatState, map: Map<string, CatState>) => void;
  pruneEphemeralState: (state: GameState) => void;
  decideIdleCats: (state: GameState, eligibleCatIds: ReadonlySet<string>) => void;
  recordWealthHistorySample: (state: GameState, force: boolean) => void;
  compactGameStateHistory: (state: GameState) => void;
}

/**
 * Advance one deterministic simulation window. The phase order and tie-break
 * rules intentionally mirror the original engine loop exactly.
 */
export function advanceSimulationPipeline(
  state: GameState,
  milliseconds: number,
  operations: SimulationPipelineOperations,
): void {
  if (state.paused || !Number.isFinite(milliseconds) || milliseconds <= 0) return;
  const target = state.simTime + milliseconds;
  while (true) {
    const nextAction = state.cats.reduce((time, cat) => cat.action && cat.action.endsAt < time ? cat.action.endsAt : time, Number.POSITIVE_INFINITY);
    const nextWealthSample = (state.wealthHistory.at(-1)?.at ?? state.simTime) + WEALTH_HISTORY_SAMPLE_INTERVAL_MS;
    const next = Math.min(nextAction, nextWealthSample);
    if (next > target) break;
    state.simTime = next;
    const map = operations.catMap(state);
    const completing = state.cats.filter((cat) => cat.action?.endsAt === next).sort((a, b) => a.createdIndex - b.createdIndex);
    for (const cat of completing) operations.resolveAction(state, cat, map);
    operations.pruneEphemeralState(state);
    if (completing.length > 0) operations.decideIdleCats(state, new Set(completing.map((cat) => cat.id)));
    if (next === nextWealthSample) operations.recordWealthHistorySample(state, true);
    operations.compactGameStateHistory(state);
  }
  state.simTime = target;
  operations.pruneEphemeralState(state);
  operations.compactGameStateHistory(state);
}
