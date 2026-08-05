import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canUnlockRecipe, DEPLOYABLE_BUILDING_IDS, ITEMS, RECIPES } from "../src/game/catalog";
import { effectiveRecipeInputs } from "../src/game/difficulty";
import { buildingPlacementFailure, catStockPurchaseQuote, createInitialState, itemPrice, warehouseSellPrice } from "../src/game/engine";
import { decisionCapabilities, SHARED_BEHAVIOR_HASH, SHARED_BEHAVIOR_SOURCE } from "../src/game/lawProgram";
import { hashSource } from "../src/game/lawInterpreter";
import { creditAvailableCents, productionOpportunitiesForCat, productionOpportunityDiagnosticForCat } from "../src/game/market";
import { resourceItemsAt } from "../src/game/logistics";
import { createAuditedPlayerFacade } from "../src/game/playerFacade";
import type { GameState, LawDraft, Position } from "../src/game/types";
import { DEEPSEEK_ACCEPTANCE_CASES, priceCalls } from "./deepseek-to-35-cases.mjs";
import { fixtureDrafts } from "./deepseek-to-35-fixtures.mjs";

const SIMULATION_SPEED = 5_000;
const STEP_SIMULATED_MS = 30_000;
const logisticsLimitArg = process.argv.find((argument) => argument.startsWith("--logistics-ms="));
const LOGISTICS_LIMIT_MS = logisticsLimitArg ? Number(logisticsLimitArg.slice("--logistics-ms=".length)) : 2_400_000;
const item22LimitArg = process.argv.find((argument) => argument.startsWith("--item22-ms="));
const ITEM22_LIMIT_MS = item22LimitArg ? Number(item22LimitArg.slice("--item22-ms=".length)) : 2_400_000;
const STOP_AT_22 = process.argv.includes("--stop-at-22");
const outputArg = process.argv.find((argument) => argument.startsWith("--output="));
const REPORT_OUTPUT_PATH = outputArg ? outputArg.slice("--output=".length) : "output/deepseek-to-35-headless.json";
const stability22Arg = process.argv.find((argument) => argument.startsWith("--stability-22-ms="));
const STABILITY_22_MS = stability22Arg ? Number(stability22Arg.slice("--stability-22-ms=".length)) : 5_400_000;
const stability30Arg = process.argv.find((argument) => argument.startsWith("--stability-30-ms="));
const STABILITY_30_MS = stability30Arg ? Number(stability30Arg.slice("--stability-30-ms=".length)) : 5_400_000;
const ramp30Arg = process.argv.find((argument) => argument.startsWith("--ramp-30-ms="));
const RAMP_30_MS = ramp30Arg ? Number(ramp30Arg.slice("--ramp-30-ms=".length)) : 3_600_000;
const INDUSTRIAL_BUILDINGS = ["factory", "machine_tool", "antenna"] as const;
const ALLOWED_PLAYER_COMMANDS = new Set([
  "buy-recipe", "buy-cat-stock", "buy-building", "place-building", "sell-warehouse",
  "compile-law", "enact-law", "reorder-law", "repeal-law", "advance-time",
]);

type IndustrialBuildingId = typeof INDUSTRIAL_BUILDINGS[number];

interface StageRecord {
  name: string;
  seed: number;
  simulatedStartMs: number;
  simulatedEndMs: number;
  simulatedElapsedMs: number;
  wallClockMs: number;
  treasuryStartCents: number;
  treasuryEndCents: number;
  craftedThroughStart: number;
  craftedThroughEnd: number;
  missing: string[];
  auditSequenceStart: number;
  auditSequenceEnd: number;
  timing: TimeConversion;
  stability?: StabilityResult;
  passed: boolean;
  detail?: unknown;
}

interface TimeConversion {
  logicalSimulatedMs: number;
  engineClockAdvancedMs: number;
  theoreticalRealtimeAt1xMs: number;
  configuredEngineAcceleration: number;
  measuredWallClockMs: number;
  effectiveWallClockAcceleration: number | null;
  formula: string;
}

interface StabilitySnapshot {
  simulatedMs: number;
  crafted: Record<string, number>;
  aggregateStock: Record<string, number>;
  commandSequence: number;
  lawbookRevision: number;
  activeLawIds: string[];
  openOrders: ReturnType<typeof orderAndCreditGaps>;
  openContracts: Array<{ id: string; itemId: string; currentLeg: number; status: string; acceptedAtSimulatedMs: number }>;
  claimedBounties: Array<{ itemId: string; claimedByCatId: string }>;
  activePlans: Array<{ id: string; catId: string; itemId: string; reason: string }>;
}

interface StabilityItemEvidence {
  index: number;
  itemId: string;
  totalCraftedBefore: number;
  totalCraftedAfter: number;
  craftedDuringObservation: number;
  windowCrafts: number[];
  activeWindows: number;
  demandProbeUnits: number;
  requiredCrafts: number;
  requiredActiveWindows: number;
  classification: "not-produced" | "first-crafted" | "repeated" | "stable";
  stable: boolean;
}

interface StabilityResult {
  targetThrough: number;
  observationSimulatedMs: number;
  windowSimulatedMs: number;
  minimumCraftsPerItem: number;
  minimumActiveWindowsPerItem: number;
  timing: TimeConversion;
  stableThrough: number;
  passed: boolean;
  lastWindowActive: boolean;
  twoConsecutiveMajorDeclines: boolean;
  windowTargetCraftTotals: number[];
  itemEvidence: StabilityItemEvidence[];
  nextItemEvidence: StabilityItemEvidence | null;
  materialCoverage: Array<{
    itemId: string;
    crafted: number;
    consumed: number;
    stockStart: number;
    stockEnd: number;
    stockByWindow: number[];
    stockChange: number;
    uncoveredConsumption: number;
    passed: boolean;
  }>;
  frozenEconomy: {
    creditBlockedOrders: StabilitySnapshot["openOrders"];
    stalledContracts: StabilitySnapshot["openContracts"];
    claimedUnpaidBounties: StabilitySnapshot["claimedBounties"];
    stalledPlans: StabilitySnapshot["activePlans"];
  };
  forbiddenPlayerCommands: GameState["commandAudit"];
  lawbookUnchanged: boolean;
  failureReasons: string[];
}

const STABILITY_POLICY = {
  windows: 3,
  minimumCraftsPerItem: 3,
  minimumActiveWindowsPerItem: 2,
  observationMs: { 10: 900_000, 15: 900_000, 19: 2_700_000, 20: 600_000, 22: STABILITY_22_MS, 30: STABILITY_30_MS, 35: 5_400_000 } as Record<number, number>,
};

const simulatedNow = (state: GameState) => Math.round(state.simTime * state.simulationSpeed);
const craftedThrough = (state: GameState) => {
  let count = 0;
  for (const recipe of RECIPES) {
    if (state.itemStats[recipe.output].crafted <= 0) break;
    count += 1;
  }
  return count;
};
const missingThrough = (state: GameState, count: number) => RECIPES.slice(0, count)
  .filter((recipe) => state.itemStats[recipe.output].crafted <= 0)
  .map((recipe) => recipe.output);

function timeConversion(logicalSimulatedMs: number, wallClockMs: number, simulationSpeed = SIMULATION_SPEED): TimeConversion {
  return {
    logicalSimulatedMs,
    engineClockAdvancedMs: logicalSimulatedMs / simulationSpeed,
    theoreticalRealtimeAt1xMs: logicalSimulatedMs,
    configuredEngineAcceleration: simulationSpeed,
    measuredWallClockMs: wallClockMs,
    effectiveWallClockAcceleration: wallClockMs > 0 ? Number((logicalSimulatedMs / wallClockMs).toFixed(2)) : null,
    formula: "engineClock=logicalSimulated/configuredAcceleration; effectiveWallAcceleration=logicalSimulated/measuredWallClock",
  };
}

function aggregateStock(state: GameState): Record<string, number> {
  const stock = Object.fromEntries(ITEMS.map((item) => [item.id, 0]));
  const add = (itemId: string, quantity: number) => {
    if (quantity > 0) stock[itemId] = (stock[itemId] ?? 0) + quantity;
  };
  for (const cat of state.cats) {
    for (const [itemId, quantity] of Object.entries(cat.inventory)) add(itemId, quantity);
    if (cat.action?.type === "craft") {
      for (const [itemId, quantity] of Object.entries(cat.action.reserved)) add(itemId, quantity);
    }
  }
  for (const [itemId, quantity] of Object.entries(state.playerBuildingInventory)) add(itemId, quantity);
  for (const contract of state.shipmentContracts) if (contract.status !== "delivered") add(contract.itemId, 1);
  return stock;
}

function captureStabilitySnapshot(state: GameState): StabilitySnapshot {
  return {
    simulatedMs: simulatedNow(state),
    crafted: Object.fromEntries(ITEMS.map((item) => [item.id, state.itemStats[item.id].crafted])),
    aggregateStock: aggregateStock(state),
    commandSequence: state.commandAudit.at(-1)?.sequence ?? 0,
    lawbookRevision: state.lawbookRevision,
    activeLawIds: state.laws.filter((law) => law.status === "active").map((law) => law.id),
    openOrders: orderAndCreditGaps(state),
    openContracts: state.shipmentContracts.filter((contract) => contract.status !== "delivered").map((contract) => ({
      id: contract.id,
      itemId: contract.itemId,
      currentLeg: contract.currentLeg,
      status: contract.status,
      acceptedAtSimulatedMs: Math.round(contract.acceptedAt * state.simulationSpeed),
    })),
    claimedBounties: state.discoveryBounties.filter((bounty): bounty is typeof bounty & { claimedByCatId: string } => (
      !bounty.paid && bounty.claimedByCatId !== null
    )).map((bounty) => ({ itemId: bounty.itemId, claimedByCatId: bounty.claimedByCatId })),
    activePlans: state.procurementPlans.filter((plan) => plan.status === "active").map((plan) => ({
      id: plan.id,
      catId: plan.catId,
      itemId: plan.outputItemId,
      reason: plan.reason,
    })),
  };
}

function evaluateStability(
  state: GameState,
  through: number,
  snapshots: StabilitySnapshot[],
  wallClockMs: number,
): StabilityResult {
  if (snapshots.length !== STABILITY_POLICY.windows + 1) throw new Error("稳态观察必须包含起点和三个窗口快照");
  const start = snapshots[0];
  const end = snapshots.at(-1)!;
  const observationSimulatedMs = end.simulatedMs - start.simulatedMs;
  const windowCraftsFor = (itemId: string) => snapshots.slice(1).map((snapshot, index) => (
    snapshot.crafted[itemId] - snapshots[index].crafted[itemId]
  ));
  const classifiedEvidence = RECIPES.slice(0, Math.min(RECIPES.length, through + 1)).map((recipe, index) => {
    const windowCrafts = windowCraftsFor(recipe.output);
    const craftedDuringObservation = windowCrafts.reduce((sum, value) => sum + value, 0);
    const activeWindows = windowCrafts.filter((value) => value > 0).length;
    const requiredCrafts = STABILITY_POLICY.minimumCraftsPerItem;
    const requiredActiveWindows = STABILITY_POLICY.minimumActiveWindowsPerItem;
    const repeated = craftedDuringObservation >= requiredCrafts;
    const stable = repeated && activeWindows >= requiredActiveWindows;
    const classification = stable ? "stable"
      : repeated ? "repeated"
        : end.crafted[recipe.output] > 0 ? "first-crafted"
          : "not-produced";
    return {
      index: index + 1,
      itemId: recipe.output,
      totalCraftedBefore: start.crafted[recipe.output],
      totalCraftedAfter: end.crafted[recipe.output],
      craftedDuringObservation,
      windowCrafts,
      activeWindows,
      demandProbeUnits: 0,
      requiredCrafts,
      requiredActiveWindows,
      classification,
      stable,
    } as StabilityItemEvidence;
  });
  const itemEvidence = classifiedEvidence.slice(0, through);
  const nextItemEvidence = classifiedEvidence[through] ?? null;
  let stableThrough = 0;
  for (const item of itemEvidence) {
    if (!item.stable) break;
    stableThrough += 1;
  }
  const windowTargetCraftTotals = snapshots.slice(1).map((snapshot, windowIndex) => RECIPES.slice(0, through).reduce((sum, recipe) => (
    sum + snapshot.crafted[recipe.output] - snapshots[windowIndex].crafted[recipe.output]
  ), 0));
  const majorDeclines = windowTargetCraftTotals.slice(1).map((value, index) => value < windowTargetCraftTotals[index] * 0.5);
  const twoConsecutiveMajorDeclines = majorDeclines.length >= 2 && majorDeclines[0] && majorDeclines[1];
  const lastWindowActive = (windowTargetCraftTotals.at(-1) ?? 0) > 0;

  const totalProduced = Object.fromEntries(ITEMS.map((item) => [item.id, end.crafted[item.id] - start.crafted[item.id]]));
  const totalConsumed = Object.fromEntries(ITEMS.map((item) => [item.id, 0]));
  for (const recipe of RECIPES) {
    const completed = totalProduced[recipe.output] ?? 0;
    if (completed <= 0) continue;
    for (const input of effectiveRecipeInputs(recipe, state.difficulty)) {
      totalConsumed[input.itemId] = (totalConsumed[input.itemId] ?? 0) + completed * input.quantity;
    }
  }
  const materialCoverage = ITEMS.flatMap((item) => {
    const consumed = totalConsumed[item.id] ?? 0;
    if (consumed <= 0) return [];
    const crafted = totalProduced[item.id] ?? 0;
    const stockStart = start.aggregateStock[item.id] ?? 0;
    const stockEnd = end.aggregateStock[item.id] ?? 0;
    const stockByWindow = snapshots.map((snapshot) => snapshot.aggregateStock[item.id] ?? 0);
    const stockChange = stockEnd - stockStart;
    const uncoveredConsumption = Math.max(0, consumed - crafted);
    const materialDrawdownThreshold = Math.max(3, Math.ceil(stockStart * 0.2));
    return [{
      itemId: item.id,
      crafted,
      consumed,
      stockStart,
      stockEnd,
      stockByWindow,
      stockChange,
      uncoveredConsumption,
      passed: !(stockChange <= -materialDrawdownThreshold && uncoveredConsumption > 0),
    }];
  });

  const startOrders = new Set(start.openOrders.map((order) => order.orderId));
  const creditBlockedOrders = end.openOrders.filter((order) => startOrders.has(order.orderId) && order.creditGapCents > 0);
  const startContracts = new Map(start.openContracts.map((contract) => [contract.id, contract]));
  const stalledContracts = end.openContracts.filter((contract) => {
    const previous = startContracts.get(contract.id);
    return previous && previous.currentLeg === contract.currentLeg;
  });
  const startBounties = new Set(start.claimedBounties.map((bounty) => `${bounty.itemId}:${bounty.claimedByCatId}`));
  const claimedUnpaidBounties = end.claimedBounties.filter((bounty) => (
    startBounties.has(`${bounty.itemId}:${bounty.claimedByCatId}`)
      && (end.crafted[bounty.itemId] - start.crafted[bounty.itemId]) === 0
  ));
  const startPlans = new Set(start.activePlans.map((plan) => plan.id));
  const stalledPlans = end.activePlans.filter((plan) => startPlans.has(plan.id)
    && (end.crafted[plan.itemId] - start.crafted[plan.itemId]) === 0);
  const forbiddenPlayerCommands = state.commandAudit.filter((entry) => (
    entry.origin === "player-ui"
      && entry.sequence > start.commandSequence
      && entry.sequence <= end.commandSequence
      && entry.kind !== "advance-time"
  ));
  const lawbookUnchanged = start.lawbookRevision === end.lawbookRevision
    && JSON.stringify(start.activeLawIds) === JSON.stringify(end.activeLawIds);
  const failureReasons: string[] = [];
  const unstableItems = itemEvidence.filter((item) => !item.stable).map((item) => item.itemId);
  if (unstableItems.length) failureReasons.push(`未稳定制作：${unstableItems.join(",")}`);
  if (!lastWindowActive) failureReasons.push("最后窗口没有目标商品产出");
  if (twoConsecutiveMajorDeclines) failureReasons.push("目标总产量连续两个窗口下降超过50%");
  const uncoveredMaterials = materialCoverage.filter((entry) => !entry.passed).map((entry) => entry.itemId);
  if (uncoveredMaterials.length) failureReasons.push(`以历史库存覆盖消耗：${uncoveredMaterials.join(",")}`);
  if (creditBlockedOrders.length) failureReasons.push(`信用缺口订单长期未解：${creditBlockedOrders.map((entry) => entry.itemId).join(",")}`);
  if (stalledContracts.length) failureReasons.push(`运输合同跨完整观察期无进展：${stalledContracts.map((entry) => entry.itemId).join(",")}`);
  if (claimedUnpaidBounties.length) failureReasons.push(`已认领悬赏跨完整观察期无产出：${claimedUnpaidBounties.map((entry) => entry.itemId).join(",")}`);
  if (stalledPlans.length) failureReasons.push(`生产计划跨完整观察期无产出：${stalledPlans.map((entry) => entry.itemId).join(",")}`);
  if (forbiddenPlayerCommands.length) failureReasons.push("稳态观察期发生了交易、立法或建筑等玩家操作");
  if (!lawbookUnchanged) failureReasons.push("稳态观察期法典发生变化");
  return {
    targetThrough: through,
    observationSimulatedMs,
    windowSimulatedMs: observationSimulatedMs / STABILITY_POLICY.windows,
    minimumCraftsPerItem: STABILITY_POLICY.minimumCraftsPerItem,
    minimumActiveWindowsPerItem: STABILITY_POLICY.minimumActiveWindowsPerItem,
    timing: timeConversion(observationSimulatedMs, wallClockMs, state.simulationSpeed),
    stableThrough,
    passed: failureReasons.length === 0,
    lastWindowActive,
    twoConsecutiveMajorDeclines,
    windowTargetCraftTotals,
    itemEvidence,
    nextItemEvidence,
    materialCoverage,
    frozenEconomy: { creditBlockedOrders, stalledContracts, claimedUnpaidBounties, stalledPlans },
    forbiddenPlayerCommands,
    lawbookUnchanged,
    failureReasons,
  };
}

async function loadDrafts(): Promise<{ mode: "live" | "fixture"; drafts: Record<string, LawDraft>; liveAudit?: unknown }> {
  if (process.argv.includes("--fixture")) return { mode: "fixture", drafts: fixtureDrafts() };
  const liveAudit = JSON.parse(await readFile("output/deepseek-to-35-live.json", "utf8")) as {
    passed?: boolean;
    results?: Array<{ id: string; parsedDraft?: LawDraft; passed?: boolean }>;
  };
  if (!liveAudit.passed) throw new Error("实时DeepSeek编译审计未通过，不能进入进度验收");
  const drafts = Object.fromEntries((liveAudit.results ?? []).flatMap((result) => (
    result.passed && result.parsedDraft ? [[result.id, result.parsedDraft]] : []
  )));
  for (const testCase of DEEPSEEK_ACCEPTANCE_CASES) if (!drafts[testCase.id]) throw new Error(`缺少实时法规 ${testCase.id}`);
  return { mode: "live", drafts, liveAudit };
}

function stage(state: GameState, seed: number, name: string, run: () => void, expectedThrough: number, detail?: () => unknown): StageRecord {
  const simulatedStartMs = simulatedNow(state);
  const treasuryStartCents = state.treasuryCoins;
  const craftedThroughStart = craftedThrough(state);
  const auditSequenceStart = state.commandAudit.at(-1)?.sequence ?? 0;
  const wallStarted = performance.now();
  run();
  const simulatedElapsedMs = simulatedNow(state) - simulatedStartMs;
  const wallClockMs = Math.round(performance.now() - wallStarted);
  const record: StageRecord = {
    name,
    seed,
    simulatedStartMs,
    simulatedEndMs: simulatedNow(state),
    simulatedElapsedMs,
    wallClockMs,
    treasuryStartCents,
    treasuryEndCents: state.treasuryCoins,
    craftedThroughStart,
    craftedThroughEnd: craftedThrough(state),
    missing: missingThrough(state, expectedThrough),
    auditSequenceStart,
    auditSequenceEnd: state.commandAudit.at(-1)?.sequence ?? 0,
    timing: timeConversion(simulatedElapsedMs, wallClockMs, state.simulationSpeed),
    passed: missingThrough(state, expectedThrough).length === 0,
    detail: detail?.(),
  };
  return record;
}

function advanceSimulated(state: GameState, player: ReturnType<typeof createAuditedPlayerFacade>, simulatedMs: number): void {
  player.advanceTime(simulatedMs / state.simulationSpeed);
}

function observeStability(
  state: GameState,
  player: ReturnType<typeof createAuditedPlayerFacade>,
  through: number,
  observationSimulatedMs = STABILITY_POLICY.observationMs[through],
): StabilityResult {
  if (!observationSimulatedMs || observationSimulatedMs % STABILITY_POLICY.windows !== 0) {
    throw new Error(`商品${through}的稳态观察时长必须能被${STABILITY_POLICY.windows}个窗口整除`);
  }
  const snapshots = [captureStabilitySnapshot(state)];
  const windowSimulatedMs = observationSimulatedMs / STABILITY_POLICY.windows;
  const wallStarted = performance.now();
  for (let windowIndex = 0; windowIndex < STABILITY_POLICY.windows; windowIndex += 1) {
    advanceSimulated(state, player, windowSimulatedMs);
    snapshots.push(captureStabilitySnapshot(state));
  }
  return evaluateStability(state, through, snapshots, Math.round(performance.now() - wallStarted));
}

function requireStable(
  state: GameState,
  player: ReturnType<typeof createAuditedPlayerFacade>,
  stages: StageRecord[],
  stageIndex: number,
  through: number,
): StabilityResult {
  const result = observeStability(state, player, through, STABILITY_POLICY.observationMs[through]);
  stages[stageIndex].stability = result;
  stages[stageIndex].passed = stages[stageIndex].passed && result.passed;
  stages[stageIndex].simulatedEndMs = simulatedNow(state);
  stages[stageIndex].simulatedElapsedMs = stages[stageIndex].simulatedEndMs - stages[stageIndex].simulatedStartMs;
  stages[stageIndex].wallClockMs += result.timing.measuredWallClockMs;
  stages[stageIndex].timing = timeConversion(stages[stageIndex].simulatedElapsedMs, stages[stageIndex].wallClockMs, state.simulationSpeed);
  stages[stageIndex].treasuryEndCents = state.treasuryCoins;
  stages[stageIndex].auditSequenceEnd = state.commandAudit.at(-1)?.sequence ?? 0;
  const stalledPlanDiagnostics = result.frozenEconomy.stalledPlans.map((stalled) => {
    const plan = state.procurementPlans.find((entry) => entry.id === stalled.id);
    const cat = state.cats.find((entry) => entry.id === stalled.catId);
    const recipe = plan ? RECIPES.find((entry) => entry.id === plan.recipeId) : undefined;
    return {
      ...stalled,
      expectedRevenueCents: plan?.expectedRevenueCents ?? null,
      cat: cat ? {
        coins: cat.coins,
        debtCents: cat.debtCents,
        escrowReservedCents: cat.escrowReservedCents,
        creditAvailableCents: creditAvailableCents(state, cat, (itemId) => itemPrice(state, itemId)),
        inventory: cat.inventory,
        action: cat.action,
        lastDecision: cat.lastDecision,
        decisionTrace: cat.decisionTrace,
      } : null,
      inputs: recipe ? effectiveRecipeInputs(recipe, state.difficulty).map((input) => ({
        ...input,
        owned: cat?.inventory[input.itemId] ?? 0,
        orders: state.demandOrders.filter((order) => order.planId === plan?.id && order.itemId === input.itemId)
          .map((order) => ({
            id: order.id,
            status: order.status,
            maxDeliveredCents: order.maxDeliveredCents,
            reservedCents: order.reservedCents,
            closeReason: order.closeReason,
            producerPlans: state.procurementPlans.filter((producerPlan) => producerPlan.terminalOrderId === order.id)
              .map((producerPlan) => ({
                id: producerPlan.id,
                catId: producerPlan.catId,
                status: producerPlan.status,
                outputItemId: producerPlan.outputItemId,
                producerInventory: state.cats.find((entry) => entry.id === producerPlan.catId)?.inventory[input.itemId] ?? 0,
                producerAction: state.cats.find((entry) => entry.id === producerPlan.catId)?.action ?? null,
                producerDecisionTrace: state.cats.find((entry) => entry.id === producerPlan.catId)?.decisionTrace ?? [],
              })),
          })),
        inbound: state.shipmentContracts.filter((contract) => contract.buyerKind === "cat"
          && contract.buyerCatId === cat?.id && contract.itemId === input.itemId)
          .map((contract) => ({
            id: contract.id,
            status: contract.status,
            currentLeg: contract.currentLeg,
            routeCatIds: contract.routeCatIds,
          })),
      })) : [],
    };
  });
  const unstableOpportunityDiagnostics = result.itemEvidence.filter((item) => !item.stable).map((item) => ({
    itemId: item.itemId,
    cats: state.cats.map((cat) => {
      const diagnostic = productionOpportunityDiagnosticForCat(
        state,
        cat,
        (itemId) => itemPrice(state, itemId),
        item.itemId,
      );
      return {
        catId: cat.id,
        position: cat.position,
        buyingPowerCents: diagnostic.buyingPowerCents,
        requiredWorkingCapitalCents: diagnostic.requiredWorkingCapitalCents,
        inventoryNetAssetGainCents: diagnostic.inventoryOpportunity?.netAssetGainCents ?? null,
        inventoryAssetGainRate: diagnostic.inventoryOpportunity?.assetGainRate ?? null,
        rejectionReasons: diagnostic.rejectionReasons,
      };
    }),
  }));
  if (!result.passed) throw new Error(`seed ${stages[stageIndex].seed} 前${through}项未达到稳定制作：${JSON.stringify({
    failureReasons: result.failureReasons,
    itemEvidence: result.itemEvidence.filter((item) => !item.stable),
    materialCoverage: result.materialCoverage.filter((entry) => !entry.passed),
    frozenEconomy: result.frozenEconomy,
    stalledPlanDiagnostics,
    unstableOpportunityDiagnostics,
    activeLaws: state.laws.filter((law) => law.status === "active").map((law) => ({
      id: law.id,
      title: law.title,
      invalidCount: law.invalidCount,
      consecutiveFaults: law.consecutiveFaults,
      hitCount: law.hitCount,
    })),
    relevantCats: state.cats.filter((cat) => Math.abs(cat.position.x) === 1 && cat.position.y === -1).map((cat) => ({
      id: cat.id,
      position: cat.position,
      coins: cat.coins,
      debtCents: cat.debtCents,
      escrowReservedCents: cat.escrowReservedCents,
      inventory: cat.inventory,
      action: cat.action,
      lastDecision: cat.lastDecision,
      decisionTrace: cat.decisionTrace,
      activePlan: state.procurementPlans.find((plan) => plan.catId === cat.id && plan.status === "active") ?? null,
      carryingContracts: state.shipmentContracts.filter((contract) => contract.status !== "delivered"
        && contract.routeCatIds[contract.currentLeg] === cat.id),
    })),
    timing: result.timing,
  })}`);
  return result;
}

function tradeProfitableOrdinaryStock(state: GameState, player: ReturnType<typeof createAuditedPlayerFacade>, maxUnits = 200): number {
  const buildingIds = new Set<string>(DEPLOYABLE_BUILDING_IDS);
  let traded = 0;
  while (traded < maxUnits) {
    const line = catStockPurchaseQuote(state).lines
      .filter((entry) => !buildingIds.has(entry.itemId)
        && warehouseSellPrice(entry.itemId) > entry.unitPriceCents
        && entry.unitPriceCents <= state.treasuryCoins)
      .sort((left, right) => (warehouseSellPrice(right.itemId) - right.unitPriceCents)
        - (warehouseSellPrice(left.itemId) - left.unitPriceCents)
        || left.catId.localeCompare(right.catId)
        || left.itemId.localeCompare(right.itemId))[0];
    if (!line) break;
    const bought = player.buyCatItem(line.catId, line.itemId);
    if (!bought.ok) break;
    const sold = player.sellWarehouseItem(line.itemId, 1);
    if (!sold.ok) throw new Error(`玩家转卖 ${line.itemId} 失败：${sold.error}`);
    traded += 1;
  }
  return traded;
}

function prepareFrozenTerminalRotation(
  state: GameState,
  player: ReturnType<typeof createAuditedPlayerFacade>,
  maxSimulatedMs: number,
): {
  simulatedMs: number;
  targetCraftDelta: Record<string, number>;
  centralCashCents: number;
  publicPurchases: number;
  ordinaryTrades: number;
} {
  const targetIds = RECIPES.slice(22, 30).map((recipe) => recipe.output);
  const rotationCatIds = new Set(state.cats
    .filter((cat) => (
      (cat.position.x === -1 && (cat.position.y === -1 || cat.position.y === 1))
        || (cat.position.x === 0 && cat.position.y === 0)
        || (cat.position.x === 1 && cat.position.y === 1)
    ))
    .map((cat) => cat.id));
  const safeToLiquidate = new Set(["wheel", "fuel", "coolant", "antenna", "machine_tool", "display"]);
  const baseline = Object.fromEntries(targetIds.map((itemId) => [itemId, state.itemStats[itemId].crafted]));
  const startedAt = simulatedNow(state);
  const deadline = startedAt + maxSimulatedMs;
  let publicPurchases = 0;
  let ordinaryTrades = 0;
  while (simulatedNow(state) < deadline) {
    advanceSimulated(state, player, Math.min(STEP_SIMULATED_MS, deadline - simulatedNow(state)));
    ordinaryTrades += tradeProfitableOrdinaryStock(state, player, 100);
    const line = catStockPurchaseQuote(state).lines
      .filter((entry) => rotationCatIds.has(entry.catId)
        && safeToLiquidate.has(entry.itemId)
        && entry.unitPriceCents <= state.treasuryCoins)
      .sort((left, right) => left.itemId.localeCompare(right.itemId))[0];
    if (line) {
      const bought = player.buyCatItem(line.catId, line.itemId);
      if (bought.ok) {
        const sold = player.sellWarehouseItem(line.itemId, 1);
        if (!sold.ok) throw new Error(`terminal rotation resale failed ${line.itemId}: ${sold.error}`);
        publicPurchases += 1;
      }
    }
    const targetCraftDelta = Object.fromEntries(targetIds.map((itemId) => [
      itemId,
      state.itemStats[itemId].crafted - baseline[itemId],
    ]));
    const rotationCash = state.cats.filter((cat) => rotationCatIds.has(cat.id))
      .reduce((sum, cat) => sum + cat.coins, 0);
    if (targetIds.every((itemId) => targetCraftDelta[itemId] >= 2)
      && rotationCash >= 300_000) break;
  }
  return {
    simulatedMs: simulatedNow(state) - startedAt,
    targetCraftDelta: Object.fromEntries(targetIds.map((itemId) => [
      itemId,
      state.itemStats[itemId].crafted - baseline[itemId],
    ])),
    centralCashCents: state.cats.filter((cat) => rotationCatIds.has(cat.id))
      .reduce((sum, cat) => sum + cat.coins, 0),
    publicPurchases,
    ordinaryTrades,
  };
}

function rampAutonomousProductionRange(
  state: GameState,
  player: ReturnType<typeof createAuditedPlayerFacade>,
  from: number,
  through: number,
  maxSimulatedMs: number,
  forceFullDuration = false,
): { simulatedMs: number; targetCraftDelta: Record<string, number>; reachedTwoEach: boolean } {
  const targetIds = RECIPES.slice(from - 1, through).map((recipe) => recipe.output);
  const baseline = Object.fromEntries(targetIds.map((itemId) => [itemId, state.itemStats[itemId].crafted]));
  const startedAt = simulatedNow(state);
  const deadline = startedAt + maxSimulatedMs;
  const delta = () => Object.fromEntries(targetIds.map((itemId) => [
    itemId,
    state.itemStats[itemId].crafted - baseline[itemId],
  ]));
  while (simulatedNow(state) < deadline) {
    const current = delta();
    if (!forceFullDuration && targetIds.every((itemId) => current[itemId] >= 2)) break;
    advanceSimulated(state, player, Math.min(STEP_SIMULATED_MS, deadline - simulatedNow(state)));
  }
  const targetCraftDelta = delta();
  return {
    simulatedMs: simulatedNow(state) - startedAt,
    targetCraftDelta,
    reachedTwoEach: targetIds.every((itemId) => targetCraftDelta[itemId] >= 2),
  };
}

function capitalizeRotationOwners(
  state: GameState,
  player: ReturnType<typeof createAuditedPlayerFacade>,
): Array<{ catId: string; itemId: string; costCents: number; warehouseRevenueCents: number }> {
  const groups = [
    { position: { x: 0, y: 0 }, itemIds: ["memory", "display", "sand"] },
    { position: { x: -1, y: -1 }, itemIds: ["wheel", "fuel", "coolant", "antenna"] },
    { position: { x: -1, y: 1 }, itemIds: ["coolant", "antenna", "water"] },
    { position: { x: 1, y: 1 }, itemIds: ["magnet", "metal", "battery"] },
  ];
  const trades: Array<{ catId: string; itemId: string; costCents: number; warehouseRevenueCents: number }> = [];
  for (const group of groups) {
    const cat = state.cats.find((entry) => entry.position.x === group.position.x && entry.position.y === group.position.y);
    if (!cat) continue;
    const line = catStockPurchaseQuote(state).lines
      .filter((entry) => entry.catId === cat.id
        && entry.unitPriceCents <= state.treasuryCoins)
      .sort((left, right) => {
        const leftPreference = group.itemIds.includes(left.itemId) ? group.itemIds.indexOf(left.itemId) : 999;
        const rightPreference = group.itemIds.includes(right.itemId) ? group.itemIds.indexOf(right.itemId) : 999;
        return leftPreference - rightPreference || left.itemId.localeCompare(right.itemId);
      })[0];
    if (line) {
      const bought = player.buyCatItem(line.catId, line.itemId);
      if (!bought.ok) continue;
      const sold = player.sellWarehouseItem(line.itemId, 1);
      if (!sold.ok) throw new Error(`rotation capitalization resale failed ${line.itemId}: ${sold.error}`);
      trades.push({
        catId: line.catId,
        itemId: line.itemId,
        costCents: line.unitPriceCents,
        warehouseRevenueCents: warehouseSellPrice(line.itemId),
      });
      continue;
    }
    const buildingOffer = state.buildingOffers.find((offer) => offer.status === "open"
      && offer.sellerCatId === cat.id && offer.itemId === "machine_tool" && offer.askCents <= state.treasuryCoins);
    if (!buildingOffer) continue;
    const boughtBuilding = player.buyBuilding(buildingOffer.id);
    if (boughtBuilding.ok) {
      trades.push({
        catId: cat.id,
        itemId: buildingOffer.itemId,
        costCents: buildingOffer.askCents,
        warehouseRevenueCents: 0,
      });
    }
  }
  return trades;
}

function acquireWarehouseFloor(
  state: GameState,
  player: ReturnType<typeof createAuditedPlayerFacade>,
  itemId: string,
  maxSimulatedMs = 900_000,
): { catId: string; itemId: string; costCents: number; warehouseQuantity: number } {
  const deadline = simulatedNow(state) + maxSimulatedMs;
  while (simulatedNow(state) <= deadline) {
    const line = catStockPurchaseQuote(state).lines
      .filter((entry) => entry.itemId === itemId && entry.unitPriceCents <= state.treasuryCoins)
      .sort((left, right) => left.unitPriceCents - right.unitPriceCents
        || left.catId.localeCompare(right.catId))[0];
    if (line) {
      const bought = player.buyCatItem(line.catId, line.itemId);
      if (!bought.ok) throw new Error(`warehouse floor purchase failed ${itemId}: ${bought.error}`);
      return {
        catId: line.catId,
        itemId,
        costCents: line.unitPriceCents,
        warehouseQuantity: state.playerBuildingInventory[itemId] ?? 0,
      };
    }
    if (simulatedNow(state) === deadline) break;
    advanceSimulated(state, player, Math.min(STEP_SIMULATED_MS, deadline - simulatedNow(state)));
  }
  throw new Error(`warehouse floor purchase unavailable after ${maxSimulatedMs}ms: ${itemId}`);
}

function capitalizeCatWithPublicTrades(
  state: GameState,
  player: ReturnType<typeof createAuditedPlayerFacade>,
  catId: string,
  itemId: string,
  units: number,
  maxSimulatedMs: number,
): number {
  const deadline = simulatedNow(state) + maxSimulatedMs;
  let traded = 0;
  while (traded < units && simulatedNow(state) < deadline) {
    const bought = player.buyCatItem(catId, itemId);
    if (!bought.ok) {
      advanceSimulated(state, player, Math.min(STEP_SIMULATED_MS, deadline - simulatedNow(state)));
      continue;
    }
    const sold = player.sellWarehouseItem(itemId, 1);
    if (!sold.ok) throw new Error(`capitalization warehouse resale failed ${itemId}: ${sold.error}`);
    traded += 1;
    tradeProfitableOrdinaryStock(state, player, 20);
  }
  return traded;
}

function buyRecipeRange(state: GameState, player: ReturnType<typeof createAuditedPlayerFacade>, from: number, through: number): number {
  let bought = 0;
  let changed = true;
  while (changed) {
    changed = false;
    const crafted = RECIPES.filter((recipe) => state.itemStats[recipe.output].crafted > 0).map((recipe) => recipe.output);
    for (const recipe of RECIPES.slice(from - 1, through)) {
      if (state.unlockedRecipes.includes(recipe.id) || !canUnlockRecipe(recipe.id, state.unlockedRecipes, crafted)) continue;
      const result = player.buyRecipe(recipe.id);
      if (result.ok) {
        bought += 1;
        changed = true;
      }
    }
  }
  return bought;
}

function fundAndBuyRange(
  state: GameState,
  player: ReturnType<typeof createAuditedPlayerFacade>,
  from: number,
  through: number,
  maxSimulatedMs: number,
): void {
  const deadline = simulatedNow(state) + maxSimulatedMs;
  while (!RECIPES.slice(from - 1, through).every((recipe) => state.unlockedRecipes.includes(recipe.id))
    && simulatedNow(state) < deadline) {
    buyRecipeRange(state, player, from, through);
    tradeProfitableOrdinaryStock(state, player);
    buyRecipeRange(state, player, from, through);
    if (RECIPES.slice(from - 1, through).every((recipe) => state.unlockedRecipes.includes(recipe.id))) break;
    advanceSimulated(state, player, Math.min(STEP_SIMULATED_MS, deadline - simulatedNow(state)));
  }
}

function runUntil(
  state: GameState,
  player: ReturnType<typeof createAuditedPlayerFacade>,
  condition: () => boolean,
  maxSimulatedMs: number,
  trade: boolean,
): void {
  const deadline = simulatedNow(state) + maxSimulatedMs;
  while (!condition() && simulatedNow(state) < deadline) {
    advanceSimulated(state, player, Math.min(STEP_SIMULATED_MS, deadline - simulatedNow(state)));
    if (trade) tradeProfitableOrdinaryStock(state, player);
  }
}

function orderAndCreditGaps(state: GameState) {
  return state.demandOrders.filter((order) => order.status === "open").map((order) => {
    const buyer = order.buyerCatId ? state.cats.find((cat) => cat.id === order.buyerCatId) : undefined;
    const credit = buyer ? creditAvailableCents(state, buyer, (itemId) => {
      const recipe = RECIPES.find((entry) => entry.output === itemId);
      return recipe ? Math.max(100, state.itemStats[itemId]?.revenue || 100) : 100;
    }) : state.treasuryCoins;
    return {
      orderId: order.id,
      itemId: order.itemId,
      maxDeliveredCents: order.maxDeliveredCents,
      reservedCents: order.reservedCents,
      availableCreditCents: credit,
      creditGapCents: Math.max(0, order.maxDeliveredCents - credit),
    };
  });
}

function legacyIndustrialSite(state: GameState): Record<IndustrialBuildingId, Position> {
  const choices = state.cats.map((cat) => {
    const positions: Position[] = [];
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
      if (Math.abs(dx) + Math.abs(dy) > 2) continue;
      const position = { x: cat.position.x + dx, y: cat.position.y + dy };
      if (!buildingPlacementFailure(state, "factory", position)) positions.push(position);
    }
    return { catId: cat.id, createdIndex: cat.createdIndex, positions };
  }).filter((entry) => entry.positions.length >= 3)
    .sort((left, right) => left.createdIndex - right.createdIndex || right.positions.length - left.positions.length);
  const selected = choices[0];
  if (!selected) throw new Error("初始地块没有工厂/机床/天线共同覆盖的三个合法空格");
  return { factory: selected.positions[0], machine_tool: selected.positions[1], antenna: selected.positions[2] };
}

function industrialSite(state: GameState): Record<IndustrialBuildingId, Position> {
  const center = state.cats.find((cat) => cat.position.x === 0 && cat.position.y === 0)?.position;
  const west = state.cats.find((cat) => cat.position.x === -1 && cat.position.y === -1)?.position;
  if (!center || !west) throw new Error("starter cat chain lacks the (0,0) or (-1,-1) workstation");
  const distance = (left: Position, right: Position) => Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
  const candidates = (itemId: IndustrialBuildingId, covered: readonly Position[]): Position[] => {
    const positions: Position[] = [];
    for (let y = -4; y <= 4; y += 1) for (let x = -4; x <= 4; x += 1) {
      const position = { x, y };
      if (covered.some((target) => distance(position, target) > 2)) continue;
      if (!buildingPlacementFailure(state, itemId, position)) positions.push(position);
    }
    return positions.sort((left, right) => (
      covered.reduce((sum, target) => sum + distance(left, target), 0)
        - covered.reduce((sum, target) => sum + distance(right, target), 0)
      || left.y - right.y
      || left.x - right.x
    ));
  };
  const factory = candidates("factory", [center, west])[0];
  const machineTool = candidates("machine_tool", [center, west])
    .find((position) => position.x !== factory?.x || position.y !== factory?.y);
  const antenna = candidates("antenna", [center])
    .find((position) => (position.x !== factory?.x || position.y !== factory?.y)
      && (position.x !== machineTool?.x || position.y !== machineTool?.y));
  if (!factory || !machineTool || !antenna) {
    throw new Error("starter parcel lacks three legal industrial tiles covering the selected workstations");
  }
  return { factory, machine_tool: machineTool, antenna };
}

function buyAndPlaceBuildings(
  state: GameState,
  player: ReturnType<typeof createAuditedPlayerFacade>,
  positions: Record<IndustrialBuildingId, Position>,
  maxSimulatedMs: number,
  buildingIds: readonly IndustrialBuildingId[] = INDUSTRIAL_BUILDINGS,
): void {
  const deadline = simulatedNow(state) + maxSimulatedMs;
  for (const itemId of buildingIds) {
    while (!state.buildings.some((building) => building.itemId === itemId) && simulatedNow(state) < deadline) {
      if ((state.playerBuildingInventory[itemId] ?? 0) < 1) {
        const offer = state.buildingOffers
          .filter((entry) => entry.status === "open" && entry.itemId === itemId)
          .sort((left, right) => left.askCents - right.askCents || left.id.localeCompare(right.id))[0];
        if (offer && offer.askCents <= state.treasuryCoins) player.buyBuilding(offer.id);
      }
      if ((state.playerBuildingInventory[itemId] ?? 0) > 0) {
        const placed = player.placeBuilding(itemId, positions[itemId]);
        if (!placed.ok) throw new Error(`放置${itemId}失败：${placed.error}`);
        break;
      }
      tradeProfitableOrdinaryStock(state, player);
      advanceSimulated(state, player, Math.min(STEP_SIMULATED_MS, deadline - simulatedNow(state)));
    }
  }
}

function antiCheat(state: GameState, initial: GameState, drafts: Record<string, LawDraft>) {
  const forbiddenCommands = state.commandAudit.filter((entry) => entry.origin === "player-ui" && !ALLOWED_PLAYER_COMMANDS.has(entry.kind));
  const catsUnchanged = state.cats.length === initial.cats.length && state.cats.every((cat, index) => (
    cat.id === initial.cats[index]?.id
      && cat.position.x === initial.cats[index]?.position.x
      && cat.position.y === initial.cats[index]?.position.y
  ));
  const parcelsUnchanged = JSON.stringify(state.unlockedParcels) === JSON.stringify(initial.unlockedParcels);
  const modelSourcesUnchanged = Object.values(drafts).every((draft) => (
    draft.astHash === hashSource(draft.sourceCode)
      && state.laws.filter((law) => law.astHash === draft.astHash).every((law) => law.sourceCode === draft.sourceCode)
  ));
  const sharedBehaviorUnchanged = SHARED_BEHAVIOR_HASH === initialSharedHash && SHARED_BEHAVIOR_SOURCE === initialSharedSource;
  const runtimeHashUnchanged = hashSource(SHARED_BEHAVIOR_SOURCE) === initialRuntimeHash
    && SHARED_BEHAVIOR_HASH === initialRuntimeHash;
  const prohibitedMutationCount = forbiddenCommands.length + Number(!catsUnchanged) + Number(!parcelsUnchanged)
    + Number(!modelSourcesUnchanged) + Number(!sharedBehaviorUnchanged) + Number(!runtimeHashUnchanged)
    + Number(state.worldSeed !== initial.worldSeed) + Number(state.difficulty !== initial.difficulty);
  return {
    passed: prohibitedMutationCount === 0,
    prohibitedMutationCount,
    forbiddenCommands,
    catsUnchanged,
    parcelsUnchanged,
    worldSeedUnchanged: state.worldSeed === initial.worldSeed,
    difficultyUnchanged: state.difficulty === initial.difficulty,
    sharedBehaviorUnchanged,
    sharedBehaviorHash: SHARED_BEHAVIOR_HASH,
    runtimeHash: hashSource(SHARED_BEHAVIOR_SOURCE),
    runtimeHashUnchanged,
    modelSourcesUnchanged,
    publicPlayerCommands: state.commandAudit.filter((entry) => entry.origin === "player-ui"),
  };
}

const initialSharedHash = SHARED_BEHAVIOR_HASH;
const initialSharedSource = SHARED_BEHAVIOR_SOURCE;
const initialRuntimeHash = hashSource(SHARED_BEHAVIOR_SOURCE);

let activePartialRun: {
  seed: number;
  state: GameState;
  initial: GameState;
  stages: StageRecord[];
} | null = null;

function runSeedTo30(seed: number, drafts: Record<string, LawDraft>) {
  const checkpoint = (label: string) => process.stderr.write(`[headless seed=${seed}] ${label} sim=${simulatedNow(state)}ms\n`);
  const state = createInitialState({ worldSeed: seed, difficulty: 5, simulationSpeed: SIMULATION_SPEED });
  const initial = structuredClone(state);
  const player = createAuditedPlayerFacade(state);
  const stages: StageRecord[] = [];
  activePartialRun = { seed, state, initial, stages };

  const item10StageIndex = stages.push(stage(state, seed, "开局自然达到10", () => {
    runUntil(state, player, () => missingThrough(state, 10).length === 0, 1_800_000, false);
  }, 10)) - 1;
  if (missingThrough(state, 10).length) throw new Error(`seed ${seed} 1800秒内未自然达到10`);
  if (state.itemStats.paper.crafted > 0) throw new Error(`seed ${seed} 未购买图纸却制作了第11项`);
  requireStable(state, player, stages, item10StageIndex, 10);
  if (state.itemStats.paper.crafted > 0) throw new Error(`seed ${seed} 开局稳态观察期制作了第11项`);
  checkpoint("item10");

  const item15StageIndex = stages.push(stage(state, seed, "仅购买11—15图纸后达到15", () => {
    buyRecipeRange(state, player, 11, 15);
    runUntil(state, player, () => missingThrough(state, 15).length === 0, 1_800_000, false);
  }, 15)) - 1;
  if (missingThrough(state, 15).length) throw new Error(`seed ${seed} 未达到15`);
  requireStable(state, player, stages, item15StageIndex, 15);
  checkpoint("item15");

  const natural19StageIndex = stages.push(stage(state, seed, "自然16–19稳定且第20项不能稳定制作", () => {
    fundAndBuyRange(state, player, 16, 20, 600_000);
    runUntil(state, player, () => RECIPES.slice(15, 19).every((recipe) => state.itemStats[recipe.output].crafted > 0), 1_800_000, false);
  }, 19, () => ({ factoryCraftedBeforeObservation: state.itemStats.factory.crafted }))) - 1;
  if (missingThrough(state, 19).length) {
    throw new Error(`seed ${seed} 自然瓶颈不符合预期：${JSON.stringify({
      craftedThrough: craftedThrough(state),
      crafted16To20: RECIPES.slice(15, 20).map((recipe) => [recipe.output, state.itemStats[recipe.output].crafted]),
      factoryCrafted: state.itemStats.factory.crafted,
      activePlans: state.procurementPlans.filter((plan) => plan.status === "active").map((plan) => ({
        catId: plan.catId,
        output: plan.outputItemId,
        reason: plan.reason,
      })),
      orders: orderAndCreditGaps(state),
      decisions: state.cats.map((cat) => ({ id: cat.id, last: cat.lastDecision, trace: cat.decisionTrace })),
    })}`);
  }
  const natural19Stability = requireStable(state, player, stages, natural19StageIndex, 19);
  const factoryEvidence = natural19Stability.nextItemEvidence;
  if (!factoryEvidence || factoryEvidence.itemId !== "factory") throw new Error(`seed ${seed} 缺少第20项稳态探针证据`);
  if (factoryEvidence.stable) throw new Error(`seed ${seed} 第20项在自然观察期已经达到稳定制作：${JSON.stringify(factoryEvidence)}`);
  stages[natural19StageIndex].detail = {
    factoryCraftedBeforeObservation: factoryEvidence.totalCraftedBefore,
    factoryCraftedAfterObservation: factoryEvidence.totalCraftedAfter,
    item20Stable: false,
    item20Classification: factoryEvidence.classification,
    item20WindowCrafts: factoryEvidence.windowCrafts,
  };
  checkpoint("natural19-factory0");

  const factoryPrice = player.enact(drafts["selective-factory-ramp"]);
  if (!factoryPrice.ok || !factoryPrice.law) throw new Error(`seed ${seed} 工厂价格法颁布失败：${factoryPrice.error}`);
  stages.push(stage(state, seed, "选择性工厂价格爬坡", () => {
    runUntil(state, player, () => state.itemStats.factory.crafted >= 1, 2_400_000, true);
  }, 20, () => ({ factoryCrafted: state.itemStats.factory.crafted })));
  if (state.itemStats.factory.crafted < 1) throw new Error(`seed ${seed} 工厂价格法未能形成爬坡产量`);
  const capitalization = player.enact(drafts["water-capitalization"]);
  if (!capitalization.ok || !capitalization.law) throw new Error(`seed ${seed} 水资源资本化价格法颁布失败：${capitalization.error}`);
  const waterCat = state.cats
    .filter((cat) => resourceItemsAt(state, cat.position).includes("water"))
    .sort((left, right) => left.createdIndex - right.createdIndex)[0];
  if (!waterCat) throw new Error(`seed ${seed} 没有合法的水资源工位猫`);
  const waterCapitalizationTrades = capitalizeCatWithPublicTrades(state, player, waterCat.id, "water", 15, 1_800_000);
  if (waterCapitalizationTrades < 10) throw new Error(`seed ${seed} 水资源资本化交易不足：${waterCapitalizationTrades}/15（最低10）`);
  const factoryCapitalizationTrades = 0;
  const retiredFactoryRamp = player.repeal(factoryPrice.law.id);
  if (!retiredFactoryRamp.ok) throw new Error(`seed ${seed} 无法废止工厂爬坡法：${retiredFactoryRamp.error}`);
  const retiredCapitalization = player.repeal(capitalization.law.id);
  if (!retiredCapitalization.ok) throw new Error(`seed ${seed} 无法废止水资源资本化法：${retiredCapitalization.error}`);
  const selective = player.enact(drafts["selective-price-to-22"], state.laws.length);
  if (!selective.ok || !selective.law) throw new Error(`seed ${seed} 轻工业价格法颁布失败：${selective.error}`);
  const item22StageIndex = stages.push(stage(state, seed, "选择性价格推进并稳定制作至22", () => {
    fundAndBuyRange(state, player, 21, 22, 600_000);
    runUntil(state, player, () => missingThrough(state, 22).length === 0, ITEM22_LIMIT_MS, true);
  }, 22, () => ({
    capitalizationLawId: capitalization.law?.id,
    waterCapitalizationTrades,
    factoryCapitalizationTrades,
    capitalizedCats: [waterCat.id, "cat-0"].map((catId) => ({
      catId,
      cashCents: state.cats.find((cat) => cat.id === catId)?.coins ?? 0,
      debtCents: state.cats.find((cat) => cat.id === catId)?.debtCents ?? 0,
    })),
    prices: Object.fromEntries(["water", "factory", "lamp", "magnet", "chassis"].map((itemId) => [itemId, itemPrice(state, itemId)])),
  }))) - 1;
  if (missingThrough(state, 22).length) throw new Error(`seed ${seed} 价格优化未达到22：${JSON.stringify({
    missing: missingThrough(state, 22),
    simulatedMs: simulatedNow(state),
    treasuryCents: state.treasuryCoins,
    unlocked: state.unlockedRecipes.slice(-12),
    prices: Object.fromEntries(["factory", "lamp", "magnet"].map((itemId) => [itemId, itemPrice(state, itemId)])),
    relevantBounties: state.discoveryBounties.filter((bounty) => ["factory", "lamp", "magnet"].includes(bounty.itemId)),
    relevantPlans: state.procurementPlans.filter((plan) => ["factory", "lamp", "magnet"].includes(plan.outputItemId)),
    opportunityDiagnostics: state.cats.map((cat) => productionOpportunityDiagnosticForCat(
      state,
      cat,
      (itemId) => itemPrice(state, itemId),
      "lamp",
    )),
    priceLaws: state.laws.filter((law) => law.status === "active" && priceCalls(law).length > 0)
      .map((law) => ({ id: law.id, title: law.title, prices: priceCalls(law) })),
    crafted16To22: RECIPES.slice(15, 22).map((recipe) => [recipe.output, state.itemStats[recipe.output].crafted]),
    plans: state.procurementPlans.filter((plan) => plan.status === "active").map((plan) => ({ catId: plan.catId, output: plan.outputItemId, reason: plan.reason })),
    orders: orderAndCreditGaps(state),
  })}`);
  requireStable(state, player, stages, item22StageIndex, 22);
  checkpoint("selective-price-item22");

  if (STOP_AT_22) {
    return {
      state,
      initial,
      stages,
      branchPreparation: null,
      priceBranches: [],
      positions: industrialSite(state),
      antiCheat: antiCheat(state, initial, drafts),
    };
  }

  const positions = industrialSite(state);
  stages.push(stage(state, seed, "正常收购并提前部署工厂", () => {
    buyAndPlaceBuildings(state, player, positions, 600_000, ["factory"]);
  }, 22, () => ({ positions, buildings: state.buildings })));
  if (!state.buildings.some((building) => building.itemId === "factory")) throw new Error(`seed ${seed} 未能通过正常报价部署工厂`);
  checkpoint("factory-deployed");

  const item22Snapshot = structuredClone(state);
  const branchSnapshot = structuredClone(item22Snapshot);
  const branchPreparation = stage(branchSnapshot, seed, "价格分支统一购买23—30图纸", () => {
    fundAndBuyRange(branchSnapshot, createAuditedPlayerFacade(branchSnapshot), 23, 30, 1_200_000);
  }, 22, () => ({ unlocked23To30: RECIPES.slice(22, 30).filter((recipe) => branchSnapshot.unlockedRecipes.includes(recipe.id)).length }));
  if (!RECIPES.slice(22, 30).every((recipe) => branchSnapshot.unlockedRecipes.includes(recipe.id))) {
    throw new Error(`seed ${seed} 无法用正常交易购买23—30图纸`);
  }
  process.stderr.write(`[headless seed=${seed}] branch-recipes23-30 sim=${simulatedNow(branchSnapshot)}ms\n`);
  const branchLawIds = process.argv.includes("--skip-branches")
    ? []
    : ["global-x2", "items-22-30-x2", "global-x10", "adaptive-price-only"];
  const stagePriceLawIds = [selective.law.id, factoryPrice.law.id, capitalization.law.id];
  const priceBranches = branchLawIds.map((lawId) => {
    const branch = structuredClone(branchSnapshot);
    const branchPlayer = createAuditedPlayerFacade(branch);
    const start = simulatedNow(branch);
    const wallStarted = performance.now();
    for (const completedLawId of stagePriceLawIds) {
      if (branch.laws.find((law) => law.id === completedLawId)?.status !== "active") continue;
      const repealed = branchPlayer.repeal(completedLawId);
      if (!repealed.ok) throw new Error(`seed ${seed} ${lawId}分支无法清除阶段价格法：${repealed.error}`);
    }
    const enacted = branchPlayer.enact(drafts[lawId]);
    if (!enacted.ok) throw new Error(`seed ${seed} ${lawId}颁布失败：${enacted.error}`);
    runUntil(branch, branchPlayer, () => missingThrough(branch, 30).length === 0, 1_200_000, true);
    const missing = missingThrough(branch, 30).filter((id) => RECIPES.slice(21, 30).some((recipe) => recipe.output === id));
    const stability = observeStability(branch, branchPlayer, 30, STABILITY_POLICY.observationMs[30]);
    const result = {
      lawId,
      passedExpectedFailure: !stability.passed,
      simulatedStartMs: start,
      simulatedEndMs: simulatedNow(branch),
      simulatedElapsedMs: simulatedNow(branch) - start,
      wallClockMs: Math.round(performance.now() - wallStarted),
      craftedThrough: craftedThrough(branch),
      missingItems22To30: missing,
      unstableItems22To30: stability.itemEvidence.slice(21, 30).filter((item) => !item.stable).map((item) => item.itemId),
      stability,
      openOrderCostsAndCreditGaps: orderAndCreditGaps(branch),
      treasuryCents: branch.treasuryCoins,
      commandAudit: branch.commandAudit.filter((entry) => entry.sequence > (branchSnapshot.commandAudit.at(-1)?.sequence ?? 0)),
    };
    process.stderr.write(`[headless seed=${seed}] branch=${lawId} through=${result.craftedThrough} stableThrough=${stability.stableThrough} missing=${missing.join(",")} wall=${result.wallClockMs}ms\n`);
    return result;
  });
  if (priceBranches.some((branch) => !branch.passedExpectedFailure)) throw new Error(`seed ${seed} 存在单纯价格分支完成22—30`);

  const main = structuredClone(item22Snapshot);
  const mainPlayer = createAuditedPlayerFacade(main);
  if (activePartialRun) activePartialRun.state = main;
  // The logistics stage builds on the already-proven selective pricing policy.
  // Only the temporary factory-ramp and cash-capitalization laws have completed
  // their purpose here. Repealing the selective policy would change the stage
  // under test and deliberately make items 20-22 unprofitable during the
  // 1-30 stability window.
  for (const completedLawId of [factoryPrice.law.id, capitalization.law.id]) {
    const completedLaw = main.laws.find((law) => law.id === completedLawId);
    if (completedLaw?.status !== "active") continue;
    if (!completedLaw) throw new Error("主分支丢失选择性价格法");
    const repealed = mainPlayer.repeal(completedLaw.id);
    if (!repealed.ok) throw new Error(`废止已完成使命的选择性价格法失败：${repealed.error}`);
  }
  const terminalDiscipline = mainPlayer.enact(drafts["terminal-discipline-23-30"], main.laws.length);
  if (!terminalDiscipline.ok) throw new Error(`终端投机约束法颁布失败：${terminalDiscipline.error}`);
  const logistics = mainPlayer.enact(drafts["logistics-22-30"], main.laws.length);
  if (!logistics.ok) throw new Error(`物流法颁布失败：${logistics.error}`);
  let terminalRotationRamp: ReturnType<typeof prepareFrozenTerminalRotation> | null = null;
  let terminalAutonomousRamp: ReturnType<typeof rampAutonomousProductionRange> | null = null;
  let terminalCapitalizationTrades: ReturnType<typeof capitalizeRotationOwners> = [];
  const plankWarehouseFloorPurchases: Array<ReturnType<typeof acquireWarehouseFloor>> = [];
  const oreWarehouseFloorPurchases: Array<ReturnType<typeof acquireWarehouseFloor>> = [];
  const waterWarehouseFloorPurchases: Array<ReturnType<typeof acquireWarehouseFloor>> = [];
  let fireWarehouseFloorPurchase: ReturnType<typeof acquireWarehouseFloor> | null = null;
  let metalWarehouseFloorPurchase: ReturnType<typeof acquireWarehouseFloor> | null = null;
  const cableWarehouseFloorPurchases: Array<ReturnType<typeof acquireWarehouseFloor>> = [];
  let glassWarehouseFloorPurchase: ReturnType<typeof acquireWarehouseFloor> | null = null;
  let lampWarehouseFloorPurchase: ReturnType<typeof acquireWarehouseFloor> | null = null;
  cableWarehouseFloorPurchases.push(acquireWarehouseFloor(main, mainPlayer, "cable"));
  cableWarehouseFloorPurchases.push(acquireWarehouseFloor(main, mainPlayer, "cable"));
  const item30StageIndex = stages.push(stage(main, seed, "物流法规完成并稳定制作22—30", () => {
    const deadline = simulatedNow(main) + LOGISTICS_LIMIT_MS;
    for (let itemIndex = 23; itemIndex <= 30 && simulatedNow(main) < deadline; itemIndex += 1) {
      const remaining = () => Math.max(0, deadline - simulatedNow(main));
      fundAndBuyRange(main, mainPlayer, itemIndex, itemIndex, remaining());
      runUntil(main, mainPlayer, () => missingThrough(main, itemIndex).length === 0, remaining(), false);
    }
    if (missingThrough(main, 30).length === 0) {
      const stableRotation = mainPlayer.enact(drafts["stable-rotation-23-30"], main.laws.length);
      if (!stableRotation.ok) throw new Error(`稳态轮换法颁布失败：${stableRotation.error}`);
      // The new law resets the stability clock. Ramp it with public market
      // operations, then evaluate only after laws, prices and trades freeze.
      terminalRotationRamp = prepareFrozenTerminalRotation(main, mainPlayer, RAMP_30_MS);
      const capitalization = mainPlayer.enact(drafts["rotation-capitalization"], 0);
      if (!capitalization.ok || !capitalization.law) throw new Error(`终端责任猫资本化法颁布失败：${capitalization.error}`);
      terminalCapitalizationTrades = capitalizeRotationOwners(main, mainPlayer);
      if (terminalCapitalizationTrades.length === 0) {
        throw new Error(`终端责任猫公开资本化交易不足：${JSON.stringify({
          completed: terminalCapitalizationTrades,
          treasuryCents: main.treasuryCoins,
          cats: main.cats.filter((cat) => Math.abs(cat.position.x) === 1 && cat.position.y === -1).map((cat) => ({
            id: cat.id,
            position: cat.position,
            inventory: cat.inventory,
            coins: cat.coins,
            escrowReservedCents: cat.escrowReservedCents,
            action: cat.action,
          })),
          purchaseLines: catStockPurchaseQuote(main).lines.filter((line) => ["cat-2", "cat-7"].includes(line.catId)),
          buildingOffers: main.buildingOffers.filter((offer) => ["cat-2", "cat-7"].includes(offer.sellerCatId)),
        })}`);
      }
      plankWarehouseFloorPurchases.push(acquireWarehouseFloor(main, mainPlayer, "plank"));
      plankWarehouseFloorPurchases.push(acquireWarehouseFloor(main, mainPlayer, "plank"));
      oreWarehouseFloorPurchases.push(acquireWarehouseFloor(main, mainPlayer, "ore"));
      oreWarehouseFloorPurchases.push(acquireWarehouseFloor(main, mainPlayer, "ore"));
      waterWarehouseFloorPurchases.push(acquireWarehouseFloor(main, mainPlayer, "water"));
      waterWarehouseFloorPurchases.push(acquireWarehouseFloor(main, mainPlayer, "water"));
      fireWarehouseFloorPurchase = acquireWarehouseFloor(main, mainPlayer, "fire");
      metalWarehouseFloorPurchase = acquireWarehouseFloor(main, mainPlayer, "metal");
      glassWarehouseFloorPurchase = acquireWarehouseFloor(main, mainPlayer, "glass");
      lampWarehouseFloorPurchase = acquireWarehouseFloor(main, mainPlayer, "lamp");
      const repealed = mainPlayer.repeal(capitalization.law.id);
      if (!repealed.ok) throw new Error(`终端责任猫资本化法废止失败：${repealed.error}`);
      const flowBalance = mainPlayer.enact(drafts["flow-balance-1-30"], main.laws.length);
      if (!flowBalance.ok) throw new Error(`前30项流量守恒法颁布失败：${flowBalance.error}`);
      // Flow conservation is the final policy change. Capture the stability
      // baseline only after this no-trade/no-law settling period.
      terminalAutonomousRamp = rampAutonomousProductionRange(main, mainPlayer, 23, 30, RAMP_30_MS * 2, true);
      if (!terminalAutonomousRamp.reachedTwoEach) {
        throw new Error(`terminal rotation did not settle after the final policy change: ${JSON.stringify(terminalAutonomousRamp)}`);
      }
    }
  }, 30, () => ({
    terminalRotationRamp,
    terminalCapitalizationTrades,
    plankWarehouseFloorPurchases,
    oreWarehouseFloorPurchases,
    waterWarehouseFloorPurchases,
    fireWarehouseFloorPurchase,
    metalWarehouseFloorPurchase,
    cableWarehouseFloorPurchases,
    glassWarehouseFloorPurchase,
    lampWarehouseFloorPurchase,
    terminalAutonomousRamp,
  }))) - 1;
  const missingAfterLogistics = missingThrough(main, 30);
  if (missingAfterLogistics.length) {
    const firstMissingAfterLogistics = missingAfterLogistics[0];
    throw new Error(`seed ${seed} 物流法未达到30：${JSON.stringify({
    missing: missingAfterLogistics,
    simulatedMs: simulatedNow(main),
    treasuryCents: main.treasuryCoins,
    unlocked23To30: RECIPES.slice(22, 30).map((recipe) => [recipe.output, main.unlockedRecipes.includes(recipe.id)]),
    crafted22To30: RECIPES.slice(21, 30).map((recipe) => [recipe.output, main.itemStats[recipe.output].crafted]),
    bounties23To30: main.discoveryBounties.filter((bounty) => RECIPES.slice(22, 30).some((recipe) => recipe.output === bounty.itemId)),
    firstMissingOpportunities: main.cats.map((cat) => productionOpportunityDiagnosticForCat(
      main,
      cat,
      (itemId) => itemPrice(main, itemId),
      firstMissingAfterLogistics,
    )),
    activeDecisionLaws: main.laws.filter((law) => law.status === "active" && decisionCapabilities(law.sourceCode)
      .some((capability) => ["direct-action", "score-adjustment", "selector"].includes(capability)))
      .map((law) => ({ id: law.id, title: law.title, invalidCount: law.invalidCount, consecutiveFaults: law.consecutiveFaults })),
    plans: main.procurementPlans.filter((plan) => plan.status === "active").map((plan) => ({ catId: plan.catId, output: plan.outputItemId, reason: plan.reason })),
    orders: orderAndCreditGaps(main),
    decisions: main.cats.map((cat) => ({ id: cat.id, cash: cat.coins, debt: cat.debtCents, last: cat.lastDecision, trace: cat.decisionTrace })),
  })}`);
  }
  requireStable(main, mainPlayer, stages, item30StageIndex, 30);
  process.stderr.write(`[headless seed=${seed}] logistics-item30 sim=${simulatedNow(main)}ms\n`);

  return { state: main, initial, stages, branchPreparation, priceBranches, positions, antiCheat: antiCheat(main, initial, drafts) };
}

const loaded = await loadDrafts();
const wallStarted = performance.now();
const seedResults: Array<Record<string, unknown>> = [];
let seedOne: ReturnType<typeof runSeedTo30> | null = null;
let fatalError: string | null = null;

try {
  const requestedSeedArg = process.argv.find((argument) => argument.startsWith("--seed="));
  const requestedSeeds = requestedSeedArg ? [Number(requestedSeedArg.slice("--seed=".length))] : [1, 7, 91];
  const acceptsSingleNonPrimarySeed = Boolean(requestedSeedArg && (STOP_AT_22 || process.argv.includes("--stop-at-30")));
  for (const seed of requestedSeeds) {
    const result = runSeedTo30(seed, loaded.drafts);
    if (seed === 1 || (acceptsSingleNonPrimarySeed && seedOne === null)) seedOne = result;
    seedResults.push({
      seed,
      passed: result.stages.every((entry) => entry.passed) && result.priceBranches.every((entry) => entry.passedExpectedFailure) && result.antiCheat.passed,
      stages: result.stages,
      priceBranches: result.priceBranches,
      antiCheat: result.antiCheat,
      final: { simulatedMs: simulatedNow(result.state), treasuryCents: result.state.treasuryCoins, craftedThrough: craftedThrough(result.state) },
    });
    activePartialRun = null;
  }

  if (!seedOne) throw new Error("seed 1未执行");
  const stopAt30 = process.argv.includes("--stop-at-30") || STOP_AT_22;
  const state = seedOne.state;
  if (!stopAt30) {
    const player = createAuditedPlayerFacade(state);
    const positions = seedOne.positions;
    const advancedEnactment = player.enact(loaded.drafts["advanced-31-35"]);
    let advancedAutonomousRamp: ReturnType<typeof rampAutonomousProductionRange> | null = null;
    if (!advancedEnactment.ok) throw new Error(`高级制造法颁布失败：${advancedEnactment.error}`);
    const item35StageIndex = seedOne.stages.push(stage(state, 1, "正常交易、部署工业建筑并稳定制作31—35", () => {
      buyAndPlaceBuildings(state, player, positions, 2_400_000, ["machine_tool", "antenna"]);
      if (!INDUSTRIAL_BUILDINGS.every((itemId) => state.buildings.some((building) => building.itemId === itemId))) return;
      fundAndBuyRange(state, player, 31, 35, 3_600_000);
      runUntil(state, player, () => missingThrough(state, 35).length === 0, 7_200_000, true);
      if (missingThrough(state, 35).length === 0) {
        advancedAutonomousRamp = rampAutonomousProductionRange(state, player, 31, 35, RAMP_30_MS * 3, true);
        if (!advancedAutonomousRamp.reachedTwoEach) {
          throw new Error(`advanced production did not settle after the final player operation: ${JSON.stringify(advancedAutonomousRamp)}`);
        }
      }
    }, 35, () => ({ positions, buildings: state.buildings, cats: state.cats.length, advancedAutonomousRamp }))) - 1;
    if (missingThrough(state, 35).length) throw new Error(`seed 1最高难度未达到35：${missingThrough(state, 35).join(",")}`);
    requireStable(state, player, seedOne.stages, item35StageIndex, 35);
  }
  seedOne.antiCheat = antiCheat(state, seedOne.initial, loaded.drafts);
  if (!seedOne.antiCheat.passed) throw new Error("seed 1防作弊审计失败");

  const seedOneReport = seedResults.find((entry) => entry.seed === seedOne.initial.worldSeed)!;
  seedOneReport.stages = seedOne.stages;
  seedOneReport.antiCheat = seedOne.antiCheat;
  seedOneReport.final = {
    simulatedMs: simulatedNow(state),
    treasuryCents: state.treasuryCoins,
    craftedThrough: craftedThrough(state),
    buildings: state.buildings,
    cats: state.cats.length,
  };
  seedOneReport.craftedItems = RECIPES.slice(0, stopAt30 ? 30 : 35).map((recipe, index) => ({
    index: index + 1,
    itemId: recipe.output,
    crafted: state.itemStats[recipe.output].crafted,
  }));
  seedOneReport.playerLedger = state.commandAudit.filter((entry) => entry.origin === "player-ui");
} catch (error) {
  fatalError = error instanceof Error ? error.stack ?? error.message : String(error);
  if (activePartialRun && !seedResults.some((entry) => entry.seed === activePartialRun?.seed)) {
    const partial = activePartialRun;
    seedResults.push({
      seed: partial.seed,
      passed: false,
      stages: partial.stages,
      priceBranches: [],
      antiCheat: antiCheat(partial.state, partial.initial, loaded.drafts),
      final: {
        simulatedMs: simulatedNow(partial.state),
        treasuryCents: partial.state.treasuryCoins,
        craftedThrough: craftedThrough(partial.state),
        missingThrough35: missingThrough(partial.state, 35),
        activePlans: partial.state.procurementPlans.filter((plan) => plan.status === "active"),
        openOrders: partial.state.demandOrders.filter((order) => order.status === "open"),
        activeContracts: partial.state.shipmentContracts.filter((contract) => contract.status !== "delivered"),
        openOrderProducerPlans: partial.state.procurementPlans.filter((plan) => (
          plan.terminalOrderId !== null
            && partial.state.demandOrders.some((order) => order.id === plan.terminalOrderId && order.status === "open")
        )),
        laws: partial.state.laws.map((law) => ({
          id: law.id,
          title: law.title,
          status: law.status,
          invalidCount: law.invalidCount,
          consecutiveFaults: law.consecutiveFaults,
          astHash: law.astHash,
        })),
        cats: partial.state.cats.map((cat) => ({
          id: cat.id,
          position: cat.position,
          coins: cat.coins,
          debtCents: cat.debtCents,
          escrowReservedCents: cat.escrowReservedCents,
          inventory: cat.inventory,
          action: cat.action,
          lastDecision: cat.lastDecision,
          decisionTrace: cat.decisionTrace,
          topOpportunities: productionOpportunitiesForCat(
            partial.state,
            cat,
            (itemId) => itemPrice(partial.state, itemId),
          ).slice(0, 12).map((opportunity) => ({
            itemId: opportunity.itemId,
            reason: opportunity.reason,
            terminalOrderId: opportunity.terminalOrderId,
            netAssetGainCents: opportunity.netAssetGainCents,
            assetGainRate: opportunity.assetGainRate,
          })),
        })),
      },
      craftedItems: RECIPES.slice(0, 35).map((recipe, index) => ({
        index: index + 1,
        itemId: recipe.output,
        crafted: partial.state.itemStats[recipe.output].crafted,
      })),
      playerLedger: partial.state.commandAudit.filter((entry) => entry.origin === "player-ui"),
    });
  }
}

const primarySeedResult = seedResults.find((entry) => entry.seed === 1)
  ?? (seedResults.length === 1 ? seedResults[0] : undefined);
const expectedTarget = STOP_AT_22 ? 22 : process.argv.includes("--stop-at-30") ? 30 : 35;
const report = {
  schema: "deepseek-to-35-headless-v2-stable-production",
  generatedAt: new Date().toISOString(),
  sourceMode: loaded.mode,
  model: loaded.mode === "live" ? "deepseek-v4-flash" : "fixed-ci-fixture",
  difficulty: 5,
  seeds: seedResults.map((entry) => entry.seed),
  simulationSpeed: SIMULATION_SPEED,
  wallClockMs: Math.round(performance.now() - wallStarted),
  timingPolicy: {
    actionBaseRealtimeMs: 5_000,
    configuredEngineAcceleration: SIMULATION_SPEED,
    logicalSimulatedTime: "Every reported stage/observation duration is the equivalent unaccelerated game time.",
    engineClockConversion: "engine milliseconds advanced = logical simulated milliseconds / configured engine acceleration",
    measuredEffectiveAcceleration: "logical simulated milliseconds / measured wall-clock milliseconds",
    note: "The configured 5000x engine scale is not reported as measured performance; wall-clock acceleration is calculated separately for each stage.",
  },
  stabilityPolicy: STABILITY_POLICY,
  fatalError,
  target: expectedTarget,
  passed: fatalError === null
    && seedResults.length >= 1
    && seedResults.every((entry) => entry.passed)
    && primarySeedResult?.final
    && (primarySeedResult.final as { craftedThrough?: number }).craftedThrough === expectedTarget,
  seedResults,
};
await mkdir(dirname(REPORT_OUTPUT_PATH), { recursive: true });
await writeFile(REPORT_OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  passed: report.passed,
  sourceMode: report.sourceMode,
  wallClockMs: report.wallClockMs,
  fatalError,
  seeds: seedResults.map((entry) => ({ seed: entry.seed, passed: entry.passed, final: entry.final })),
}, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
