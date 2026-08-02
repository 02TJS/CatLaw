import type { GameState, LawDraft } from "./game/types";
import { validateDraftInWorker } from "./game/lawWorkerClient";

export async function compileLaw(text: string, state: GameState): Promise<LawDraft> {
  const response = await fetch("/api/laws/compile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      existingLaws: state.laws.filter((law) => law.category !== "system")
        .map((law) => ({ title: law.title, summary: law.summary, category: law.category })),
    }),
  });
  const body = await response.json() as LawDraft | { error: string };
  if (!response.ok || "error" in body) throw new Error("error" in body ? body.error : "法条编译失败");
  return validateDraftInWorker(body);
}
