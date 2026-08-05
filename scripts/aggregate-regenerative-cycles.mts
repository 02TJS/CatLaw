import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const inputDir = process.argv.find((argument) => argument.startsWith("--input-dir="))?.slice("--input-dir=".length)
  ?? "output/regenerative-cycles-200";
const outputPath = process.argv.find((argument) => argument.startsWith("--output="))?.slice("--output=".length)
  ?? "output/regenerative-cycles-200-aggregate.json";
const expectedCount = Number(process.argv.find((argument) => argument.startsWith("--expected-count="))?.slice("--expected-count=".length) ?? "200");

type Measurement = {
  schema: string;
  configuration: Record<string, unknown> & { seedRange: { start: number; count: number } };
  authority: Record<string, string>;
  runs: Array<{
    seed: number;
    stage10Ramp: { reached: boolean; logicalElapsedMs: number };
    stage10: StageMeasurement | null;
    blueprintResults: Array<{ ok: boolean }>;
    stage15Ramp: { reached: boolean; logicalElapsedMs: number };
    stage15: StageMeasurement | null;
  }>;
};

type StageMeasurement = {
  found: boolean;
  actualWindowMs: number | null;
  fluidLowerBoundMs: number | null;
  exactDiscretePeriodMs: number | null;
  certifiedLowerBoundMs: number | null;
  coordinationMultiplier: number | null;
  fluidRelaxationRatio: number | null;
  certificate: null | { actualActions: number };
  terminalFailure: null | {
    failureReasons: string[];
    stockFailures: Array<{ itemId: string }>;
  };
};

function quantiles(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const q = (probability: number) => {
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  };
  return {
    min: sorted[0],
    p05: q(0.05),
    median: q(0.5),
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p95: q(0.95),
    max: sorted.at(-1),
  };
}

function count(values: string[]): Record<string, number> {
  return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((entry) => entry === value).length]));
}

const filenames = (await readdir(inputDir)).filter((filename) => /^shard-\d+\.json$/.test(filename)).sort();
const documents: Measurement[] = [];
const shardHashes: Record<string, string> = {};
for (const filename of filenames) {
  const body = await readFile(path.join(inputDir, filename));
  shardHashes[filename] = createHash("sha256").update(body).digest("hex");
  documents.push(JSON.parse(body.toString("utf8")) as Measurement);
}
const runs = documents.flatMap((document) => document.runs).sort((left, right) => left.seed - right.seed);
const uniqueSeeds = new Set(runs.map((run) => run.seed));
if (runs.length !== expectedCount || uniqueSeeds.size !== expectedCount || runs[0]?.seed !== 1 || runs.at(-1)?.seed !== expectedCount) {
  throw new Error(`seed coverage mismatch: runs=${runs.length}, unique=${uniqueSeeds.size}, first=${runs[0]?.seed}, last=${runs.at(-1)?.seed}`);
}

const authorityKeys = Object.keys(documents[0]?.authority ?? {});
const authorityUnique = Object.fromEntries(authorityKeys.map((key) => [key, [...new Set(documents.map((document) => document.authority[key]))]]));
const mismatchedAuthority = Object.entries(authorityUnique).filter(([, values]) => values.length !== 1);
if (mismatchedAuthority.length) throw new Error(`authority mismatch: ${JSON.stringify(mismatchedAuthority)}`);

function stageAggregate(stage: 10 | 15) {
  const measurements = runs.map((run) => run[`stage${stage}`]).filter((entry): entry is StageMeasurement => Boolean(entry));
  const found = measurements.filter((entry) => entry.found);
  const failed = measurements.filter((entry) => !entry.found);
  const ramped = runs.filter((run) => run[`stage${stage}Ramp`].reached).length;
  return {
    ramped,
    rampFailures: runs.length - ramped,
    regenerativeWithinSearch: found.length,
    rightCensoredAtMaxWindow: failed.length,
    actualWindowMs: quantiles(found.flatMap((entry) => entry.actualWindowMs === null ? [] : [entry.actualWindowMs])),
    fluidLowerBoundMs: quantiles(measurements.flatMap((entry) => entry.fluidLowerBoundMs == null ? [] : [entry.fluidLowerBoundMs])),
    exactDiscretePeriodMs: quantiles(measurements.flatMap((entry) => entry.exactDiscretePeriodMs == null ? [] : [entry.exactDiscretePeriodMs])),
    certifiedLowerBoundMs: quantiles(measurements.flatMap((entry) => entry.certifiedLowerBoundMs == null ? [] : [entry.certifiedLowerBoundMs])),
    coordinationMultiplier: quantiles(found.flatMap((entry) => entry.coordinationMultiplier == null ? [] : [entry.coordinationMultiplier])),
    fluidRelaxationRatio: quantiles(found.flatMap((entry) => entry.fluidRelaxationRatio == null ? [] : [entry.fluidRelaxationRatio])),
    actualActionsToCertificate: quantiles(found.flatMap((entry) => entry.certificate ? [entry.certificate.actualActions] : [])),
    terminalFailureReasons: count(failed.flatMap((entry) => entry.terminalFailure?.failureReasons ?? [])),
    terminalStockFailures: count(failed.flatMap((entry) => entry.terminalFailure?.stockFailures.map((failure) => failure.itemId) ?? [])),
    failedSeeds: runs.filter((run) => !run[`stage${stage}`]?.found).map((run) => run.seed),
    rampFailedSeeds: runs.filter((run) => !run[`stage${stage}Ramp`].reached).map((run) => run.seed),
  };
}

const result = {
  schema: "cat-workshop-regenerative-cycle-aggregate-v1",
  generatedAt: new Date().toISOString(),
  source: { inputDir, shardCount: filenames.length, expectedCount, shardHashes },
  configuration: documents[0].configuration,
  authority: Object.fromEntries(Object.entries(authorityUnique).map(([key, values]) => [key, values[0]])),
  summary: {
    stage10: stageAggregate(10),
    stage15: stageAggregate(15),
    blueprintsPurchasedAll: runs.filter((run) => run.blueprintResults.every((entry) => entry.ok)).length,
  },
  runs,
};

await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, seeds: runs.length, summary: result.summary })}\n`);
