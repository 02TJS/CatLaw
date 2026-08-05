import { mkdir, readFile, writeFile } from "node:fs/promises";

const sourcePath = "output/deepseek-to-35-headless.json";
const outputPath = "output/deepseek-to-35-browser.json";
const startedAt = new Date().toISOString();
const wallStarted = performance.now();

let headless;
try {
  headless = JSON.parse(await readFile(sourcePath, "utf8"));
} catch (error) {
  headless = null;
  const audit = {
    schema: "deepseek-to-35-browser-gate-v1",
    generatedAt: new Date().toISOString(),
    startedAt,
    passed: false,
    status: "blocked-missing-headless-audit",
    openedGame: false,
    apiCalls: 0,
    wallClockMs: Math.round(performance.now() - wallStarted),
    reason: `先运行 npm run test:progression:headless：${error instanceof Error ? error.message : String(error)}`,
  };
  await mkdir("output", { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  process.stderr.write(`${audit.reason}\n`);
  process.exitCode = 1;
}

if (headless) {
  const failedSeed = headless.seedResults?.find((entry) => !entry.passed);
  const failedStage = failedSeed?.stages?.find((entry) => !entry.passed);
  const audit = {
    schema: "deepseek-to-35-browser-gate-v1",
    generatedAt: new Date().toISOString(),
    startedAt,
    passed: false,
    status: headless.passed ? "browser-replay-not-yet-run" : "blocked-by-headless-progression",
    openedGame: false,
    apiCalls: 0,
    wallClockMs: Math.round(performance.now() - wallStarted),
    prerequisite: {
      path: sourcePath,
      passed: headless.passed === true,
      sourceMode: headless.sourceMode,
      target: headless.target,
      seed: failedSeed?.seed ?? 1,
      failedStage: failedStage?.name ?? null,
      failureReasons: failedStage?.stability?.failureReasons ?? [],
    },
    reason: headless.passed
      ? "无界面门禁已通过；必须由真实 UI 重放器完成后才能把浏览器阶段标为通过。"
      : "无界面稳定产出门禁未通过，按验收顺序不打开游戏、不调用 DeepSeek，也不执行后续 UI 阶段。",
  };
  await mkdir("output", { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  process.exitCode = 1;
}
