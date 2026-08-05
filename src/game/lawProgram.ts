import { hashSource } from "./lawInterpreter.js";
import type { CatAction, LawProgram, LawRuntimePolicy, LawVersion } from "./types.js";

export interface SharedScoreAdjustment {
  actionType: "craft" | "pass" | "*";
  itemId: string | "*";
  multiplier: number;
  bonus: number;
}

export interface InterpretedLaw {
  action: CatAction;
  error?: string;
  adjustments: SharedScoreAdjustment[];
  selectorRequested: boolean;
  policyTouched: boolean;
}

export interface SharedLawLoopResult {
  adjustments: SharedScoreAdjustment[];
  selectorRequested: boolean;
  selectorLawId: string;
  direct?: { action: Exclude<CatAction, null>; lawId: string };
  trace: string[];
}

export const DEFAULT_LAW_POLICY: Readonly<LawRuntimePolicy> = Object.freeze({
  priceMultipliers: Object.freeze({}) as Record<string, number>,
  priceAdditionsCents: Object.freeze({}) as Record<string, number>,
  creditBaseCents: 0,
  creditNetWorthFactor: 0,
  bountyMultiplier: 1,
  bountyMultiplierSet: false,
});

export function freshLawPolicy(): LawRuntimePolicy {
  return {
    priceMultipliers: {},
    priceAdditionsCents: {},
    creditBaseCents: 0,
    creditNetWorthFactor: 0,
    bountyMultiplier: 1,
    bountyMultiplierSet: false,
  };
}

/**
 * Build-independent authority manifest for the one shared law loop.
 *
 * `Function#toString()` is intentionally not used for integrity checks: tsx,
 * TypeScript and Vite are all allowed to print the same function differently.
 * These values are consumed by the runtime below, so the fingerprint describes
 * executable control-flow parameters rather than a decorative source copy.
 */
export const SHARED_BEHAVIOR_PROTOCOL = Object.freeze({
  id: "cat-workshop/shared-law-loop",
  version: 3,
  activeStatus: "active" as const,
  quarantinedStatus: "quarantined" as const,
  quarantineAfterFaults: 3,
  directActionMode: "first-valid" as const,
  adjustmentMode: "accumulate-all" as const,
  selectorMode: "request-once-after-loop" as const,
});

function canonicalSharedBehaviorSource(): string {
  const protocol = SHARED_BEHAVIOR_PROTOCOL;
  return [
    `${protocol.id}/v${protocol.version}`,
    `active-status=${protocol.activeStatus}`,
    `quarantined-status=${protocol.quarantinedStatus}`,
    `quarantine-after-faults=${protocol.quarantineAfterFaults}`,
    `direct-action=${protocol.directActionMode}`,
    `adjustments=${protocol.adjustmentMode}`,
    `selector=${protocol.selectorMode}`,
  ].join("\n");
}

/**
 * The sole lawbook loop used by the simulation. Every active source program
 * passes through this exact function; there is no price/credit side path.
 */
export function runSharedLawLoop(
  laws: readonly LawVersion[],
  interpret: (law: LawVersion) => InterpretedLaw,
  validate: (action: Exclude<CatAction, null>) => string | null,
): SharedLawLoopResult {
  const policy: SharedLawLoopResult = {
    adjustments: [],
    selectorRequested: false,
    selectorLawId: "",
    trace: [],
  };
  for (const law of laws) {
    if (law.status !== SHARED_BEHAVIOR_PROTOCOL.activeStatus) continue;
    const result = interpret(law);
    if (result.error) {
      law.invalidCount += 1;
      law.consecutiveFaults += 1;
      policy.trace.push(`《${law.title}》异常：${result.error}`);
      if (law.consecutiveFaults >= SHARED_BEHAVIOR_PROTOCOL.quarantineAfterFaults) {
        law.status = SHARED_BEHAVIOR_PROTOCOL.quarantinedStatus;
        policy.trace.push(`《${law.title}》连续异常，已隔离`);
      }
      continue;
    }
    policy.adjustments.push(...result.adjustments);
    if (result.selectorRequested) {
      policy.selectorRequested = true;
      if (!policy.selectorLawId) policy.selectorLawId = law.id;
    }
    let hit = result.adjustments.length > 0 || result.selectorRequested || result.policyTouched;
    if (result.action && SHARED_BEHAVIOR_PROTOCOL.directActionMode === "first-valid" && !policy.direct) {
      const invalid = validate(result.action);
      if (invalid) {
        law.invalidCount += 1;
        law.consecutiveFaults += 1;
        policy.trace.push(`《${law.title}》跳过：${invalid}`);
      } else {
        policy.direct = { action: result.action, lawId: law.id };
        policy.trace.push(`《${law.title}》提出首个合法直接动作`);
        hit = true;
      }
    }
    if (hit) {
      law.hitCount += 1;
      law.consecutiveFaults = 0;
    }
  }
  return policy;
}

// The displayed and audited hash is stable across Node, Vite and Electron.
// The loop above reads the same protocol fields while making its decisions.
export const SHARED_BEHAVIOR_SOURCE = canonicalSharedBehaviorSource();
export const SHARED_BEHAVIOR_HASH = hashSource(SHARED_BEHAVIOR_SOURCE);

export function decisionCapabilities(sourceCode: string): string[] {
  const capabilities: string[] = [];
  if (/\btype\s*:\s*["'](?:craft|pass)["']/.test(sourceCode)) capabilities.push("direct-action");
  if (/\badjust\s*\(/.test(sourceCode)) capabilities.push("score-adjustment");
  if (/\b(?:choose|earnCoins|weighted)\s*\(/.test(sourceCode)) capabilities.push("selector");
  if (/\b(?:setPrice|addPrice)\s*\(/.test(sourceCode)) capabilities.push("price");
  if (/\bsetCredit\s*\(/.test(sourceCode)) capabilities.push("credit");
  if (/\bsetBounty\s*\(/.test(sourceCode)) capabilities.push("bounty");
  return capabilities;
}

export function programForDecisionSource(_sourceCode: string): LawProgram {
  return { version: 2 };
}

export function lawProgramSummary(_program: LawProgram, sourceCode = ""): string {
  const capabilities = decisionCapabilities(sourceCode);
  return capabilities.length > 0 ? `统一源码：${capabilities.join("、")}` : "统一源码法规";
}

export function normalizeProgram(_input: unknown, _sourceCode: string): LawProgram {
  return { version: 2 };
}

/** Convert schema-10 categorized effects once, during save migration only. */
export function appendLegacyEffects(sourceCode: string, input: unknown): string {
  if (!input || typeof input !== "object" || !Array.isArray((input as { effects?: unknown[] }).effects)) return sourceCode;
  const statements: string[] = [];
  for (const raw of (input as { effects: Array<Record<string, unknown>> }).effects) {
    if (raw.kind === "price" && typeof raw.itemId === "string" && Number.isFinite(raw.multiplier)) {
      statements.push(`setPrice(${JSON.stringify(raw.itemId)}, ${Number(raw.multiplier)});`);
    } else if (raw.kind === "credit" && Number.isFinite(raw.baseCents) && Number.isFinite(raw.netWorthFactor)) {
      statements.push(`setCredit(${Number(raw.baseCents)}, ${Number(raw.netWorthFactor)});`);
    } else if (raw.kind === "discovery-bounty" && Number.isFinite(raw.multiplier)) {
      statements.push(`setBounty(${Number(raw.multiplier)});`);
    }
  }
  if (statements.length === 0) return sourceCode;
  const closing = sourceCode.lastIndexOf("}");
  if (closing < 0) return sourceCode;
  return `${sourceCode.slice(0, closing)}  ${statements.join("\n  ")}\n${sourceCode.slice(closing)}`;
}
