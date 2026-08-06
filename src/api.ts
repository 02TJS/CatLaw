import type { GameState, LawDraft } from "./game/types";
import { recordPlayerCommand } from "./game/engine";
import { SHARED_BEHAVIOR_HASH, SHARED_BEHAVIOR_SOURCE } from "./game/lawProgram";
import { validateDraftInWorker } from "./game/lawWorkerClient";
import { landmarkDisplayName } from "./game/landmarks";

export interface DeepSeekStatus {
  ok: true;
  model: string;
  configured: boolean;
  keyStorage: "secure-local" | "session";
}

export interface DeepSeekKeyResult {
  ok: true;
  configured: true;
  persisted: boolean;
}

async function apiJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T | { error?: string };
  if (!response.ok) {
    throw new Error((body as { error?: string }).error || `本地服务请求失败（${response.status}）`);
  }
  return body as T;
}

export async function getDeepSeekStatus(): Promise<DeepSeekStatus> {
  return apiJson<DeepSeekStatus>(await fetch("/api/health", { cache: "no-store" }));
}

export async function setDeepSeekApiKey(apiKey: string): Promise<DeepSeekKeyResult> {
  return apiJson<DeepSeekKeyResult>(await fetch("/api/settings/deepseek-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  }));
}

export async function compileLaw(text: string, state: GameState): Promise<LawDraft> {
  const behaviorHashBefore = SHARED_BEHAVIOR_HASH;
  try {
    const response = await fetch("/api/laws/compile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        existingLaws: state.laws.map((law) => ({
          id: law.id,
          title: law.title,
          summary: law.summary,
          program: law.program,
          status: law.status,
        })),
        sharedBehavior: { sourceCode: SHARED_BEHAVIOR_SOURCE, astHash: SHARED_BEHAVIOR_HASH },
        landmarks: state.landmarks.map((landmark) => ({
          name: landmarkDisplayName(landmark),
          position: landmark.position,
          kind: landmark.landmarkId === null ? "marker" : "engineered",
        })),
      }),
    });
    const body = await response.json() as LawDraft | { error: string };
    if (!response.ok || "error" in body) throw new Error("error" in body ? body.error : "法条编译失败");
    if (behaviorHashBefore !== SHARED_BEHAVIOR_HASH || body.compileAudit?.sharedBehaviorHash !== SHARED_BEHAVIOR_HASH) {
      throw new Error("共享behavior完整性校验失败");
    }
    const validated = await validateDraftInWorker(body);
    recordPlayerCommand(state, "compile-law", text.slice(0, 120), validated.validation.safety,
      validated.compileAudit ? `${validated.compileAudit.model}:${validated.compileAudit.durationMs}ms` : "local");
    return validated;
  } catch (error) {
    recordPlayerCommand(state, "compile-law", text.slice(0, 120), false, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
