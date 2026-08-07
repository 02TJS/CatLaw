import { describe, expect, it, vi } from "vitest";
import * as engine from "./engine";
import * as history from "./gameHistory";
import * as market from "./market";
import * as demand from "./marketDemand";
import * as economics from "./marketEconomics";
import * as pricing from "./marketPricing";
import * as transactions from "./marketTransactions";
import { advanceSimulationPipeline } from "./simulationPipeline";
import type { GameState } from "./types";

describe("P4 engine and market domain boundaries", () => {
  it("keeps the original engine and market exports as direct compatibility facades", () => {
    expect(engine.itemPrice).toBe(pricing.itemPrice);
    expect(engine.formatMoney).toBe(pricing.formatMoney);
    expect(engine.buyAllCatStock).toBe(transactions.buyAllCatStock);
    expect(engine.sellWarehouseItem).toBe(transactions.sellWarehouseItem);
    expect(engine.compactGameStateHistory).toBe(history.compactGameStateHistory);
    expect(engine.recordWealthHistorySample).toBe(history.recordWealthHistorySample);
    expect(market.externalNetCents).toBe(economics.externalNetCents);
    expect(market.creditLimitCents).toBe(economics.creditLimitCents);
    expect(market.productionOrderBudgetCents).toBe(demand.productionOrderBudgetCents);
  });

  it("keeps private income settlement debt-first with the original flooring rule", () => {
    const cat = { debtCents: 125, coins: 40 } as GameState["cats"][number];
    economics.applyPrivateIncome(cat, 200.9);
    expect({ debtCents: cat.debtCents, coins: cat.coins }).toEqual({ debtCents: 0, coins: 115 });
  });

  it("runs tied action and wealth phases in the original deterministic order", () => {
    const state = {
      paused: false,
      simTime: 0,
      cats: [
        { id: "late", createdIndex: 2, action: { endsAt: 5_000 } },
        { id: "early", createdIndex: 1, action: { endsAt: 5_000 } },
      ],
      wealthHistory: [{ at: 0, values: {} }],
    } as unknown as GameState;
    const phases: string[] = [];

    advanceSimulationPipeline(state, 5_000, {
      catMap: (current) => {
        phases.push(`map:${current.simTime}`);
        return new Map(current.cats.map((cat) => [cat.id, cat]));
      },
      resolveAction: (_current, cat) => {
        phases.push(`resolve:${cat.id}`);
        cat.action = null;
      },
      pruneEphemeralState: (current) => phases.push(`prune:${current.simTime}`),
      decideIdleCats: (_current, eligible) => phases.push(`decide:${[...eligible].join(",")}`),
      recordWealthHistorySample: (current, force) => {
        phases.push(`wealth:${force}`);
        current.wealthHistory.push({ at: current.simTime, values: {} });
      },
      compactGameStateHistory: (current) => phases.push(`compact:${current.simTime}`),
    });

    expect(phases).toEqual([
      "map:5000",
      "resolve:early",
      "resolve:late",
      "prune:5000",
      "decide:early,late",
      "wealth:true",
      "compact:5000",
      "prune:5000",
      "compact:5000",
    ]);
    expect(state.simTime).toBe(5_000);
  });

  it("does not enter any pipeline phase for paused or invalid advances", () => {
    const state = { paused: true, simTime: 10, cats: [], wealthHistory: [] } as unknown as GameState;
    const operation = vi.fn();
    advanceSimulationPipeline(state, 5_000, {
      catMap: () => new Map(),
      resolveAction: operation,
      pruneEphemeralState: operation,
      decideIdleCats: operation,
      recordWealthHistorySample: operation,
      compactGameStateHistory: operation,
    });
    expect(operation).not.toHaveBeenCalled();
    expect(state.simTime).toBe(10);
  });

  it("produces byte-for-byte equal state for the same seed and elapsed time", () => {
    const left = engine.createInitialState({ worldSeed: 0x13579bdf, difficulty: 3 });
    const right = engine.createInitialState({ worldSeed: 0x13579bdf, difficulty: 3 });
    engine.advanceGame(left, 20_000);
    engine.advanceGame(right, 20_000);
    expect(left).toEqual(right);
  });
});
