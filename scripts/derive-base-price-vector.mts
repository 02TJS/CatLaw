import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CATALOG_ANALYSIS, ITEMS, MARKET_CHALLENGE_RECIPE_IDS, RECIPES, RECIPE_BY_ID } from "../src/game/catalog.js";
import { effectiveRecipeInputs } from "../src/game/difficulty.js";
import { createInitialState } from "../src/game/engine.js";
import { LOAN_RATE } from "../src/game/market.js";
import type { ItemId } from "../src/game/types.js";

const OUTPUT = process.argv.find((entry) => entry.startsWith("--output="))?.slice("--output=".length)
  ?? "output/derived-base-price-vector.json";

// These are existing game rules, not fitted coefficients.
const DIFFICULTY = 5 as const;
const TAX_RATE = 0.5;
const PROCUREMENT_FRICTION_CENTS = 25;
const MAX_CARRIER_FEE_CENTS = 25;
const ORDINARY_ORDER_PREMIUM_CENTS = 100;
const COORDINATION_RISK_CENTS_PER_WORK_OVER_TEN = 15;
const MINIMUM_POSITIVE_GAIN_CENTS = 1;
const CENTS_PER_COIN = 100;

function adjacent(left: { x: number; y: number }, right: { x: number; y: number }): boolean {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y) === 1;
}

function maximumStarterRouteEdges(): number {
  const cats = createInitialState({ worldSeed: 1, difficulty: DIFFICULTY }).cats;
  let maximum = 0;
  for (const origin of cats) {
    const distance = new Map<string, number>([[origin.id, 0]]);
    const queue = [origin];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentDistance = distance.get(current.id)!;
      for (const next of cats) {
        if (distance.has(next.id) || !adjacent(current.position, next.position)) continue;
        distance.set(next.id, currentDistance + 1);
        queue.push(next);
      }
    }
    if (distance.size !== cats.length) throw new Error("Starter cat graph is disconnected");
    maximum = Math.max(maximum, ...distance.values());
  }
  return maximum;
}

function externalNetCents(priceCoins: number): number {
  const gross = priceCoins * CENTS_PER_COIN;
  return gross - Math.min(gross, Math.ceil(gross * TAX_RATE));
}

function minimumCoinPriceForNet(requiredNetCents: number): number {
  for (let price = 1; price < 1_000_000_000; price += 1) {
    if (externalNetCents(price) >= requiredNetCents) return price;
  }
  throw new Error(`Price search overflow at ${requiredNetCents} cents`);
}

const maxRouteEdges = maximumStarterRouteEdges();
const maxCarrierCostCents = Math.max(0, maxRouteEdges - 1) * MAX_CARRIER_FEE_CENTS;
// An order pays the normal +100 cent premium. Preserve one cent of seller gain
// even on the longest starter route with every intermediate charging the cap.
const requiredExternalMarginCents = Math.max(
  MINIMUM_POSITIVE_GAIN_CENTS,
  maxCarrierCostCents - ORDINARY_ORDER_PREMIUM_CENTS + MINIMUM_POSITIVE_GAIN_CENTS,
);

const prices = {} as Record<ItemId, number>;
const rows = RECIPES.map((recipe, index) => {
  const inputs = effectiveRecipeInputs(recipe, DIFFICULTY);
  const inputUnits = inputs.reduce((sum, input) => sum + input.quantity, 0);
  if (inputs.length === 0) {
    prices[recipe.output] = 1;
    return {
      index: index + 1,
      itemId: recipe.output,
      inputs,
      technicalWorkUnits: CATALOG_ANALYSIS.workUnits[recipe.output],
      inputOpportunityCostCents: 0,
      procurementFrictionCents: 0,
      zeroCashWorkingCapitalCents: 0,
      zeroCashFinancingCostCents: 0,
      coordinationRiskCostCents: 0,
      requiredExternalMarginCents,
      basePriceCoins: 1,
      externalNetCents: externalNetCents(1),
      externalPlanGainCents: externalNetCents(1),
      worstRouteOrderGainCents: externalNetCents(1) + ORDINARY_ORDER_PREMIUM_CENTS - maxCarrierCostCents,
    };
  }

  const inputOpportunityCostCents = inputs.reduce((sum, input) => (
    sum + input.quantity * externalNetCents(prices[input.itemId])
  ), 0);
  const procurementFrictionCents = inputUnits * PROCUREMENT_FRICTION_CENTS;
  const zeroCashWorkingCapitalCents = inputs.reduce((sum, input) => (
    sum + input.quantity * (externalNetCents(prices[input.itemId]) + ORDINARY_ORDER_PREMIUM_CENTS)
  ), 0);
  const zeroCashFinancingCostCents = Math.max(1, Math.ceil(zeroCashWorkingCapitalCents * LOAN_RATE));
  const coordinationRiskCostCents = Math.max(
    0,
    (CATALOG_ANALYSIS.workUnits[recipe.output] - 10) * COORDINATION_RISK_CENTS_PER_WORK_OVER_TEN,
  );
  const nonPriceCostsCents = inputOpportunityCostCents
    + procurementFrictionCents
    + zeroCashFinancingCostCents
    + coordinationRiskCostCents;
  const basePriceCoins = minimumCoinPriceForNet(nonPriceCostsCents + requiredExternalMarginCents);
  const net = externalNetCents(basePriceCoins);
  const externalPlanGainCents = net - nonPriceCostsCents;
  const worstRouteOrderGainCents = externalPlanGainCents + ORDINARY_ORDER_PREMIUM_CENTS - maxCarrierCostCents;
  if (externalPlanGainCents < requiredExternalMarginCents || worstRouteOrderGainCents < MINIMUM_POSITIVE_GAIN_CENTS) {
    throw new Error(`Derived price is not individually rational for ${recipe.output}`);
  }
  prices[recipe.output] = basePriceCoins;
  return {
    index: index + 1,
    itemId: recipe.output,
    inputs,
    technicalWorkUnits: CATALOG_ANALYSIS.workUnits[recipe.output],
    inputOpportunityCostCents,
    procurementFrictionCents,
    zeroCashWorkingCapitalCents,
    zeroCashFinancingCostCents,
    coordinationRiskCostCents,
    requiredExternalMarginCents,
    basePriceCoins,
    externalNetCents: net,
    externalPlanGainCents,
    worstRouteOrderGainCents,
  };
});

const blueprintTotalCents = MARKET_CHALLENGE_RECIPE_IDS.reduce((sum, recipeId) => {
  const recipe = RECIPE_BY_ID.get(recipeId)!;
  return sum + prices[recipe.output] * 200;
}, 0);
const initialTreasuryCents = 15_000;

const result = {
  schema: "cat-workshop-derived-base-prices-v1",
  generatedAt: new Date().toISOString(),
  theorem: {
    objective: "For every recipe, choose the smallest integer coin price that keeps a zero-cash, fully-procured external plan profitable and leaves at least one cent to its seller on the longest starter route.",
    recurrence: "p_i = min {p in positive integers : net_tax(p) >= sum_j a_ij net_tax(p_j) + 25*m_i + ceil(0.02*K_i) + 15*max(W_i-10,0) + M}",
    workingCapital: "K_i = sum_j a_ij * (net_tax(p_j) + 100)",
    transportReserve: "M = max(1, (L_max-1)*25 - 100 + 1)",
    minimalityProof: "Recipes are a DAG. Induction fixes every input price before its output; monotonic net_tax makes the first feasible integer price unique and componentwise minimal.",
  },
  fixedGameParameters: {
    difficulty: DIFFICULTY,
    taxRate: TAX_RATE,
    procurementFrictionCentsPerMissingUnit: PROCUREMENT_FRICTION_CENTS,
    loanRate: LOAN_RATE,
    maxCarrierFeeCentsPerIntermediate: MAX_CARRIER_FEE_CENTS,
    ordinaryOrderPremiumCents: ORDINARY_ORDER_PREMIUM_CENTS,
    coordinationRiskCentsPerWorkOverTen: COORDINATION_RISK_CENTS_PER_WORK_OVER_TEN,
    maxStarterRouteEdges: maxRouteEdges,
    maxCarrierCostCents,
    requiredExternalMarginCents,
    minimumPositiveGainCents: MINIMUM_POSITIVE_GAIN_CENTS,
  },
  prices,
  rows,
  gates: {
    initialTreasuryCents,
    blueprint11To15TotalCents: blueprintTotalCents,
    blueprint11To15Affordable: blueprintTotalCents <= initialTreasuryCents,
    first10Prices: ITEMS.slice(0, 10).map((item) => [item.id, prices[item.id]]),
    first15Prices: ITEMS.slice(0, 15).map((item) => [item.id, prices[item.id]]),
  },
};

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output: OUTPUT, ...result.fixedGameParameters, ...result.gates }, null, 2)}\n`);
