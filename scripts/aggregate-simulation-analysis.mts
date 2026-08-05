import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function argument(name: string, fallback: string): string {
  return process.argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

const inputDirectory = path.resolve(argument("--input-dir", "output/simulation-analysis-shards"));
const outputPath = path.resolve(argument("--output", "output/simulation-analysis-baseline-1000.json"));
const expectedSeedStart = Number(argument("--seed-start", "1"));
const expectedSeedCount = Number(argument("--seed-count", "1000"));
const filenames = (await readdir(inputDirectory)).filter((name) => name.endsWith(".json")).sort();
if (filenames.length === 0) throw new Error(`No JSON shards in ${inputDirectory}`);

const shards = await Promise.all(filenames.map(async (filename) => {
  const bytes = await readFile(path.join(inputDirectory, filename));
  return {
    filename,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    payload: JSON.parse(bytes.toString("utf8")),
  };
}));
const authorityKeys = new Set(shards.map((entry) => JSON.stringify(entry.payload.authority)));
const configurationKeys = new Set(shards.map((entry) => JSON.stringify(entry.payload.configuration)));
if (authorityKeys.size !== 1) throw new Error("Shard authority mismatch");
if (configurationKeys.size !== 1) throw new Error("Shard configuration mismatch");

const runs = shards.flatMap((entry) => entry.payload.runs).sort((left, right) => left.seed - right.seed);
const seeds = runs.map((run) => run.seed);
const expectedSeeds = Array.from({ length: expectedSeedCount }, (_, index) => expectedSeedStart + index);
if (JSON.stringify(seeds) !== JSON.stringify(expectedSeeds)) {
  throw new Error(`Seed coverage mismatch: got ${seeds.length}, expected ${expectedSeeds.length}`);
}

function countBy(values: string[]): Record<string, number> {
  return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((entry) => entry === value).length]));
}

function quantile(values: number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(probability * sorted.length) - 1))];
}

const stage10Failed = runs.filter((run) => !(run.stage10.passed && run.stage10.nextItemEvidence?.craftedDuringObservation === 0));
const stage15Failed = runs.filter((run) => !(run.stage15.passed && run.stage15.nextItemEvidence?.craftedDuringObservation === 0));
const unstableItems = stage15Failed.flatMap((run) => run.stage15.itemEvidence.filter((item) => !item.stable).map((item) => item.itemId));
const materialFailures = stage15Failed.flatMap((run) => run.stage15.materialCoverage.filter((item) => !item.passed).map((item) => item.itemId));
const stalledContractItems = stage15Failed.flatMap((run) => run.stage15.frozenEconomy.stalledContracts.map((contract) => contract.itemId));
const stalledContractHolderActions = stage15Failed.flatMap((run) => run.stage15.frozenEconomy.stalledContracts.map((contract) => (
  contract.holder?.action?.type ?? "idle"
)));
const stage15Reasons = stage15Failed.flatMap((run) => run.stage15.failureReasons.map((reason) => reason.split(":")[0]));

const result = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  sourceDirectory: inputDirectory,
  seedRange: { start: expectedSeedStart, count: expectedSeedCount },
  profile: shards[0].payload.profile,
  configuration: shards[0].payload.configuration,
  authority: shards[0].payload.authority,
  compute: {
    shards: shards.length,
    summedWorkerWallClockMs: shards.reduce((sum, entry) => sum + entry.payload.wallClockMs, 0),
    shardFiles: shards.map(({ filename, sha256 }) => ({ filename, sha256 })),
  },
  summary: {
    stage10Reached: runs.filter((run) => run.stage10Ramp.reached).length,
    stage10Stable: expectedSeedCount - stage10Failed.length,
    stage10FailedSeeds: stage10Failed.map((run) => run.seed),
    blueprintsPurchased: runs.filter((run) => run.blueprintResults.every((entry) => entry.ok)).length,
    stage15Reached: runs.filter((run) => run.stage15Ramp.reached).length,
    stage15Stable: expectedSeedCount - stage15Failed.length,
    stage15FailedSeeds: stage15Failed.map((run) => run.seed),
    stage15FailureKinds: countBy(stage15Reasons),
    stage15UnstableItems: countBy(unstableItems),
    stage15MaterialFailures: countBy(materialFailures),
    stage15StalledContractItems: countBy(stalledContractItems),
    stage15StalledContractHolderActions: countBy(stalledContractHolderActions),
    stage10RampLogicalMs: {
      min: Math.min(...runs.map((run) => run.stage10Ramp.logicalElapsedMs)),
      median: quantile(runs.map((run) => run.stage10Ramp.logicalElapsedMs), 0.5),
      p95: quantile(runs.map((run) => run.stage10Ramp.logicalElapsedMs), 0.95),
      max: Math.max(...runs.map((run) => run.stage10Ramp.logicalElapsedMs)),
    },
    stage15RampLogicalMs: {
      min: Math.min(...runs.map((run) => run.stage15Ramp.logicalElapsedMs)),
      median: quantile(runs.map((run) => run.stage15Ramp.logicalElapsedMs), 0.5),
      p95: quantile(runs.map((run) => run.stage15Ramp.logicalElapsedMs), 0.95),
      max: Math.max(...runs.map((run) => run.stage15Ramp.logicalElapsedMs)),
    },
  },
  runs,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, ...result.summary }, null, 2)}\n`);
