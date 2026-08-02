import { playSeed } from "./qa-35.mts";

const firstSeed = Number(process.argv[2] ?? 1);
const seedCount = Number(process.argv[3] ?? 20);
const maxMs = Number(process.argv[4] ?? 7_200_000);
const simulationSpeed = Number(process.argv[5] ?? 5_000);
const results: Array<{
  seed: number;
  passed: boolean;
  simTime: number;
  spentCents: number;
  discovered: number;
}> = [];

for (let seed = firstSeed; seed < firstSeed + seedCount; seed += 1) {
  const result = playSeed(seed, false, maxMs, simulationSpeed);
  const summary = {
    seed,
    passed: result.passed,
    simTime: result.simTime,
    spentCents: result.spentCents,
    discovered: result.discovered,
  };
  results.push(summary);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

const passed = results.filter((result) => result.passed).length;
const slowestMs = Math.max(...results.map((result) => result.simTime));
process.stdout.write(`${JSON.stringify({ passed, total: results.length, slowestMs })}\n`);
if (passed !== results.length) process.exitCode = 1;
