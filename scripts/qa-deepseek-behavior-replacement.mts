import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { compileLaw } from "../server/lawCompiler";
import { createInitialState, enactLaw } from "../src/game/engine";
import { executeLawSource, hashSource, MAX_LAW_EXECUTION_STEPS, validateLawSource } from "../src/game/lawInterpreter";
import { SHARED_BEHAVIOR_HASH, SHARED_BEHAVIOR_SOURCE } from "../src/game/lawProgram";
import type { CatAction, CatObservation } from "../src/game/types";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is missing; no request was sent");

const state = createInitialState({ worldSeed: 1, difficulty: 5 });
const playerText = "合同货物绝对优先逐跳运送；听到订单时提高有偿传递和制作评分；存在首次发现悬赏时提高制作评分；最后按正常贪心候选选择。";
const sourceBefore = SHARED_BEHAVIOR_SOURCE;
const hashBefore = SHARED_BEHAVIOR_HASH;
const existingLaws = state.laws.map(({ id, title, summary, program, status }) => ({ id, title, summary, program, status }));
const startedAt = new Date().toISOString();
const started = performance.now();

let report: Record<string, unknown>;
try {
  const draft = await compileLaw({
    text: playerText,
    existingLaws,
    sharedBehavior: { sourceCode: sourceBefore, astHash: hashBefore },
  }, apiKey, { maxAttempts: 1 });
  const checked = validateLawSource(draft.sourceCode);
  const adjustments: Array<{ actionType: string; itemId: string; multiplier: number; bonus: number }> = [];
  const fallbackAction: Exclude<CatAction, null> = { type: "craft", recipeId: "make_wood" };
  const observation: CatObservation = {
    position: { x: 0, y: 0 }, inventory: {},
    neighbors: { north: null, east: null, south: null, west: null }, nearby: [],
    site: { resourceItemId: "wood", resourceItemIds: ["wood"], buildingItemId: null },
    wallet: { cashCents: 0, debtCents: 0, netWorthCents: 0, creditAvailableCents: 5_000 },
    heardOrders: [{ id: "order-1", itemId: "metal", effectiveBidCents: 1_200, sourceCatId: "cat-1" }],
    heardBounties: [{ itemId: "magnet", amountCents: 3_800, sourceCatId: "cat-0" }],
    heardBuildingOffers: [], broadcasts: [], carrying: null, ownPlan: null,
    discoveryBounties: [{ itemId: "magnet", amountCents: 3_800, claimedBySelf: false }],
  };
  const decision = executeLawSource(draft.sourceCode, observation, MAX_LAW_EXECUTION_STEPS, {
    adjust: (actionType, itemId, multiplier, bonus) => adjustments.push({ actionType, itemId, multiplier, bonus }),
    choose: () => fallbackAction,
    earnCoins: () => fallbackAction,
  });
  const carryingDecision = executeLawSource(draft.sourceCode, {
    ...observation,
    carrying: { contractId: "contract-1", itemId: "wood", nextDirection: "east" },
  }, MAX_LAW_EXECUTION_STEPS, { choose: () => fallbackAction, earnCoins: () => fallbackAction });
  const temporaryState = structuredClone(state);
  const enacted = enactLaw(temporaryState, draft);
  const installed = enacted.ok ? temporaryState.laws.find((law) => law.id === enacted.law?.id) : undefined;
  const authorityUnchanged = sourceBefore === SHARED_BEHAVIOR_SOURCE
    && hashBefore === SHARED_BEHAVIOR_HASH
    && hashSource(SHARED_BEHAVIOR_SOURCE) === SHARED_BEHAVIOR_HASH;
  const accepted = Boolean(
    checked.ok && draft.validation.syntax && draft.validation.safety
    && decision.error === undefined && carryingDecision.error === undefined
    && enacted.ok && installed?.sourceCode === draft.sourceCode && authorityUnchanged
  );
  report = {
    startedAt,
    elapsedMs: Math.round(performance.now() - started),
    modelAlias: "deepseek-v4-flash",
    executionMode: "one DeepSeek request; temporary in-memory enactment; no save changed",
    input: { playerText, sharedBehaviorHash: hashBefore },
    output: { title: draft.title, summary: draft.summary, sourceCode: draft.sourceCode, astHash: draft.astHash, warnings: draft.warnings, validation: draft.validation },
    unifiedProgramAssessment: { accepted, program: draft.program, decision, adjustments, carryingDecision, enacted: enacted.ok, installedExactSource: installed?.sourceCode === draft.sourceCode, authorityUnchanged },
  };
} catch (error) {
  report = {
    startedAt,
    elapsedMs: Math.round(performance.now() - started),
    modelAlias: "deepseek-v4-flash",
    executionMode: "one DeepSeek request; no save changed",
    input: { playerText, sharedBehaviorHash: hashBefore },
    error: error instanceof Error ? error.message : String(error),
    unifiedProgramAssessment: { accepted: false },
  };
}

await mkdir("output", { recursive: true });
await writeFile("output/deepseek-unified-law-audit.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
