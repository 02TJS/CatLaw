import dotenv from "dotenv";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createCatWorkshopApp } from "../server/app";
import { hashSource } from "../src/game/lawInterpreter";
import { SHARED_BEHAVIOR_HASH, SHARED_BEHAVIOR_SOURCE } from "../src/game/lawProgram";
import { createStarterScenario } from "../src/game/starterScenario";
import type { LawDraft } from "../src/game/types";
import { DEEPSEEK_ACCEPTANCE_CASES, validateAcceptanceDraft } from "./deepseek-to-35-cases.mjs";

dotenv.config({ quiet: true });

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) throw new Error("DEEPSEEK_API_KEY 未配置；实时验收没有运行");

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const nativeFetch = globalThis.fetch;
const upstreamAttempts: Array<Record<string, unknown>> = [];
let activeCaseId = "startup";
let upstreamSequence = 0;

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== "https://api.deepseek.com/chat/completions") return nativeFetch(input, init);
  const sequence = ++upstreamSequence;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const requestBodyText = String(init?.body ?? "");
  let requestBody: unknown = null;
  try { requestBody = JSON.parse(requestBodyText); } catch { requestBody = { parseError: true, sha256: sha256(requestBodyText) }; }
  try {
    const response = await nativeFetch(input, init);
    const rawResponse = await response.clone().text();
    upstreamAttempts.push({
      sequence,
      caseId: activeCaseId,
      startedAt,
      durationMs: Math.round(performance.now() - started),
      status: response.status,
      ok: response.ok,
      request: { url, headers: { "Content-Type": "application/json", Authorization: "Bearer [REDACTED]" }, body: requestBody },
      rawResponse,
      error: null,
    });
    return response;
  } catch (error) {
    upstreamAttempts.push({
      sequence,
      caseId: activeCaseId,
      startedAt,
      durationMs: Math.round(performance.now() - started),
      status: null,
      ok: false,
      request: { url, headers: { "Content-Type": "application/json", Authorization: "Bearer [REDACTED]" }, body: requestBody },
      rawResponse: null,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

const sourceBefore = SHARED_BEHAVIOR_SOURCE;
const hashBefore = SHARED_BEHAVIOR_HASH;
const runtimeHashBefore = hashSource(SHARED_BEHAVIOR_SOURCE);
const starter = createStarterScenario(1, 5);
const existingLaws = starter.laws.map((law) => ({
  id: law.id,
  title: law.title,
  summary: law.summary,
  program: law.program,
  status: law.status,
}));

const app = createCatWorkshopApp({ webDist: "dist", apiKey });
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});

const port = (server.address() as AddressInfo).port;
const baseUrl = `http://127.0.0.1:${port}`;
const runStartedAt = new Date().toISOString();
const runStarted = performance.now();
const results: Array<Record<string, unknown>> = [];

try {
  const health = await nativeFetch(`${baseUrl}/api/health`).then(async (response) => ({ status: response.status, body: await response.json() }));
  if (health.status !== 200 || !(health.body as { configured?: boolean }).configured) throw new Error("编译服务未报告已配置DeepSeek");

  for (const [index, testCase] of DEEPSEEK_ACCEPTANCE_CASES.entries()) {
    activeCaseId = testCase.id;
    const requestBody = {
      text: testCase.playerText,
      existingLaws,
      sharedBehavior: { sourceCode: SHARED_BEHAVIOR_SOURCE, astHash: SHARED_BEHAVIOR_HASH },
    };
    const startedAt = new Date().toISOString();
    const started = performance.now();
    let status: number | null = null;
    let responseBody: unknown = null;
    let draft: LawDraft | null = null;
    const failures: string[] = [];
    try {
      const response = await nativeFetch(`${baseUrl}/api/laws/compile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      status = response.status;
      responseBody = await response.json();
      if (!response.ok) failures.push(`HTTP ${response.status}`);
      else {
        draft = responseBody as LawDraft;
        failures.push(...validateAcceptanceDraft(testCase, draft));
        if (draft.astHash !== hashSource(draft.sourceCode)) failures.push("源码哈希与astHash不一致");
        if (draft.compileAudit?.model !== "deepseek-v4-flash") failures.push("模型别名不是deepseek-v4-flash");
        if (draft.compileAudit?.sharedBehaviorHash !== hashBefore) failures.push("编译审计中的共享behavior哈希变化");
        if ((draft.compileAudit?.attempts ?? 0) < 1 || (draft.compileAudit?.attempts ?? 0) > 2) failures.push("重试次数不在1—2次范围");
        if (SHARED_BEHAVIOR_SOURCE !== sourceBefore || SHARED_BEHAVIOR_HASH !== hashBefore || hashSource(SHARED_BEHAVIOR_SOURCE) !== runtimeHashBefore) {
          failures.push("编译前后共享behavior源码或运行时哈希变化");
        }
        if (failures.length === 0) existingLaws.push({
          id: `live-draft-${index + 1}`,
          title: draft.title,
          summary: draft.summary,
          program: draft.program,
          status: "active",
        });
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    const caseAttempts = upstreamAttempts.filter((attempt) => attempt.caseId === testCase.id);
    results.push({
      index: index + 1,
      id: testCase.id,
      purpose: testCase.purpose,
      mode: testCase.mode,
      playerPrompt: testCase.playerText,
      compileRequest: requestBody,
      startedAt,
      durationMs: Math.round(performance.now() - started),
      httpStatus: status,
      upstreamAttemptSequences: caseAttempts.map((attempt) => attempt.sequence),
      retries: Math.max(0, caseAttempts.length - 1),
      responseBody,
      parsedDraft: draft,
      validationFailures: failures,
      passed: failures.length === 0,
      sharedBehavior: {
        sourceBeforeSha256: sha256(sourceBefore),
        sourceAfterSha256: sha256(SHARED_BEHAVIOR_SOURCE),
        declaredHashBefore: hashBefore,
        declaredHashAfter: SHARED_BEHAVIOR_HASH,
        runtimeHashBefore,
        runtimeHashAfter: hashSource(SHARED_BEHAVIOR_SOURCE),
        unchanged: sourceBefore === SHARED_BEHAVIOR_SOURCE && hashBefore === SHARED_BEHAVIOR_HASH,
      },
    });
  }

  const audit = {
    schema: "deepseek-to-35-live-v1",
    generatedAt: new Date().toISOString(),
    runStartedAt,
    wallClockMs: Math.round(performance.now() - runStarted),
    executionMode: "Express compile API only; no Vite, Canvas, Electron, game simulation or save store",
    model: "deepseek-v4-flash",
    secretHandling: "DEEPSEEK_API_KEY loaded from local process/.env; never serialized; Authorization redacted",
    expectedPrimaryCalls: 7,
    primaryCalls: results.length,
    upstreamAttempts: upstreamAttempts.length,
    maxAllowedAttempts: 14,
    sharedBehaviorSource: SHARED_BEHAVIOR_SOURCE,
    sharedBehaviorHash: SHARED_BEHAVIOR_HASH,
    passed: results.length === 7 && results.every((result) => result.passed) && upstreamAttempts.length <= 14,
    results,
    attempts: upstreamAttempts,
  };
  await mkdir("output", { recursive: true });
  await writeFile("output/deepseek-to-35-live.json", `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    passed: audit.passed,
    model: audit.model,
    primaryCalls: audit.primaryCalls,
    upstreamAttempts: audit.upstreamAttempts,
    wallClockMs: audit.wallClockMs,
    cases: results.map((result) => ({ id: result.id, passed: result.passed, durationMs: result.durationMs, failures: result.validationFailures })),
  }, null, 2)}\n`);
  if (!audit.passed) process.exitCode = 1;
} finally {
  globalThis.fetch = nativeFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
