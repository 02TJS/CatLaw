import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Run = {
  seed: number;
  stage10Ramp: { reached: boolean; logicalElapsedMs: number };
  stage10: Stage;
  stage15Ramp: { reached: boolean; logicalElapsedMs: number };
  stage15: Stage;
  finalState: { totalDebtCents: number; totalCatCashCents: number };
};

type Material = {
  itemId: string;
  crafted: number;
  consumed: number;
  stockStart: number;
  stockEnd: number;
  stockByWindow: number[];
  stockChange: number;
  uncoveredConsumption: number;
  passed: boolean;
};

type Stage = {
  passed: boolean;
  itemEvidence: Array<{ itemId: string; stable: boolean; windowCrafts: number[] }>;
  nextItemEvidence: null | { itemId: string; craftedDuringObservation: number };
  materialCoverage: Material[];
  frozenEconomy: {
    stalledContracts: Array<{
      itemId: string;
      routeCatIds: string[];
      holder: null | {
        id: string;
        action: null | { type: string };
        lastDecision: string;
        decisionTrace: string[];
      };
    }>;
  };
};

type Report = {
  profile: string;
  configuration: Record<string, unknown>;
  authority: Record<string, string>;
  compute: { summedWorkerWallClockMs: number };
  summary: Record<string, unknown>;
  runs: Run[];
};

const files = {
  baseline: "simulation-analysis-baseline-1000.json",
  contractPriority: "simulation-analysis-contract-priority-1000.json",
  bountyClaim: "simulation-analysis-bounty-claim-1000.json",
  contractBounty: "simulation-analysis-contract-bounty-1000.json",
  credit5001: "simulation-analysis-credit-5001-1000.json",
  credit5100: "simulation-analysis-credit-5100-1000.json",
  credit5250: "simulation-analysis-credit-5250-1000.json",
  credit5500: "simulation-analysis-credit-5500-1000.json",
  credit6000: "simulation-analysis-credit-6000-1000.json",
  credit6250: "simulation-analysis-credit-6250-1000.json",
  credit7500: "simulation-analysis-credit-7500-1000.json",
  credit10000: "simulation-analysis-credit-10000-1000.json",
  credit12500: "simulation-analysis-credit-12500-1000.json",
  credit15000: "simulation-analysis-credit-15000-1000.json",
  credit25000: "simulation-analysis-credit-25000-1000.json",
  creditOneBillion: "simulation-analysis-high-credit-1000.json",
  supplyWood: "simulation-analysis-supply-wood-1000.json",
  supplyFire: "simulation-analysis-supply-fire-1000.json",
  supplyBoth: "simulation-analysis-supply-both-1000.json",
} as const;

const outputDirectory = path.resolve("output");
const reports = {} as Record<keyof typeof files, Report>;
const fileHashes = {} as Record<keyof typeof files, string>;
for (const [name, filename] of Object.entries(files) as Array<[keyof typeof files, string]>) {
  const bytes = await readFile(path.join(outputDirectory, filename));
  reports[name] = JSON.parse(bytes.toString("utf8"));
  fileHashes[name] = createHash("sha256").update(bytes).digest("hex");
}

const expectedSeeds = Array.from({ length: 1000 }, (_, index) => index + 1);
for (const [name, report] of Object.entries(reports)) {
  const seeds = report.runs.map((run) => run.seed);
  if (JSON.stringify(seeds) !== JSON.stringify(expectedSeeds)) throw new Error(`${name}: seed coverage mismatch`);
}
const behaviorHashes = new Set(Object.values(reports).map((report) => report.authority.sharedBehaviorHash));
if (behaviorHashes.size !== 1) throw new Error("Shared behavior hash changed between experiments");

function strictPass(run: Run): boolean {
  return run.stage15.passed && run.stage15.nextItemEvidence?.craftedDuringObservation === 0;
}

function productionPass(run: Run): boolean {
  return run.stage15.itemEvidence.every((item) => item.stable)
    && run.stage15.nextItemEvidence?.craftedDuringObservation === 0;
}

function quantile(values: number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(probability * sorted.length) - 1))];
}

function experimentSummary(report: Report) {
  const failedMaterials = report.runs.flatMap((run) => run.stage15.materialCoverage.filter((entry) => !entry.passed));
  const hardFrozenRuns = report.runs.filter((run) => run.stage15.frozenEconomy.stalledContracts.length > 0);
  const debts = report.runs.map((run) => run.finalState.totalDebtCents);
  return {
    profile: report.profile,
    intervention: report.configuration.diagnosticIntervention,
    stage10FirstCrafted: report.runs.filter((run) => run.stage10Ramp.reached).length,
    stage10StrictStable: report.runs.filter((run) => run.stage10.passed
      && run.stage10.nextItemEvidence?.craftedDuringObservation === 0).length,
    stage15FirstCrafted: report.runs.filter((run) => run.stage15Ramp.reached).length,
    stage15ProductionStable: report.runs.filter(productionPass).length,
    stage15StrictStable: report.runs.filter(strictPass).length,
    hardFrozenSeeds: hardFrozenRuns.length,
    stalledContracts: hardFrozenRuns.reduce((sum, run) => sum + run.stage15.frozenEconomy.stalledContracts.length, 0),
    materialFailureSeeds: report.runs.filter((run) => run.stage15.materialCoverage.some((entry) => !entry.passed)).length,
    materialFailureItems: Object.fromEntries([...new Set(failedMaterials.map((entry) => entry.itemId))].sort().map((itemId) => [
      itemId,
      failedMaterials.filter((entry) => entry.itemId === itemId).length,
    ])),
    debtCents: {
      median: quantile(debts, 0.5),
      p95: quantile(debts, 0.95),
      max: quantile(debts, 1),
    },
    summedWorkerWallClockMs: report.compute.summedWorkerWallClockMs,
  };
}

function paired(left: Report, right: Report, predicate = strictPass) {
  const result = { bothPass: 0, leftOnly: 0, rightOnly: 0, bothFail: 0 };
  for (let index = 0; index < left.runs.length; index += 1) {
    const leftPass = predicate(left.runs[index]);
    const rightPass = predicate(right.runs[index]);
    if (leftPass && rightPass) result.bothPass += 1;
    else if (leftPass) result.leftOnly += 1;
    else if (rightPass) result.rightOnly += 1;
    else result.bothFail += 1;
  }
  return result;
}

function splitPasses(report: Report, start: number, end: number): number {
  return report.runs.filter((run) => run.seed >= start && run.seed <= end && strictPass(run)).length;
}

function materialDistribution(report: Report, itemId: string, start: number, end: number) {
  const rows = report.runs.filter((run) => run.seed >= start && run.seed <= end)
    .map((run) => run.stage15.materialCoverage.find((entry) => entry.itemId === itemId))
    .filter((entry): entry is Material => Boolean(entry && !entry.passed));
  const ratios = rows.map((entry) => entry.consumed / Math.max(1, entry.crafted));
  return {
    failures: rows.length,
    craftedMedian: quantile(rows.map((entry) => entry.crafted), 0.5),
    consumedMedian: quantile(rows.map((entry) => entry.consumed), 0.5),
    uncoveredMedian: quantile(rows.map((entry) => entry.uncoveredConsumption), 0.5),
    uncoveredP95: quantile(rows.map((entry) => entry.uncoveredConsumption), 0.95),
    consumptionToCraftRatioMedian: quantile(ratios, 0.5),
    consumptionToCraftRatioP95: quantile(ratios, 0.95),
    worstStockChange: quantile(rows.map((entry) => entry.stockChange), 0),
  };
}

const baselineContracts = reports.baseline.runs.flatMap((run) => run.stage15.frozenEconomy.stalledContracts);
const experiments = Object.fromEntries(Object.entries(reports).map(([name, report]) => [name, experimentSummary(report)]));
const creditNames = [
  "baseline", "credit5001", "credit5100", "credit5250", "credit5500", "credit6000",
  "credit6250", "credit7500", "credit10000", "credit12500", "credit15000", "credit25000",
  "creditOneBillion",
] as const;

const result = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  authority: {
    sharedBehaviorHash: [...behaviorHashes][0],
    experimentFileSha256: fileHashes,
    sourceHashesByExperiment: Object.fromEntries(Object.entries(reports).map(([name, report]) => [name, {
      lawProgramSha256: report.authority.lawProgramSha256,
      localPlannerSha256: report.authority.localPlannerSha256,
      lawInterpreterSha256: report.authority.lawInterpreterSha256,
      starterScenarioSha256: report.authority.starterScenarioSha256,
      catalogSha256: report.authority.catalogSha256,
      marketSha256: report.authority.marketSha256,
      engineSha256: report.authority.engineSha256,
    }])),
  },
  protocol: reports.baseline.configuration,
  experiments,
  pairedAgainstBaseline: {
    contractPriority: paired(reports.baseline, reports.contractPriority),
    bountyClaim: paired(reports.baseline, reports.bountyClaim),
    contractBounty: paired(reports.baseline, reports.contractBounty),
    credit5500: paired(reports.baseline, reports.credit5500),
  },
  creditSweep: creditNames.map((name) => ({ name, ...experiments[name] })),
  stalledContractEvidence: {
    seedCount: reports.baseline.runs.filter((run) => run.stage15.frozenEconomy.stalledContracts.length > 0).length,
    contractCount: baselineContracts.length,
    items: Object.fromEntries([...new Set(baselineContracts.map((entry) => entry.itemId))].sort().map((itemId) => [
      itemId,
      baselineContracts.filter((entry) => entry.itemId === itemId).length,
    ])),
    holderIds: Object.fromEntries([...new Set(baselineContracts.map((entry) => entry.holder?.id ?? "missing"))].sort().map((holderId) => [
      holderId,
      baselineContracts.filter((entry) => (entry.holder?.id ?? "missing") === holderId).length,
    ])),
    holderActions: Object.fromEntries([...new Set(baselineContracts.map((entry) => entry.holder?.action?.type ?? "idle"))].sort().map((action) => [
      action,
      baselineContracts.filter((entry) => (entry.holder?.action?.type ?? "idle") === action).length,
    ])),
    invalidAfterContractTrace: baselineContracts.filter((entry) => entry.holder?.decisionTrace.some((line) => line.includes("履行有偿运输合同"))
      && entry.holder?.lastDecision.includes("动作失效")).length,
  },
  materialCalibration: {
    sourceExperiment: "credit5500",
    calibrationSeeds: [1, 500],
    validationSeeds: [501, 1000],
    calibration: Object.fromEntries(["wood", "fire", "plank", "metal"].map((itemId) => [
      itemId,
      materialDistribution(reports.credit5500, itemId, 1, 500),
    ])),
    validation: Object.fromEntries(["wood", "fire", "plank", "metal"].map((itemId) => [
      itemId,
      materialDistribution(reports.credit5500, itemId, 501, 1000),
    ])),
    testedFeedback: {
      woodPrevious: 1.4,
      woodCalibrationRatioP95: materialDistribution(reports.credit5500, "wood", 1, 500).consumptionToCraftRatioP95,
      woodTested: 1.690909090909091,
      firePrevious: 2.1,
      fireCalibrationRatioP95: materialDistribution(reports.credit5500, "fire", 1, 500).consumptionToCraftRatioP95,
      fireTested: 2.95,
    },
  },
  supplyAblation: Object.fromEntries(["credit5500", "supplyWood", "supplyFire", "supplyBoth"].map((name) => [name, {
    allSeeds: experiments[name],
    calibrationStrictPasses: splitPasses(reports[name], 1, 500),
    validationStrictPasses: splitPasses(reports[name], 501, 1000),
    pairedAgainstCredit5500: paired(reports.credit5500, reports[name]),
  }])),
};

const outputPath = path.join(outputDirectory, "simulation-analysis-counterfactual-summary.json");
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, sharedBehaviorHash: result.authority.sharedBehaviorHash, experiments: Object.keys(experiments).length }, null, 2)}\n`);
