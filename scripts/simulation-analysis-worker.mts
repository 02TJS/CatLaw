import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ITEMS,
  MARKET_CHALLENGE_RECIPE_IDS,
  RECIPES,
} from "../src/game/catalog";
import { effectiveRecipeInputs } from "../src/game/difficulty";
import {
  advanceGame,
  createInitialState,
  itemPrice,
  unlockRecipe,
} from "../src/game/engine";
import { hashSource } from "../src/game/lawInterpreter";
import { SHARED_BEHAVIOR_HASH, SHARED_BEHAVIOR_SOURCE } from "../src/game/lawProgram";
import { buyingPowerCents, creditAvailableCents, netWorthCents } from "../src/game/market";
import type { GameState, ItemId } from "../src/game/types";

const SIMULATION_SPEED = 5_000;
const STEP_LOGICAL_MS = 30_000;
const RAMP_LIMIT_LOGICAL_MS = 1_800_000;
const WINDOW_LOGICAL_MS = 300_000;
const WINDOWS = 3;
const MINIMUM_CRAFTS = 3;
const MINIMUM_ACTIVE_WINDOWS = 2;

function argument(name: string, fallback: string): string {
  return process.argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

const seedStart = Number(argument("--seed-start", "1"));
const seedCount = Number(argument("--seed-count", "1"));
const outputPath = argument("--output", `output/simulation-analysis-baseline-${seedStart}-${seedCount}.json`);
const profile = argument("--profile", "baseline-current-workspace");
const diagnosticIntervention = argument("--diagnostic-intervention", "none");
const starterLawProfile = argument("--starter-law-profile", "baseline");

function rankedNeedSource(rankCount: number, scarcityBonuses: number[], orderBonus: number): string {
  const lines = ["function decide(ctx) {"];
  for (let rank = 0; rank < rankCount; rank += 1) {
    const name = `need${rank}`;
    lines.push(`  const ${name} = marketNeed(${rank});`);
    lines.push(`  if (${name}) adjust("craft", ${name}, 1, orderCount(${name}) * ${orderBonus} + ${scarcityBonuses[rank] ?? 0});`);
  }
  lines.push("  return null;", "}");
  return lines.join("\n");
}

function stoichiometricNeedSource(
  balanceBonus: number,
  orderBonus = 250_000,
  scarcityBonuses = Array.from({ length: 15 }, (_, rank) => Math.max(0, 120_000 - rank * 8_000)),
): string {
  const ranked = rankedNeedSource(
    15,
    scarcityBonuses,
    orderBonus,
  );
  const body = ranked.slice(ranked.indexOf("{") + 1, ranked.lastIndexOf("}"))
    .trim()
    .replace(/\s*return null;\s*$/, "");
  return `function decide(ctx) {
  ${body}
  adjust("craft", "wood", 1, (recentCrafted("fire") + recentCrafted("plank") * 2 + recentCrafted("paper") - recentCrafted("wood")) * ${balanceBonus});
  adjust("craft", "stone", 1, (recentCrafted("brick") * 2 + recentCrafted("tools") - recentCrafted("stone")) * ${balanceBonus});
  adjust("craft", "sand", 1, (recentCrafted("glass") * 2 - recentCrafted("sand")) * ${balanceBonus});
  adjust("craft", "water", 1, (recentCrafted("brick") + recentCrafted("paper") - recentCrafted("water")) * ${balanceBonus});
  adjust("craft", "fiber", 1, (recentCrafted("thread") * 2 - recentCrafted("fiber")) * ${balanceBonus});
  adjust("craft", "ore", 1, (recentCrafted("metal") * 2 - recentCrafted("ore")) * ${balanceBonus});
  adjust("craft", "fire", 1, (recentCrafted("glass") + recentCrafted("metal") - recentCrafted("fire")) * ${balanceBonus});
  adjust("craft", "plank", 1, (recentCrafted("tools") - recentCrafted("plank")) * ${balanceBonus});
  adjust("craft", "metal", 1, (recentCrafted("gear") * 2 - recentCrafted("metal")) * ${balanceBonus});
  return null;
}`;
}

function targetCycleSource(feedbackBonus: number, orderBonus = 250_000): string {
  const targets: ReadonlyArray<readonly [string, number]> = [
    ["wood", 4], ["stone", 3], ["sand", 2], ["water", 2], ["fiber", 2], ["ore", 2],
    ["fire", 2], ["plank", 1], ["brick", 1], ["thread", 1], ["paper", 1], ["tools", 1],
    ["glass", 1], ["metal", 2], ["gear", 1],
  ];
  const lines = [
    "function decide(ctx) {",
    "  const least = marketNeed(0);",
    "  const cycle = least ? recentCrafted(least) + 1 : 1;",
  ];
  for (const [itemId, target] of targets) {
    lines.push(`  adjust("craft", "${itemId}", 1, (${target} * cycle - recentCrafted("${itemId}")) * ${feedbackBonus} + orderCount("${itemId}") * ${orderBonus});`);
  }
  lines.push("  return null;", "}");
  return lines.join("\n");
}

function bufferedFlowSource(balanceBonus: number, cycleBonus: number, pipelineBatches = 1): string {
  const items = ["wood", "stone", "sand", "water", "fiber", "ore", "fire", "plank", "brick", "thread", "paper", "tools", "glass", "metal", "gear"];
  const ranked = rankedNeedSource(
    15,
    Array.from({ length: 15 }, (_, rank) => Math.max(0, 120_000 - rank * 8_000)),
    250_000,
  );
  const rankedBody = ranked.slice(ranked.indexOf("{") + 1, ranked.lastIndexOf("}"))
    .trim()
    .replace(/\s*return null;\s*$/, "");
  const lines = [
    "function decide(ctx) {",
    `  ${rankedBody}`,
    "  const least = marketNeed(0);",
    "  const cycle = least ? recentCrafted(least) + 1 : 1;",
  ];
  for (const itemId of items) {
    lines.push(`  adjust("craft", "${itemId}", 1, (cycle - recentCrafted("${itemId}")) * ${cycleBonus});`);
  }
  lines.push(
    `  adjust("craft", "wood", 1, (recentCrafted("fire") + recentCrafted("plank") * 2 + recentCrafted("paper") + ${pipelineBatches} - recentCrafted("wood")) * ${balanceBonus});`,
    `  adjust("craft", "stone", 1, (recentCrafted("brick") * 2 + recentCrafted("tools") + ${pipelineBatches} - recentCrafted("stone")) * ${balanceBonus});`,
    `  adjust("craft", "sand", 1, (recentCrafted("glass") * 2 + ${pipelineBatches} - recentCrafted("sand")) * ${balanceBonus});`,
    `  adjust("craft", "water", 1, (recentCrafted("brick") + recentCrafted("paper") + ${pipelineBatches} - recentCrafted("water")) * ${balanceBonus});`,
    `  adjust("craft", "fiber", 1, (recentCrafted("thread") * 2 + ${pipelineBatches} - recentCrafted("fiber")) * ${balanceBonus});`,
    `  adjust("craft", "ore", 1, (recentCrafted("metal") * 2 + ${pipelineBatches} - recentCrafted("ore")) * ${balanceBonus});`,
    `  adjust("craft", "fire", 1, (recentCrafted("glass") + recentCrafted("metal") + ${pipelineBatches} - recentCrafted("fire")) * ${balanceBonus});`,
    `  adjust("craft", "plank", 1, (recentCrafted("tools") + ${pipelineBatches} - recentCrafted("plank")) * ${balanceBonus});`,
    `  adjust("craft", "metal", 1, (recentCrafted("gear") * 2 + ${pipelineBatches} - recentCrafted("metal")) * ${balanceBonus});`,
    "  return null;",
    "}",
  );
  return lines.join("\n");
}

function targetedFlowRecoverySource(
  recoveryBonus: number,
  leadItems: ReadonlyArray<"wood" | "fiber" | "plank" | "fire" | "metal">,
  orderBonus = 250_000,
  leadBonus = 900_000,
): string {
  const source = stoichiometricNeedSource(900_000, orderBonus);
  const body = source.slice(source.indexOf("{") + 1, source.lastIndexOf("}"))
    .trim()
    .replace(/\s*return null;\s*$/, "");
  const leadSources = {
    wood: `  adjust("craft", "wood", 1, (recentCrafted("fire") + recentCrafted("plank") * 2 + recentCrafted("paper") + 1 - recentCrafted("wood")) * ${leadBonus});`,
    fiber: `  adjust("craft", "fiber", 1, (recentCrafted("thread") * 2 + 1 - recentCrafted("fiber")) * ${leadBonus});`,
    plank: `  adjust("craft", "plank", 1, (recentCrafted("tools") + 1 - recentCrafted("plank")) * ${leadBonus});`,
    fire: `  adjust("craft", "fire", 1, (recentCrafted("glass") + recentCrafted("metal") + 1 - recentCrafted("fire")) * ${leadBonus});`,
    metal: `  adjust("craft", "metal", 1, (recentCrafted("gear") * 2 + 1 - recentCrafted("metal")) * ${leadBonus});`,
  } as const;
  const supplyLead = leadItems.map((itemId) => leadSources[itemId]).join("\n");
  return `function decide(ctx) {
  ${body}
${supplyLead ? `${supplyLead}\n` : ""}  if (recentCrafted("brick") === 0) adjust("craft", "brick", 1, ${recoveryBonus});
  if (recentCrafted("paper") === 0) adjust("craft", "paper", 1, ${recoveryBonus});
  return null;
}`;
}

function targetedFlowFinalSource(
  leadItems: ReadonlyArray<"wood" | "fiber" | "fire"> = ["wood"],
  recoverGlass = true,
  leadBonus = 900_000,
): string {
  const source = targetedFlowRecoverySource(900_000, leadItems, 250_000, leadBonus);
  const body = source.slice(source.indexOf("{") + 1, source.lastIndexOf("}"))
    .trim()
    .replace(/\s*return null;\s*$/, "");
  return `function decide(ctx) {
  ${body}
  if (recentCrafted("tools") > recentCrafted("plank")) adjust("craft", "plank", 1, 900000);
  if (${recoverGlass ? "recentCrafted(\"glass\") === 0" : "false"}) adjust("craft", "glass", 1, 900000);
  return null;
}`;
}

function resourceOrderResponseSource(orderBonus: number, lowStockBonus = 0, lowStockThreshold = 0): string {
  return `function decide(ctx) {
  const item = ctx.site && ctx.site.resourceItemId ? ctx.site.resourceItemId : "";
  if (item) {
    adjust("craft", item, 1, 500000 - recentCrafted(item) * 50000 + orderCount(item) * ${orderBonus});
    if (count(item) <= ${lowStockThreshold}) adjust("craft", item, 1, ${lowStockBonus});
  }
  return null;
}`;
}

function targetedFlowDemandCoverageSource(): string {
  const source = targetedFlowFinalSource(["wood", "fiber", "plank"]);
  const body = source.slice(source.indexOf("{") + 1, source.lastIndexOf("}"))
    .trim()
    .replace(/\s*return null;\s*$/, "");
  return `function decide(ctx) {
  ${body}
  adjust("craft", "fire", 1, (recentCrafted("glass") + recentCrafted("metal") + 1 - recentCrafted("fire")) * 900000);
  adjust("craft", "metal", 1, (recentCrafted("gear") * 2 + recentCrafted("cable") + recentCrafted("battery") + recentCrafted("chassis") + 1 - recentCrafted("metal")) * 900000);
  adjust("craft", "stone", 1, (recentCrafted("brick") * 2 + recentCrafted("tools") + 1 - recentCrafted("stone")) * 900000);
  if (recentCrafted("paper") <= 1) adjust("craft", "paper", 1, 900000);
  return null;
}`;
}

function targetedFlowThresholdSource(threshold: number): string {
  const source = targetedFlowFinalSource(["wood", "fiber"]);
  const body = source.slice(source.indexOf("{") + 1, source.lastIndexOf("}"))
    .trim()
    .replace(/\s*return null;\s*$/, "");
  return `function decide(ctx) {
  ${body}
  if (recentCrafted("brick") < ${threshold}) adjust("craft", "brick", 1, 900000);
  if (recentCrafted("tools") < ${threshold}) adjust("craft", "tools", 1, 900000);
  if (recentCrafted("gear") < ${threshold}) adjust("craft", "gear", 1, 900000);
  if (recentCrafted("paper") < ${threshold}) adjust("craft", "paper", 1, 900000);
  if (recentCrafted("glass") + recentCrafted("metal") > recentCrafted("fire") + 1) adjust("craft", "fire", 1, 900000);
  if (recentCrafted("gear") * 2 + recentCrafted("cable") + recentCrafted("battery") + recentCrafted("chassis") > recentCrafted("metal") + 1) adjust("craft", "metal", 1, 900000);
  return null;
}`;
}

const STARTER_LAW_PROFILES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  baseline: Object.freeze({}),
  "selfish-only": Object.freeze({
    "starter-law-workshop-cycle": "function decide(ctx) { return null; }",
  }),
  "scarcity-light": Object.freeze({
    "starter-law-workshop-cycle": rankedNeedSource(3, [120_000, 80_000, 40_000], 200_000),
  }),
  "demand-15": Object.freeze({
    "starter-law-workshop-cycle": rankedNeedSource(15, Array.from({ length: 15 }, () => 0), 250_000),
  }),
  "scarcity-demand-15": Object.freeze({
    "starter-law-workshop-cycle": rankedNeedSource(
      15,
      Array.from({ length: 15 }, (_, rank) => Math.max(0, 120_000 - rank * 8_000)),
      250_000,
    ),
  }),
  "supply-demand-15": Object.freeze({
    "starter-law-resource-supply": `function decide(ctx) {
  const item = ctx.site && ctx.site.resourceItemId ? ctx.site.resourceItemId : "";
  if (item) adjust("craft", item, 1, 650000 + orderCount(item) * 250000 - recentCrafted(item) * 40000);
  return null;
}`,
    "starter-law-workshop-cycle": rankedNeedSource(15, Array.from({ length: 15 }, () => 0), 250_000),
  }),
  "resource-reserve": Object.freeze({
    "starter-law-resource-supply": `function decide(ctx) {
  const item = ctx.site && ctx.site.resourceItemId ? ctx.site.resourceItemId : "";
  if (item) {
    adjust("craft", item, 4, 1000000 + orderCount(item) * 250000 + (12 - count(item)) * 120000);
    if (count(item) < 6) adjust("craft", item, 4, 1500000);
  }
  return null;
}`,
  }),
  "resource-reserve15": Object.freeze({
    "starter-law-resource-supply": `function decide(ctx) {
  const item = ctx.site && ctx.site.resourceItemId ? ctx.site.resourceItemId : "";
  if (item) {
    adjust("craft", item, 4, 1000000 + orderCount(item) * 250000 + (12 - count(item)) * 120000);
    if (count(item) < 6) adjust("craft", item, 4, 1500000);
  }
  return null;
}`,
    "starter-law-workshop-cycle": rankedNeedSource(15, Array.from({ length: 15 }, () => 0), 250_000),
  }),
  "resource-reserve15-scarcity": Object.freeze({
    "starter-law-resource-supply": `function decide(ctx) {
  const item = ctx.site && ctx.site.resourceItemId ? ctx.site.resourceItemId : "";
  if (item) {
    adjust("craft", item, 4, 1000000 + orderCount(item) * 250000 + (12 - count(item)) * 120000);
    if (count(item) < 6) adjust("craft", item, 4, 1500000);
  }
  return null;
}`,
    "starter-law-workshop-cycle": rankedNeedSource(
      15,
      Array.from({ length: 15 }, (_, rank) => Math.max(0, 120_000 - rank * 8_000)),
      250_000,
    ),
  }),
  "resource-reserve24": Object.freeze({
    "starter-law-resource-supply": `function decide(ctx) {
  const item = ctx.site && ctx.site.resourceItemId ? ctx.site.resourceItemId : "";
  if (item) {
    adjust("craft", item, 8, 2000000 + orderCount(item) * 500000 + (24 - count(item)) * 150000);
    if (count(item) < 12) adjust("craft", item, 8, 3000000);
  }
  return null;
}`,
    "starter-law-workshop-cycle": rankedNeedSource(15, Array.from({ length: 15 }, () => 0), 250_000),
  }),
  "stoich15-250": Object.freeze({
    "starter-law-workshop-cycle": stoichiometricNeedSource(250_000),
  }),
  "stoich15-500": Object.freeze({
    "starter-law-workshop-cycle": stoichiometricNeedSource(500_000),
  }),
  "stoich15-900": Object.freeze({
    "starter-law-workshop-cycle": stoichiometricNeedSource(900_000),
  }),
  "stoich15-900-pulse": Object.freeze({
    "starter-law-workshop-cycle": stoichiometricNeedSource(
      900_000,
      250_000,
      [900_000, 600_000, 300_000, 200_000, 150_000, 120_000, 100_000, 80_000, 60_000, 40_000, 30_000, 20_000, 10_000, 5_000, 0],
    ),
  }),
  "stoich15-900-pulse-flex500": Object.freeze({
    "starter-law-foundation-cycle": `function decide(ctx) {
  const item = ctx.ownPlan ? ctx.ownPlan.outputItemId : "";
  if (item) adjust("craft", item, 2, 500000);
  return null;
}`,
    "starter-law-workshop-cycle": stoichiometricNeedSource(
      900_000,
      250_000,
      [900_000, 600_000, 300_000, 200_000, 150_000, 120_000, 100_000, 80_000, 60_000, 40_000, 30_000, 20_000, 10_000, 5_000, 0],
    ),
  }),
  "stoich15-900-pulse-flex200": Object.freeze({
    "starter-law-foundation-cycle": `function decide(ctx) {
  const item = ctx.ownPlan ? ctx.ownPlan.outputItemId : "";
  if (item) adjust("craft", item, 1.5, 200000);
  return null;
}`,
    "starter-law-workshop-cycle": stoichiometricNeedSource(
      900_000,
      250_000,
      [900_000, 600_000, 300_000, 200_000, 150_000, 120_000, 100_000, 80_000, 60_000, 40_000, 30_000, 20_000, 10_000, 5_000, 0],
    ),
  }),
  "target-cycle15-250": Object.freeze({
    "starter-law-workshop-cycle": targetCycleSource(250_000),
  }),
  "target-cycle15-500": Object.freeze({
    "starter-law-workshop-cycle": targetCycleSource(500_000),
  }),
  "target-cycle15-900": Object.freeze({
    "starter-law-workshop-cycle": targetCycleSource(900_000),
  }),
  "flow-buffer1": Object.freeze({
    "starter-law-workshop-cycle": bufferedFlowSource(900_000, 0),
  }),
  "flow-buffer1-cycle250": Object.freeze({
    "starter-law-workshop-cycle": bufferedFlowSource(900_000, 250_000),
  }),
  "flow-buffer1-cycle500": Object.freeze({
    "starter-law-workshop-cycle": bufferedFlowSource(900_000, 500_000),
  }),
  "flow-targeted900": Object.freeze({
    "starter-law-workshop-cycle": targetedFlowRecoverySource(900_000, []),
  }),
  "flow-targeted900-woodlead": Object.freeze({
    "starter-law-workshop-cycle": targetedFlowRecoverySource(900_000, ["wood"]),
  }),
  "flow-targeted-order500-leads": Object.freeze({
    "starter-law-workshop-cycle": targetedFlowRecoverySource(900_000, ["wood", "fiber", "plank"], 500_000),
  }),
  "flow-targeted-order900-leads": Object.freeze({
    "starter-law-workshop-cycle": targetedFlowRecoverySource(900_000, ["wood", "fiber", "plank"], 900_000),
  }),
  "flow-targeted-chainleads": Object.freeze({
    "starter-law-workshop-cycle": targetedFlowRecoverySource(900_000, ["wood", "fiber", "plank", "fire", "metal"]),
  }),
  "flow-targeted-final": Object.freeze({
    "starter-law-workshop-cycle": targetedFlowFinalSource(),
  }),
  "flow-targeted-final-fiber": Object.freeze({
    "starter-law-workshop-cycle": targetedFlowFinalSource(["wood", "fiber"]),
  }),
  "flow-targeted-final-fire": Object.freeze({
    "starter-law-workshop-cycle": targetedFlowFinalSource(["wood", "fire"]),
  }),
  "flow-targeted-final-fiber-fire": Object.freeze({
    "starter-law-workshop-cycle": targetedFlowFinalSource(["wood", "fiber", "fire"]),
  }),
  "flow-targeted-final-resource20": Object.freeze({
    "starter-law-resource-supply": resourceOrderResponseSource(20_000),
    "starter-law-workshop-cycle": targetedFlowFinalSource(),
  }),
  "flow-targeted-final-resource50": Object.freeze({
    "starter-law-resource-supply": resourceOrderResponseSource(50_000),
    "starter-law-workshop-cycle": targetedFlowFinalSource(),
  }),
  "flow-targeted-final-resource100": Object.freeze({
    "starter-law-resource-supply": resourceOrderResponseSource(100_000),
    "starter-law-workshop-cycle": targetedFlowFinalSource(),
  }),
  "flow-targeted-final-resource50-stock": Object.freeze({
    "starter-law-resource-supply": resourceOrderResponseSource(50_000, 200_000, 1),
    "starter-law-workshop-cycle": targetedFlowFinalSource(),
  }),
  "flow-targeted-final-resource20-leads": Object.freeze({
    "starter-law-resource-supply": resourceOrderResponseSource(20_000),
    "starter-law-workshop-cycle": targetedFlowFinalSource(["wood", "fiber", "plank"]),
  }),
  "flow-targeted-demand-coverage": Object.freeze({
    "starter-law-resource-supply": resourceOrderResponseSource(20_000),
    "starter-law-workshop-cycle": targetedFlowDemandCoverageSource(),
  }),
  "flow-targeted-final-resource20-woodfiber": Object.freeze({
    "starter-law-resource-supply": resourceOrderResponseSource(20_000),
    "starter-law-workshop-cycle": targetedFlowFinalSource(["wood", "fiber"]),
  }),
  "flow-targeted-final-resource20-woodplank": Object.freeze({
    "starter-law-resource-supply": resourceOrderResponseSource(20_000),
    "starter-law-workshop-cycle": targetedFlowFinalSource(["wood"]),
  }),
  "flow-targeted-final-resource20-fiberplank": Object.freeze({
    "starter-law-resource-supply": resourceOrderResponseSource(20_000),
    "starter-law-workshop-cycle": targetedFlowFinalSource(["fiber", "plank"]),
  }),
  "flow-targeted-final-resource20-leads-600": Object.freeze({
    "starter-law-resource-supply": resourceOrderResponseSource(20_000),
    "starter-law-workshop-cycle": targetedFlowFinalSource(["wood", "fiber", "plank"], true, 600_000),
  }),
  "flow-targeted-final-resource20-leads-300": Object.freeze({
    "starter-law-resource-supply": resourceOrderResponseSource(20_000),
    "starter-law-workshop-cycle": targetedFlowFinalSource(["wood", "fiber", "plank"], true, 300_000),
  }),
  "flow-targeted-threshold1": Object.freeze({
    "starter-law-resource-supply": resourceOrderResponseSource(20_000),
    "starter-law-workshop-cycle": targetedFlowThresholdSource(1),
  }),
  "flow-targeted-threshold2": Object.freeze({
    "starter-law-resource-supply": resourceOrderResponseSource(20_000),
    "starter-law-workshop-cycle": targetedFlowThresholdSource(2),
  }),
  "flow-targeted-threshold3": Object.freeze({
    "starter-law-resource-supply": resourceOrderResponseSource(20_000),
    "starter-law-workshop-cycle": targetedFlowThresholdSource(3),
  }),
  "flow-targeted-threshold1-resource-local100": Object.freeze({
    "starter-law-resource-supply": resourceOrderResponseSource(20_000, 100_000, 0),
    "starter-law-workshop-cycle": targetedFlowThresholdSource(1),
  }),
  "flow-targeted-threshold1-resource-local200": Object.freeze({
    "starter-law-resource-supply": resourceOrderResponseSource(20_000, 200_000, 0),
    "starter-law-workshop-cycle": targetedFlowThresholdSource(1),
  }),
  "flow-targeted-threshold1-resource-local300": Object.freeze({
    "starter-law-resource-supply": resourceOrderResponseSource(20_000, 300_000, 0),
    "starter-law-workshop-cycle": targetedFlowThresholdSource(1),
  }),
});

function applyStarterLawProfile(state: GameState): void {
  const replacements = STARTER_LAW_PROFILES[starterLawProfile];
  if (!replacements) throw new Error(`Unknown --starter-law-profile=${starterLawProfile}`);
  for (const [lawId, sourceCode] of Object.entries(replacements)) {
    const law = state.laws.find((entry) => entry.id === lawId);
    if (!law) throw new Error(`Starter law not found for profile ${starterLawProfile}: ${lawId}`);
    law.sourceCode = sourceCode;
    law.astHash = hashSource(sourceCode);
  }
}

if (!Number.isInteger(seedStart) || seedStart <= 0 || !Number.isInteger(seedCount) || seedCount <= 0) {
  throw new Error("--seed-start and --seed-count must be positive integers");
}

type Snapshot = {
  logicalMs: number;
  crafted: Record<ItemId, number>;
  stock: Record<ItemId, number>;
  commandSequence: number;
  lawbookRevision: number;
  activeLawIds: string[];
  openOrderIds: string[];
  openContracts: Array<{ id: string; currentLeg: number }>;
  claimedBounties: string[];
  activePlanIds: string[];
};

function logicalNow(state: GameState): number {
  return Math.round(state.simTime * state.simulationSpeed);
}

function aggregateStock(state: GameState): Record<ItemId, number> {
  const stock = Object.fromEntries(ITEMS.map((item) => [item.id, 0])) as Record<ItemId, number>;
  const add = (itemId: string, quantity: number) => {
    if (quantity > 0 && itemId in stock) stock[itemId] += quantity;
  };
  for (const cat of state.cats) {
    for (const [itemId, quantity] of Object.entries(cat.inventory)) add(itemId, quantity);
    if (cat.action?.type === "craft") {
      for (const [itemId, quantity] of Object.entries(cat.action.reserved)) add(itemId, quantity);
    }
  }
  for (const contract of state.shipmentContracts) {
    if (contract.status !== "delivered") add(contract.itemId, 1);
  }
  for (const [itemId, quantity] of Object.entries(state.playerBuildingInventory)) add(itemId, quantity);
  for (const building of state.buildings) add(building.itemId, 1);
  return stock;
}

function snapshot(state: GameState): Snapshot {
  return {
    logicalMs: logicalNow(state),
    crafted: Object.fromEntries(ITEMS.map((item) => [item.id, state.itemStats[item.id].crafted])) as Record<ItemId, number>,
    stock: aggregateStock(state),
    commandSequence: state.commandAudit.at(-1)?.sequence ?? 0,
    lawbookRevision: state.lawbookRevision,
    activeLawIds: state.laws.filter((law) => law.status === "active").map((law) => law.id),
    openOrderIds: state.demandOrders.filter((order) => order.status === "open").map((order) => order.id),
    openContracts: state.shipmentContracts.filter((contract) => contract.status !== "delivered")
      .map((contract) => ({ id: contract.id, currentLeg: contract.currentLeg })),
    claimedBounties: state.discoveryBounties.filter((bounty) => !bounty.paid && bounty.claimedByCatId)
      .map((bounty) => `${bounty.itemId}:${bounty.claimedByCatId}`),
    activePlanIds: state.procurementPlans.filter((plan) => plan.status === "active").map((plan) => plan.id),
  };
}

function advanceLogical(state: GameState, logicalMs: number): void {
  for (let elapsed = 0; elapsed < logicalMs; elapsed += STEP_LOGICAL_MS) {
    const step = Math.min(STEP_LOGICAL_MS, logicalMs - elapsed);
    advanceGame(state, step / state.simulationSpeed);
  }
}

function craftedThrough(state: GameState, through: number): boolean {
  return RECIPES.slice(0, through).every((recipe) => state.itemStats[recipe.output].crafted > 0);
}

function runUntil(state: GameState, predicate: () => boolean, limitLogicalMs = RAMP_LIMIT_LOGICAL_MS) {
  const startedAt = logicalNow(state);
  while (!predicate() && logicalNow(state) - startedAt < limitLogicalMs) {
    advanceLogical(state, Math.min(STEP_LOGICAL_MS, limitLogicalMs - (logicalNow(state) - startedAt)));
  }
  return {
    reached: predicate(),
    logicalElapsedMs: logicalNow(state) - startedAt,
  };
}

function creditGapForOrder(state: GameState, orderId: string): number {
  const order = state.demandOrders.find((entry) => entry.id === orderId);
  if (!order || order.status !== "open" || order.buyerKind !== "cat" || !order.buyerCatId) return 0;
  const buyer = state.cats.find((cat) => cat.id === order.buyerCatId);
  if (!buyer) return 0;
  return Math.max(0, order.reservedCents - buyingPowerCents(state, buyer, (itemId) => itemPrice(state, itemId, buyer)));
}

function contractDiagnostic(state: GameState, contractId: string) {
  const contract = state.shipmentContracts.find((entry) => entry.id === contractId);
  if (!contract) return null;
  const holderId = contract.routeCatIds[contract.currentLeg] ?? contract.custodianCatId;
  const holder = state.cats.find((cat) => cat.id === holderId);
  const nextId = contract.routeCatIds[contract.currentLeg + 1] ?? null;
  const next = state.cats.find((cat) => cat.id === nextId);
  const order = state.demandOrders.find((entry) => entry.id === contract.orderId);
  const plan = order?.planId ? state.procurementPlans.find((entry) => entry.id === order.planId) : null;
  return {
    id: contract.id,
    orderId: contract.orderId,
    itemId: contract.itemId,
    status: contract.status,
    currentLeg: contract.currentLeg,
    routeCatIds: contract.routeCatIds,
    custodianCatId: contract.custodianCatId,
    acceptedAtLogicalMs: Math.round(contract.acceptedAt * state.simulationSpeed),
    escrowCents: contract.escrowCents,
    sellerPriceCents: contract.sellerPriceCents,
    feesByCatId: contract.feesByCatId,
    holder: holder ? {
      id: holder.id,
      position: holder.position,
      inventory: holder.inventory,
      coins: holder.coins,
      debtCents: holder.debtCents,
      escrowReservedCents: holder.escrowReservedCents,
      creditAvailableCents: creditAvailableCents(state, holder, (itemId) => itemPrice(state, itemId, holder)),
      netWorthCents: netWorthCents(state, holder, (itemId) => itemPrice(state, itemId, holder)),
      action: holder.action,
      lastDecision: holder.lastDecision,
      decisionTrace: holder.decisionTrace,
    } : null,
    next: next ? { id: next.id, position: next.position, action: next.action } : null,
    order: order ? {
      status: order.status,
      itemId: order.itemId,
      buyerCatId: order.buyerCatId,
      destinationCatId: order.destinationCatId,
      reservedCents: order.reservedCents,
      maxDeliveredCents: order.maxDeliveredCents,
      closeReason: order.closeReason,
    } : null,
    plan: plan ? {
      id: plan.id,
      catId: plan.catId,
      outputItemId: plan.outputItemId,
      status: plan.status,
      reason: plan.reason,
      expectedRevenueCents: plan.expectedRevenueCents,
    } : null,
  };
}

function evaluateStability(state: GameState, through: number, samples: Snapshot[]) {
  const start = samples[0];
  const end = samples.at(-1)!;
  const itemEvidence = RECIPES.slice(0, through).map((recipe, index) => {
    const windowCrafts = samples.slice(1).map((entry, windowIndex) => (
      entry.crafted[recipe.output] - samples[windowIndex].crafted[recipe.output]
    ));
    const craftedDuringObservation = windowCrafts.reduce((sum, value) => sum + value, 0);
    const activeWindows = windowCrafts.filter((value) => value > 0).length;
    const repeated = craftedDuringObservation >= MINIMUM_CRAFTS;
    const stable = repeated && activeWindows >= MINIMUM_ACTIVE_WINDOWS;
    return {
      index: index + 1,
      itemId: recipe.output,
      craftedDuringObservation,
      windowCrafts,
      activeWindows,
      classification: stable ? "stable" : repeated ? "repeated" : end.crafted[recipe.output] > 0 ? "first-crafted" : "not-produced",
      stable,
    };
  });
  let stableThrough = 0;
  for (const item of itemEvidence) {
    if (!item.stable) break;
    stableThrough += 1;
  }
  const windowTargetCraftTotals = samples.slice(1).map((entry, windowIndex) => RECIPES.slice(0, through).reduce((sum, recipe) => (
    sum + entry.crafted[recipe.output] - samples[windowIndex].crafted[recipe.output]
  ), 0));
  const majorDeclines = windowTargetCraftTotals.slice(1).map((value, index) => value < windowTargetCraftTotals[index] * 0.5);
  const twoConsecutiveMajorDeclines = majorDeclines.length >= 2 && majorDeclines.every(Boolean);
  const lastWindowActive = (windowTargetCraftTotals.at(-1) ?? 0) > 0;

  const produced = Object.fromEntries(ITEMS.map((item) => [item.id, end.crafted[item.id] - start.crafted[item.id]])) as Record<ItemId, number>;
  const consumed = Object.fromEntries(ITEMS.map((item) => [item.id, 0])) as Record<ItemId, number>;
  for (const recipe of RECIPES) {
    const completed = produced[recipe.output];
    if (completed <= 0) continue;
    for (const input of effectiveRecipeInputs(recipe, state.difficulty)) consumed[input.itemId] += completed * input.quantity;
  }
  const materialCoverage = ITEMS.flatMap((item) => {
    if (consumed[item.id] <= 0) return [];
    const stockStart = start.stock[item.id];
    const stockEnd = end.stock[item.id];
    const stockChange = stockEnd - stockStart;
    const uncoveredConsumption = Math.max(0, consumed[item.id] - produced[item.id]);
    const drawdownThreshold = Math.max(3, Math.ceil(stockStart * 0.2));
    return [{
      itemId: item.id,
      crafted: produced[item.id],
      consumed: consumed[item.id],
      stockStart,
      stockEnd,
      stockByWindow: samples.map((entry) => entry.stock[item.id]),
      stockChange,
      uncoveredConsumption,
      passed: !(stockChange <= -drawdownThreshold && uncoveredConsumption > 0),
    }];
  });

  const startOrderIds = new Set(start.openOrderIds);
  const creditBlockedOrders = end.openOrderIds.flatMap((orderId) => {
    const gap = startOrderIds.has(orderId) ? creditGapForOrder(state, orderId) : 0;
    const order = state.demandOrders.find((entry) => entry.id === orderId);
    return gap > 0 && order ? [{ orderId, itemId: order.itemId, creditGapCents: gap, buyerCatId: order.buyerCatId }] : [];
  });
  const startContracts = new Map(start.openContracts.map((contract) => [contract.id, contract.currentLeg]));
  const stalledContracts = end.openContracts.flatMap((contract) => (
    startContracts.get(contract.id) === contract.currentLeg ? [contractDiagnostic(state, contract.id)] : []
  )).filter(Boolean);
  const startBounties = new Set(start.claimedBounties);
  const claimedUnpaidBounties = end.claimedBounties.filter((entry) => {
    if (!startBounties.has(entry)) return false;
    const itemId = entry.split(":")[0];
    return end.crafted[itemId] - start.crafted[itemId] === 0;
  });
  const startPlans = new Set(start.activePlanIds);
  const stalledPlans = end.activePlanIds.flatMap((planId) => {
    if (!startPlans.has(planId)) return [];
    const plan = state.procurementPlans.find((entry) => entry.id === planId);
    return plan && end.crafted[plan.outputItemId] - start.crafted[plan.outputItemId] === 0 ? [{
      id: plan.id,
      catId: plan.catId,
      outputItemId: plan.outputItemId,
      reason: plan.reason,
      expectedRevenueCents: plan.expectedRevenueCents,
    }] : [];
  });
  const forbiddenPlayerCommands = state.commandAudit.filter((entry) => entry.origin === "player-ui"
    && entry.sequence > start.commandSequence && entry.sequence <= end.commandSequence && entry.kind !== "advance-time");
  const lawbookUnchanged = start.lawbookRevision === end.lawbookRevision
    && JSON.stringify(start.activeLawIds) === JSON.stringify(end.activeLawIds);
  const materialFailures = materialCoverage.filter((entry) => !entry.passed);
  const failureReasons: string[] = [];
  const unstableItems = itemEvidence.filter((entry) => !entry.stable).map((entry) => entry.itemId);
  if (unstableItems.length) failureReasons.push(`unstable:${unstableItems.join(",")}`);
  if (!lastWindowActive) failureReasons.push("last-window-inactive");
  if (twoConsecutiveMajorDeclines) failureReasons.push("two-major-declines");
  if (materialFailures.length) failureReasons.push(`material-drawdown:${materialFailures.map((entry) => entry.itemId).join(",")}`);
  if (creditBlockedOrders.length) failureReasons.push(`credit-blocked:${creditBlockedOrders.map((entry) => entry.itemId).join(",")}`);
  if (stalledContracts.length) failureReasons.push(`stalled-contract:${stalledContracts.map((entry) => entry?.itemId).join(",")}`);
  if (claimedUnpaidBounties.length) failureReasons.push(`stalled-bounty:${claimedUnpaidBounties.join(",")}`);
  if (stalledPlans.length) failureReasons.push(`stalled-plan:${stalledPlans.map((entry) => entry.outputItemId).join(",")}`);
  if (forbiddenPlayerCommands.length) failureReasons.push("forbidden-player-command");
  if (!lawbookUnchanged) failureReasons.push("lawbook-changed");
  return {
    targetThrough: through,
    observationLogicalMs: end.logicalMs - start.logicalMs,
    stableThrough,
    passed: failureReasons.length === 0,
    itemEvidence,
    nextItemEvidence: (() => {
      const recipe = RECIPES[through];
      if (!recipe) return null;
      const windowCrafts = samples.slice(1).map((entry, windowIndex) => entry.crafted[recipe.output] - samples[windowIndex].crafted[recipe.output]);
      return { itemId: recipe.output, windowCrafts, craftedDuringObservation: windowCrafts.reduce((sum, value) => sum + value, 0) };
    })(),
    windowTargetCraftTotals,
    lastWindowActive,
    twoConsecutiveMajorDeclines,
    materialCoverage,
    frozenEconomy: { creditBlockedOrders, stalledContracts, claimedUnpaidBounties, stalledPlans },
    forbiddenPlayerCommands,
    lawbookUnchanged,
    failureReasons,
  };
}

function observe(state: GameState, through: number) {
  const samples = [snapshot(state)];
  for (let window = 0; window < WINDOWS; window += 1) {
    advanceLogical(state, WINDOW_LOGICAL_MS);
    samples.push(snapshot(state));
  }
  return evaluateStability(state, through, samples);
}

function stateSummary(state: GameState) {
  return {
    logicalMs: logicalNow(state),
    treasuryCents: state.treasuryCoins,
    totalCatCashCents: state.cats.reduce((sum, cat) => sum + cat.coins, 0),
    totalDebtCents: state.cats.reduce((sum, cat) => sum + cat.debtCents, 0),
    totalEscrowReservedCents: state.cats.reduce((sum, cat) => sum + cat.escrowReservedCents, 0),
    openOrders: state.demandOrders.filter((order) => order.status === "open").length,
    liveContracts: state.shipmentContracts.filter((contract) => contract.status !== "delivered").length,
    activePlans: state.procurementPlans.filter((plan) => plan.status === "active").length,
    laws: state.laws.map((law) => ({ id: law.id, status: law.status, hitCount: law.hitCount, invalidCount: law.invalidCount })),
  };
}

async function fileHash(relativePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(new URL(`../${relativePath}`, import.meta.url))).digest("hex");
}

const startedAt = performance.now();
const runs = [];
for (let seed = seedStart; seed < seedStart + seedCount; seed += 1) {
  const state = createInitialState({ worldSeed: seed, difficulty: 5, simulationSpeed: SIMULATION_SPEED });
  applyStarterLawProfile(state);
  const behaviorHashStart = SHARED_BEHAVIOR_HASH;
  const stage10Ramp = runUntil(state, () => craftedThrough(state, 10));
  const stage10 = observe(state, 10);
  const treasuryBeforeBlueprints = state.treasuryCoins;
  const blueprintResults = MARKET_CHALLENGE_RECIPE_IDS.map((recipeId) => ({ recipeId, ...unlockRecipe(state, recipeId) }));
  const blueprintSpendCents = treasuryBeforeBlueprints - state.treasuryCoins;
  const stage15Ramp = runUntil(state, () => craftedThrough(state, 15));
  const stage15 = observe(state, 15);
  runs.push({
    seed,
    behaviorHashStart,
    behaviorHashEnd: SHARED_BEHAVIOR_HASH,
    behaviorHashUnchanged: behaviorHashStart === SHARED_BEHAVIOR_HASH,
    stage10Ramp,
    stage10,
    blueprintResults,
    blueprintSpendCents,
    stage15Ramp,
    stage15,
    finalState: stateSummary(state),
  });
}

const result = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  profile,
  seedRange: { start: seedStart, count: seedCount },
  configuration: {
    difficulty: 5,
    simulationSpeed: SIMULATION_SPEED,
    actionDurationLogicalMs: 5_000,
    rampLimitLogicalMs: RAMP_LIMIT_LOGICAL_MS,
    windows: WINDOWS,
    windowLogicalMs: WINDOW_LOGICAL_MS,
    minimumCraftsPerItem: MINIMUM_CRAFTS,
    minimumActiveWindowsPerItem: MINIMUM_ACTIVE_WINDOWS,
    playerOperations: "none before stage 10; unlock recipes 11-15 only before stage 15",
    diagnosticIntervention,
    starterLawProfile,
  },
  authority: {
    sharedBehaviorHash: SHARED_BEHAVIOR_HASH,
    sharedBehaviorSource: SHARED_BEHAVIOR_SOURCE,
    lawProgramSha256: await fileHash("src/game/lawProgram.ts"),
    localPlannerSha256: await fileHash("src/game/localPlanner.ts"),
    lawInterpreterSha256: await fileHash("src/game/lawInterpreter.ts"),
    starterScenarioSha256: await fileHash("src/game/starterScenario.ts"),
    catalogSha256: await fileHash("src/game/catalog.ts"),
    marketSha256: await fileHash("src/game/market.ts"),
    engineSha256: await fileHash("src/game/engine.ts"),
  },
  wallClockMs: Math.round(performance.now() - startedAt),
  runs,
  summary: {
    stage10Reached: runs.filter((run) => run.stage10Ramp.reached).length,
    stage10Stable: runs.filter((run) => run.stage10.passed && run.stage10.nextItemEvidence?.craftedDuringObservation === 0).length,
    blueprintsPurchased: runs.filter((run) => run.blueprintResults.every((entry) => entry.ok)).length,
    stage15Reached: runs.filter((run) => run.stage15Ramp.reached).length,
    stage15Stable: runs.filter((run) => run.stage15.passed && run.stage15.nextItemEvidence?.craftedDuringObservation === 0).length,
  },
};

await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, wallClockMs: result.wallClockMs, ...result.summary })}\n`);
