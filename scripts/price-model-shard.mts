import { writeFile } from "node:fs/promises";
import {
  CATALOG_ANALYSIS,
  ITEMS,
  MARKET_CHALLENGE_RECIPE_IDS,
  RECIPES,
} from "../src/game/catalog";
import { effectiveRecipeInputs } from "../src/game/difficulty";
import { advanceGame, createInitialState, itemPrice, unlockRecipe } from "../src/game/engine";
import { buyingPowerCents } from "../src/game/market";
import type { GameState, ItemId } from "../src/game/types";

const SPEED = 5_000;
const RAMP_MS = 300_000;
const WINDOW_MS = 300_000;
const WINDOWS = 3;
const RAW_GROSS_CENTS = 100;
const TAX_RATE = 0.5;
const NET_ACTION_WAGE_CENTS = RAW_GROSS_CENTS * (1 - TAX_RATE);
const PLANNING_HORIZON_WORK_UNITS = 10;
const PROCUREMENT_FRICTION_CENTS = 25;
const LOAN_RATE = 0.02;

type PriceModel = {
  name: string;
  coordinationRiskShare: number;
  procurementShare: number;
  financedShare: number;
};

type StabilitySnapshot = {
  crafted: Record<ItemId, number>;
  stock: Record<ItemId, number>;
};

type FlowProbe = {
  seenContracts: Set<string>;
  contractCount: number;
  contractSpendCents: number;
  routeEdges: number[];
  positiveDebtDeltaCents: number;
  previousDebtByCat: Map<string, number>;
};

function argument(name: string, fallback: string): string {
  return process.argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

const model: PriceModel = {
  name: argument("--name", "candidate"),
  coordinationRiskShare: Number(argument("--risk", "0.3")),
  procurementShare: Number(argument("--procurement", "0")),
  financedShare: Number(argument("--finance", "0")),
};
const seedStart = Number(argument("--seed-start", "1"));
const seedCount = Number(argument("--seed-count", "1"));
const outputPath = argument("--output", `output/price-model-${model.name}.json`);
const useCurrentCatalog = process.argv.includes("--current");
const useEmbodiedWorkValue = process.argv.includes("--work-value");
const fundBlueprintsForPriceIsolation = process.argv.includes("--fund-blueprints");
const anchorCurrentThrough = Number(argument("--anchor-current-through", "0"));
const explicitPriceOverrides = Object.fromEntries(argument("--override", "").split(",")
  .filter(Boolean)
  .map((entry) => {
    const [itemId, coins] = entry.split(":");
    return [itemId, Math.ceil(Number(coins) * 100)];
  })) as Record<ItemId, number>;

function modeledPrices(input: PriceModel): Record<ItemId, number> {
  const result: Record<ItemId, number> = {};
  for (let recipeIndex = 0; recipeIndex < RECIPES.length; recipeIndex += 1) {
    const recipe = RECIPES[recipeIndex];
    if (recipeIndex < anchorCurrentThrough) {
      result[recipe.output] = (CATALOG_ANALYSIS.basePrices[recipe.output] ?? 1) * 100;
      continue;
    }
    if (recipe.inputs.length === 0) {
      result[recipe.output] = RAW_GROSS_CENTS;
      continue;
    }
    const grossIngredientValueCents = recipe.inputs.reduce((sum, ingredient) => (
      sum + ingredient.quantity * result[ingredient.itemId]
    ), 0);
    const workUnits = CATALOG_ANALYSIS.workUnits[recipe.output] ?? 1;
    const inputUnits = recipe.inputs.reduce((sum, ingredient) => sum + ingredient.quantity, 0);
    const coordinationRiskNetCents = input.coordinationRiskShare
      * NET_ACTION_WAGE_CENTS
      * Math.max(0, workUnits - PLANNING_HORIZON_WORK_UNITS);
    const expectedMissingUnits = input.procurementShare * inputUnits;
    // A missing input adds the engine's 25-cent friction and one extra burden
    // unit. At the raw-resource return target, that burden unit costs 50 cents.
    const procurementNetCents = expectedMissingUnits
      * (PROCUREMENT_FRICTION_CENTS + NET_ACTION_WAGE_CENTS);
    const fullMissingWorkingCapitalCents = recipe.inputs.reduce((sum, ingredient) => (
      sum + ingredient.quantity * ((1 - TAX_RATE) * result[ingredient.itemId] + RAW_GROSS_CENTS)
    ), 0);
    const financingNetCents = input.financedShare * input.procurementShare
      * fullMissingWorkingCapitalCents * LOAN_RATE;
    const targetNetValueAddedCents = NET_ACTION_WAGE_CENTS * workUnits
      + coordinationRiskNetCents
      + procurementNetCents
      + financingNetCents;
    const rawGrossCents = grossIngredientValueCents + targetNetValueAddedCents / (1 - TAX_RATE);
    // The production catalog is intentionally denominated in whole coins.
    result[recipe.output] = Math.ceil(rawGrossCents / 100) * 100;
  }
  return result;
}

const originalPrices = Object.fromEntries(ITEMS.map((item) => [
  item.id,
  (CATALOG_ANALYSIS.basePrices[item.id] ?? 1) * 100,
])) as Record<ItemId, number>;
const candidatePrices = useCurrentCatalog
  ? originalPrices
  : useEmbodiedWorkValue
    ? Object.fromEntries(ITEMS.map((item) => [item.id, CATALOG_ANALYSIS.workUnits[item.id] * 100])) as Record<ItemId, number>
    : modeledPrices(model);
for (const [itemId, cents] of Object.entries(explicitPriceOverrides)) {
  if (ITEMS.some((item) => item.id === itemId) && Number.isFinite(cents) && cents > 0) candidatePrices[itemId] = cents;
}
for (const item of ITEMS) {
  CATALOG_ANALYSIS.basePrices[item.id] = candidatePrices[item.id] / 100;
  CATALOG_ANALYSIS.sellPrices[item.id] = candidatePrices[item.id] / 100;
}

function snapshot(state: GameState): StabilitySnapshot {
  const stock = Object.fromEntries(ITEMS.map((item) => [item.id, 0])) as Record<ItemId, number>;
  for (const cat of state.cats) {
    for (const [itemId, quantity] of Object.entries(cat.inventory)) stock[itemId] += Math.max(0, quantity);
    if (cat.action?.type === "craft") {
      for (const [itemId, quantity] of Object.entries(cat.action.reserved)) stock[itemId] += Math.max(0, quantity);
    }
  }
  for (const contract of state.shipmentContracts) {
    if (contract.status !== "delivered") stock[contract.itemId] += 1;
  }
  return {
    crafted: Object.fromEntries(ITEMS.map((item) => [item.id, state.itemStats[item.id].crafted])) as Record<ItemId, number>,
    stock,
  };
}

function createProbe(state: GameState): FlowProbe {
  return {
    seenContracts: new Set(),
    contractCount: 0,
    contractSpendCents: 0,
    routeEdges: [],
    positiveDebtDeltaCents: 0,
    previousDebtByCat: new Map(state.cats.map((cat) => [cat.id, cat.debtCents])),
  };
}

function updateProbe(state: GameState, probe: FlowProbe): void {
  for (const contract of state.shipmentContracts) {
    if (probe.seenContracts.has(contract.id)) continue;
    probe.seenContracts.add(contract.id);
    probe.contractCount += 1;
    probe.contractSpendCents += contract.sellerPriceCents
      + Object.values(contract.feesByCatId).reduce((sum, value) => sum + value, 0);
    probe.routeEdges.push(Math.max(0, contract.routeCatIds.length - 1));
  }
  for (const cat of state.cats) {
    const previous = probe.previousDebtByCat.get(cat.id) ?? 0;
    if (cat.debtCents > previous) probe.positiveDebtDeltaCents += cat.debtCents - previous;
    probe.previousDebtByCat.set(cat.id, cat.debtCents);
  }
}

function advanceLogical(state: GameState, logicalMs: number, probe?: FlowProbe): void {
  const quantum = 5_000;
  for (let elapsed = 0; elapsed < logicalMs; elapsed += quantum) {
    advanceGame(state, Math.min(quantum, logicalMs - elapsed) / state.simulationSpeed);
    if (probe) updateProbe(state, probe);
  }
}

function directInputsConsumed(state: GameState, before: StabilitySnapshot, after: StabilitySnapshot, through: number): number {
  return RECIPES.slice(0, through).reduce((total, recipe) => {
    const crafted = after.crafted[recipe.output] - before.crafted[recipe.output];
    const inputUnits = effectiveRecipeInputs(recipe, state.difficulty).reduce((sum, input) => sum + input.quantity, 0);
    return total + Math.max(0, crafted) * inputUnits;
  }, 0);
}

function evaluateStability(state: GameState, through: number, samples: StabilitySnapshot[]) {
  const perItem = RECIPES.slice(0, through).map((recipe) => {
    const windows = samples.slice(1).map((entry, index) => entry.crafted[recipe.output] - samples[index].crafted[recipe.output]);
    const total = windows.reduce((sum, value) => sum + value, 0);
    return {
      itemId: recipe.output,
      windows,
      total,
      activeWindows: windows.filter((value) => value > 0).length,
      stable: total >= 3 && windows.filter((value) => value > 0).length >= 2,
    };
  });
  const totals = samples.slice(1).map((entry, index) => RECIPES.slice(0, through).reduce((sum, recipe) => (
    sum + entry.crafted[recipe.output] - samples[index].crafted[recipe.output]
  ), 0));
  const collapsedTwice = totals[1] < totals[0] * 0.5 && totals[2] < totals[1] * 0.5;
  const creditBlockedOrders = state.demandOrders.filter((order) => {
    if (order.status !== "open" || order.buyerKind !== "cat" || !order.buyerCatId) return false;
    const buyer = state.cats.find((cat) => cat.id === order.buyerCatId);
    return Boolean(buyer && buyingPowerCents(state, buyer, (itemId) => itemPrice(state, itemId, buyer)) < order.reservedCents);
  }).length;
  const stalledContracts = state.shipmentContracts.filter((contract) => contract.status !== "delivered"
    && state.simTime - contract.acceptedAt > WINDOW_MS / state.simulationSpeed).length;
  let stableThrough = 0;
  for (const item of perItem) {
    if (!item.stable) break;
    stableThrough += 1;
  }
  return {
    passed: perItem.every((item) => item.stable) && !collapsedTwice && totals[2] > 0
      && creditBlockedOrders === 0 && stalledContracts === 0,
    stableThrough,
    perItem,
    totals,
    collapsedTwice,
    creditBlockedOrders,
    stalledContracts,
  };
}

function stage(state: GameState, through: number, probe: FlowProbe) {
  advanceLogical(state, RAMP_MS, probe);
  const samples = [snapshot(state)];
  for (let index = 0; index < WINDOWS; index += 1) {
    advanceLogical(state, WINDOW_MS, probe);
    samples.push(snapshot(state));
  }
  return {
    stability: evaluateStability(state, through, samples),
    directInputsConsumed: directInputsConsumed(state, samples[0], samples.at(-1)!, through),
    samples,
  };
}

function quantile(values: number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(probability * sorted.length) - 1))];
}

const seeds = Array.from({ length: seedCount }, (_, index) => seedStart + index);
const runs = [];
for (const seed of seeds) {
  const state = createInitialState({ worldSeed: seed, difficulty: 5, simulationSpeed: SPEED });
  const probe = createProbe(state);
  const stage10 = stage(state, 10, probe);
  const blueprintRequiredCents = MARKET_CHALLENGE_RECIPE_IDS.reduce((sum, recipeId) => {
    const recipe = RECIPES.find((entry) => entry.id === recipeId)!;
    return sum + Math.max(100, candidatePrices[recipe.output] * 2);
  }, 0);
  const modelingBlueprintFundingCents = fundBlueprintsForPriceIsolation
    ? Math.max(0, blueprintRequiredCents - state.treasuryCoins)
    : 0;
  // This is an explicitly reported modeling control, not a progression claim:
  // it isolates product-price behavior from the separately designed blueprint
  // budget. Production inventories, recipes, laws and cat balances are untouched.
  state.treasuryCoins += modelingBlueprintFundingCents;
  const treasuryBeforeBlueprints = state.treasuryCoins;
  const blueprintResults = MARKET_CHALLENGE_RECIPE_IDS.map((recipeId) => unlockRecipe(state, recipeId));
  const blueprintSpendCents = treasuryBeforeBlueprints - state.treasuryCoins;
  const stage15ProbeStart = {
    contractCount: probe.contractCount,
    contractSpendCents: probe.contractSpendCents,
    positiveDebtDeltaCents: probe.positiveDebtDeltaCents,
    routeCount: probe.routeEdges.length,
  };
  const stage15 = stage(state, 15, probe);
  const stage15Contracts = probe.contractCount - stage15ProbeStart.contractCount;
  const stage15ContractSpendCents = probe.contractSpendCents - stage15ProbeStart.contractSpendCents;
  const stage15PositiveDebtDeltaCents = probe.positiveDebtDeltaCents - stage15ProbeStart.positiveDebtDeltaCents;
  const stage15RouteEdges = probe.routeEdges.slice(stage15ProbeStart.routeCount);
  runs.push({
    seed,
    stage10: stage10.stability,
    blueprintResults: blueprintResults.map((entry) => entry.ok),
    blueprintSpendCents,
    modelingBlueprintFundingCents,
    stage15: stage15.stability,
    stage15Flow: {
      contractCount: stage15Contracts,
      directInputsConsumed: stage15.directInputsConsumed,
      // More than one contract per consumed unit means the market is building
      // buffer stock or churning plans, not that a physical input can be more
      // than 100% remotely procured. Keep the raw counts beside the capped
      // probability used by the price model.
      procurementShare: stage15.directInputsConsumed > 0
        ? Math.min(1, stage15Contracts / stage15.directInputsConsumed)
        : 0,
      contractSpendCents: stage15ContractSpendCents,
      positiveDebtDeltaCents: stage15PositiveDebtDeltaCents,
      financedShare: stage15ContractSpendCents > 0
        ? Math.min(1, stage15PositiveDebtDeltaCents / 1.02 / stage15ContractSpendCents)
        : 0,
      meanRouteEdges: stage15RouteEdges.length > 0
        ? stage15RouteEdges.reduce((sum, value) => sum + value, 0) / stage15RouteEdges.length
        : 0,
      p95RouteEdges: quantile(stage15RouteEdges, 0.95),
    },
    endingDebtCents: state.cats.reduce((sum, cat) => sum + cat.debtCents, 0),
    endingCashCents: state.cats.reduce((sum, cat) => sum + cat.coins, 0),
  });
}

const localGainRates = RECIPES.map((recipe) => {
  const workUnits = CATALOG_ANALYSIS.workUnits[recipe.output] ?? 1;
  const grossInputCents = recipe.inputs.reduce((sum, input) => sum + input.quantity * candidatePrices[input.itemId], 0);
  const netValueAddedCents = (candidatePrices[recipe.output] - grossInputCents) * (1 - TAX_RATE);
  const coordinationRiskCents = model.coordinationRiskShare * NET_ACTION_WAGE_CENTS
    * Math.max(0, workUnits - PLANNING_HORIZON_WORK_UNITS);
  return {
    itemId: recipe.output,
    workUnits,
    priceCents: candidatePrices[recipe.output],
    netValueAddedCents,
    assetGainRate: (netValueAddedCents - coordinationRiskCents) / workUnits,
    pricePerWorkUnit: candidatePrices[recipe.output] / workUnits,
  };
});

const result = {
  generatedAt: new Date().toISOString(),
  constants: {
    rawGrossCents: RAW_GROSS_CENTS,
    taxRate: TAX_RATE,
    netActionWageCents: NET_ACTION_WAGE_CENTS,
    planningHorizonWorkUnits: PLANNING_HORIZON_WORK_UNITS,
    procurementFrictionCents: PROCUREMENT_FRICTION_CENTS,
    loanRate: LOAN_RATE,
  },
  model: useCurrentCatalog ? { name: "current-catalog" }
    : useEmbodiedWorkValue ? { name: "embodied-work-value" }
      : model,
  explicitPriceOverrides,
  fundBlueprintsForPriceIsolation,
  anchorCurrentThrough,
  seedRange: { start: seedStart, count: seedCount },
  pricesCents: candidatePrices,
  blueprintTotalCents: MARKET_CHALLENGE_RECIPE_IDS.reduce((sum, recipeId) => {
    const recipe = RECIPES.find((entry) => entry.id === recipeId)!;
    return sum + Math.max(100, candidatePrices[recipe.output] * 2);
  }, 0),
  localGainRates,
  runs,
  summary: {
    stage10Passes: runs.filter((run) => run.stage10.passed).length,
    blueprintPurchasePasses: runs.filter((run) => run.blueprintResults.every(Boolean)).length,
    stage15Passes: runs.filter((run) => run.stage15.passed).length,
    meanProcurementShare: runs.reduce((sum, run) => sum + run.stage15Flow.procurementShare, 0) / runs.length,
    p95ProcurementShare: quantile(runs.map((run) => run.stage15Flow.procurementShare), 0.95),
    meanFinancedShare: runs.reduce((sum, run) => sum + run.stage15Flow.financedShare, 0) / runs.length,
    p95FinancedShare: quantile(runs.map((run) => run.stage15Flow.financedShare), 0.95),
    meanRouteEdges: runs.reduce((sum, run) => sum + run.stage15Flow.meanRouteEdges, 0) / runs.length,
    p95RouteEdges: quantile(runs.flatMap((run) => run.stage15Flow.p95RouteEdges === null ? [] : [run.stage15Flow.p95RouteEdges]), 0.95),
    endingDebtCents: runs.reduce((sum, run) => sum + run.endingDebtCents, 0),
  },
};

await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, model: result.model, ...result.summary }));
