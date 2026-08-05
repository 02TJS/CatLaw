import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ITEMS, MARKET_CHALLENGE_RECIPE_IDS, RECIPES } from "../src/game/catalog";
import { effectiveRecipeInputs } from "../src/game/difficulty";
import { advanceGame, createInitialState, itemPrice, unlockRecipe } from "../src/game/engine";
import { SHARED_BEHAVIOR_HASH, SHARED_BEHAVIOR_SOURCE } from "../src/game/lawProgram";
import { buyingPowerCents } from "../src/game/market";
import type { GameState, ItemId } from "../src/game/types";

const SIMULATION_SPEED = 5_000;
const ACTION_LOGICAL_MS = 5_000;
const RAMP_LIMIT_LOGICAL_MS = 1_800_000;

function argument(name: string, fallback: string): string {
  return process.argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

const seedStart = Number(argument("--seed-start", "1"));
const seedCount = Number(argument("--seed-count", "5"));
const maxWindowLogicalMs = Number(argument("--max-window-ms", "600000"));
const outputPath = argument("--output", `output/regenerative-cycles-${seedStart}-${seedCount}.json`);
const physicalProofPath = argument("--physical-proof", "output/cycle-complexity-proof.json");

if (!Number.isInteger(seedStart) || seedStart <= 0 || !Number.isInteger(seedCount) || seedCount <= 0) {
  throw new Error("seed range must contain positive integers");
}
if (!Number.isInteger(maxWindowLogicalMs) || maxWindowLogicalMs <= 0 || maxWindowLogicalMs % ACTION_LOGICAL_MS !== 0) {
  throw new Error("max window must be a positive multiple of one logical action");
}

type Snapshot = {
  logicalMs: number;
  crafted: Record<ItemId, number>;
  passed: Record<ItemId, number>;
  sold: Record<ItemId, number>;
  stock: Record<ItemId, number>;
  totalDebtCents: number;
  totalPurchasingPowerCents: number;
  openOrderIds: string[];
  openContracts: Array<{ id: string; currentLeg: number }>;
  activePlans: Array<{ id: string; itemId: ItemId }>;
  claimedBounties: Array<{ key: string; itemId: ItemId }>;
  lawbookRevision: number;
  activeLawIds: string[];
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
  const priceOf = (itemId: ItemId) => itemPrice(state, itemId);
  return {
    logicalMs: logicalNow(state),
    crafted: Object.fromEntries(ITEMS.map((item) => [item.id, state.itemStats[item.id].crafted])) as Record<ItemId, number>,
    passed: Object.fromEntries(ITEMS.map((item) => [item.id, state.itemStats[item.id].passed])) as Record<ItemId, number>,
    sold: Object.fromEntries(ITEMS.map((item) => [item.id, state.itemStats[item.id].sold])) as Record<ItemId, number>,
    stock: aggregateStock(state),
    totalDebtCents: state.cats.reduce((sum, cat) => sum + cat.debtCents, 0),
    totalPurchasingPowerCents: state.cats.reduce((sum, cat) => sum + buyingPowerCents(state, cat, priceOf), 0),
    openOrderIds: state.demandOrders.filter((order) => order.status === "open").map((order) => order.id),
    openContracts: state.shipmentContracts.filter((contract) => contract.status !== "delivered")
      .map((contract) => ({ id: contract.id, currentLeg: contract.currentLeg })),
    activePlans: state.procurementPlans.filter((plan) => plan.status === "active")
      .map((plan) => ({ id: plan.id, itemId: plan.outputItemId })),
    claimedBounties: state.discoveryBounties.filter((bounty) => !bounty.paid && bounty.claimedByCatId)
      .map((bounty) => ({ key: `${bounty.itemId}:${bounty.claimedByCatId}`, itemId: bounty.itemId })),
    lawbookRevision: state.lawbookRevision,
    activeLawIds: state.laws.filter((law) => law.status === "active").map((law) => law.id),
  };
}

function advanceLogical(state: GameState, logicalMs: number): void {
  advanceGame(state, logicalMs / state.simulationSpeed);
}

function runUntil(state: GameState, predicate: () => boolean): { reached: boolean; logicalElapsedMs: number } {
  const start = logicalNow(state);
  while (!predicate() && logicalNow(state) - start < RAMP_LIMIT_LOGICAL_MS) {
    advanceLogical(state, Math.min(30_000, RAMP_LIMIT_LOGICAL_MS - (logicalNow(state) - start)));
  }
  return { reached: predicate(), logicalElapsedMs: logicalNow(state) - start };
}

function craftedThrough(state: GameState, through: number): boolean {
  return RECIPES.slice(0, through).every((recipe) => state.itemStats[recipe.output].crafted > 0);
}

function actionCountDifference(start: Snapshot, end: Snapshot): number {
  return ITEMS.reduce((sum, item) => sum
    + end.crafted[item.id] - start.crafted[item.id]
    + end.passed[item.id] - start.passed[item.id]
    + end.sold[item.id] - start.sold[item.id], 0);
}

function evaluateCertificate(samples: Snapshot[], through: number, windowSlots: number) {
  const start = samples[0];
  const windows = [samples[windowSlots], samples[windowSlots * 2], samples[windowSlots * 3]];
  const points = [start, ...windows];
  const itemEvidence = RECIPES.slice(0, through).map((recipe) => {
    const windowCrafts = windows.map((entry, index) => entry.crafted[recipe.output] - points[index].crafted[recipe.output]);
    const crafted = windowCrafts.reduce((sum, value) => sum + value, 0);
    return {
      itemId: recipe.output,
      windowCrafts,
      crafted,
      activeWindows: windowCrafts.filter((value) => value > 0).length,
      passed: crafted >= 3 && windowCrafts.filter((value) => value > 0).length >= 2 && windowCrafts[2] > 0,
    };
  });
  const totals = windows.map((entry, index) => RECIPES.slice(0, through).reduce((sum, recipe) => (
    sum + entry.crafted[recipe.output] - points[index].crafted[recipe.output]
  ), 0));
  const twoMajorDeclines = totals[1] < totals[0] * 0.5 && totals[2] < totals[1] * 0.5;
  const produced = Object.fromEntries(ITEMS.map((item) => [item.id, windows[2].crafted[item.id] - start.crafted[item.id]])) as Record<ItemId, number>;
  const consumed = Object.fromEntries(ITEMS.map((item) => [item.id, 0])) as Record<ItemId, number>;
  for (const recipe of RECIPES.slice(0, through)) {
    for (const input of effectiveRecipeInputs(recipe, 5)) consumed[input.itemId] += produced[recipe.output] * input.quantity;
  }
  const stockFailures = ITEMS.filter((item) => consumed[item.id] > 0 && windows[2].stock[item.id] < start.stock[item.id])
    .map((item) => ({
      itemId: item.id,
      start: start.stock[item.id],
      end: windows[2].stock[item.id],
      produced: produced[item.id],
      consumed: consumed[item.id],
    }));
  const end = windows[2];
  const endContracts = new Map(end.openContracts.map((contract) => [contract.id, contract.currentLeg]));
  const frozenContracts = start.openContracts.filter((contract) => endContracts.get(contract.id) === contract.currentLeg).map((entry) => entry.id);
  const endPlans = new Set(end.activePlans.map((plan) => plan.id));
  const frozenPlans = start.activePlans.filter((plan) => endPlans.has(plan.id) && produced[plan.itemId] === 0).map((entry) => entry.id);
  const endBounties = new Set(end.claimedBounties.map((bounty) => bounty.key));
  const frozenBounties = start.claimedBounties.filter((bounty) => endBounties.has(bounty.key) && produced[bounty.itemId] === 0)
    .map((entry) => entry.key);
  const retainedOrders = start.openOrderIds.filter((orderId) => end.openOrderIds.includes(orderId));
  const economy = {
    debtNonIncreasing: end.totalDebtCents <= start.totalDebtCents,
    purchasingPowerNonDecreasing: end.totalPurchasingPowerCents >= start.totalPurchasingPowerCents,
    queueCountsNonIncreasing: end.openOrderIds.length <= start.openOrderIds.length
      && end.openContracts.length <= start.openContracts.length
      && end.activePlans.length <= start.activePlans.length,
    retainedOrders,
    frozenContracts,
    frozenPlans,
    frozenBounties,
    windowDebtCents: points.map((entry) => entry.totalDebtCents),
    windowPurchasingPowerCents: points.map((entry) => entry.totalPurchasingPowerCents),
    windowQueueCounts: points.map((entry) => ({
      orders: entry.openOrderIds.length,
      contracts: entry.openContracts.length,
      plans: entry.activePlans.length,
      bounties: entry.claimedBounties.length,
    })),
  };
  const lawbookUnchanged = end.lawbookRevision === start.lawbookRevision
    && JSON.stringify(end.activeLawIds) === JSON.stringify(start.activeLawIds);
  const failureReasons: string[] = [];
  if (itemEvidence.some((item) => !item.passed)) failureReasons.push("production-window");
  if (twoMajorDeclines) failureReasons.push("two-major-declines");
  if (stockFailures.length) failureReasons.push("inventory-drawdown");
  if (!economy.debtNonIncreasing) failureReasons.push("debt-increase");
  if (!economy.purchasingPowerNonDecreasing) failureReasons.push("purchasing-power-decrease");
  if (!economy.queueCountsNonIncreasing) failureReasons.push("queue-growth");
  if (retainedOrders.length || frozenContracts.length || frozenPlans.length || frozenBounties.length) failureReasons.push("frozen-economy-object");
  if (!lawbookUnchanged) failureReasons.push("lawbook-changed");
  return {
    passed: failureReasons.length === 0,
    failureReasons,
    itemEvidence,
    windowTargetCraftTotals: totals,
    stockFailures,
    economy,
    lawbookUnchanged,
    actualActions: actionCountDifference(start, end),
  };
}

function measureStage(
  stateAtObservationStart: GameState,
  through: number,
  fluidLowerBoundMs: number | null,
  exactDiscretePeriodMs: number | null,
) {
  const state = structuredClone(stateAtObservationStart);
  const samples = [snapshot(state)];
  const totalSlots = (maxWindowLogicalMs * 3) / ACTION_LOGICAL_MS;
  for (let slot = 0; slot < totalSlots; slot += 1) {
    advanceLogical(state, ACTION_LOGICAL_MS);
    samples.push(snapshot(state));
  }
  const certifiedLowerBoundMs = exactDiscretePeriodMs ?? fluidLowerBoundMs;
  const firstSlot = Math.max(1, certifiedLowerBoundMs ? Math.ceil(certifiedLowerBoundMs / ACTION_LOGICAL_MS) : 1);
  let accepted: ReturnType<typeof evaluateCertificate> | null = null;
  let acceptedWindowMs: number | null = null;
  let last = evaluateCertificate(samples, through, Math.floor(totalSlots / 3));
  for (let windowSlots = firstSlot; windowSlots <= totalSlots / 3; windowSlots += 1) {
    const evaluated = evaluateCertificate(samples, through, windowSlots);
    last = evaluated;
    if (evaluated.passed) {
      accepted = evaluated;
      acceptedWindowMs = windowSlots * ACTION_LOGICAL_MS;
      break;
    }
  }
  return {
    targetThrough: through,
    fluidLowerBoundMs,
    exactDiscretePeriodMs,
    certifiedLowerBoundMs,
    searchedWindowMs: { min: firstSlot * ACTION_LOGICAL_MS, max: maxWindowLogicalMs, step: ACTION_LOGICAL_MS },
    found: Boolean(accepted),
    actualWindowMs: acceptedWindowMs,
    coordinationMultiplier: accepted && acceptedWindowMs && exactDiscretePeriodMs
      ? acceptedWindowMs / exactDiscretePeriodMs
      : null,
    fluidRelaxationRatio: accepted && acceptedWindowMs && fluidLowerBoundMs
      ? acceptedWindowMs / fluidLowerBoundMs
      : null,
    certificate: accepted,
    terminalFailure: accepted ? null : last,
  };
}

const physicalProof = JSON.parse(await readFile(physicalProofPath, "utf8")) as {
  spatialCycleLp: { certificates: Array<{ seed: number; stage: number; omniscientWindowLowerBoundMs: number; totalPhysicalActionsPerBasket: number }> };
  integerRegenerativePeriodMilp?: {
    certificates: Array<{ seed: number; stage: number; exactDiscretePeriodMs: number; totalPhysicalActionsPerBasket: number }>;
  };
};
const physicalBySeedStage = new Map(physicalProof.spatialCycleLp.certificates.map((entry) => [`${entry.seed}:${entry.stage}`, entry]));
const exactBySeedStage = new Map(
  (physicalProof.integerRegenerativePeriodMilp?.certificates ?? []).map((entry) => [`${entry.seed}:${entry.stage}`, entry]),
);
const startedAt = performance.now();
const runs = [];
for (let seed = seedStart; seed < seedStart + seedCount; seed += 1) {
  const initial = createInitialState({ worldSeed: seed, difficulty: 5, simulationSpeed: SIMULATION_SPEED });
  const stage10Ramp = runUntil(initial, () => craftedThrough(initial, 10));
  const stage10Start = structuredClone(initial);
  const stage10Physical = physicalBySeedStage.get(`${seed}:10`) ?? null;
  const stage10Exact = exactBySeedStage.get(`${seed}:10`) ?? null;
  const stage10 = stage10Ramp.reached ? measureStage(
    stage10Start,
    10,
    stage10Physical?.omniscientWindowLowerBoundMs ?? null,
    stage10Exact?.exactDiscretePeriodMs ?? null,
  ) : null;

  const stage15State = structuredClone(stage10Start);
  const blueprintResults = MARKET_CHALLENGE_RECIPE_IDS.map((recipeId) => ({ recipeId, ...unlockRecipe(stage15State, recipeId) }));
  const stage15Ramp = runUntil(stage15State, () => craftedThrough(stage15State, 15));
  const stage15Physical = physicalBySeedStage.get(`${seed}:15`) ?? null;
  const stage15Exact = exactBySeedStage.get(`${seed}:15`) ?? null;
  const stage15 = stage15Ramp.reached ? measureStage(
    stage15State,
    15,
    stage15Physical?.omniscientWindowLowerBoundMs ?? null,
    stage15Exact?.exactDiscretePeriodMs ?? null,
  ) : null;
  runs.push({ seed, stage10Ramp, stage10, blueprintResults, stage15Ramp, stage15 });
}

async function sourceHash(relativePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(relativePath)).digest("hex");
}

const result = {
  schema: "cat-workshop-regenerative-cycle-measurement-v1",
  generatedAt: new Date().toISOString(),
  configuration: {
    seedRange: { start: seedStart, count: seedCount },
    simulationSpeed: SIMULATION_SPEED,
    actionLogicalMs: ACTION_LOGICAL_MS,
    maxWindowLogicalMs,
    candidateWindowStepMs: ACTION_LOGICAL_MS,
    observationOperations: "frozen; stage 15 buys blueprints 11-15 before ramp only",
    inventoryRule: "all consumed aggregate stocks end >= start",
    economyRule: "debt and queue counts non-increasing, purchasing power non-decreasing, no unchanged start object",
    periodRule: "exact discrete P* is used when an integer MILP certificate exists; otherwise the continuous LP remains only a lower bound",
  },
  authority: {
    sharedBehaviorHash: SHARED_BEHAVIOR_HASH,
    sharedBehaviorSource: SHARED_BEHAVIOR_SOURCE,
    lawProgramSha256: await sourceHash("src/game/lawProgram.ts"),
    catalogSha256: await sourceHash("src/game/catalog.ts"),
    marketSha256: await sourceHash("src/game/market.ts"),
    engineSha256: await sourceHash("src/game/engine.ts"),
    physicalProofPath,
    physicalProofSha256: await sourceHash(physicalProofPath),
  },
  runs,
  summary: {
    stage10Ramped: runs.filter((run) => run.stage10Ramp.reached).length,
    stage10Regenerative: runs.filter((run) => run.stage10?.found).length,
    stage15Ramped: runs.filter((run) => run.stage15Ramp.reached).length,
    stage15Regenerative: runs.filter((run) => run.stage15?.found).length,
  },
  compute: { wallClockMs: Math.round(performance.now() - startedAt) },
};

await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, ...result.summary, wallClockMs: result.compute.wallClockMs })}\n`);
