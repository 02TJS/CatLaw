import type { LawDraft } from "./types";
import { validateLawDocumentation } from "./lawDocumentation";
import { validateSpeechTemplates } from "./speech";

export function validateDraftInWorker(draft: LawDraft): Promise<LawDraft> {
  const speechValidation = validateSpeechTemplates(draft.speechTemplates);
  const documentationValidation = validateLawDocumentation(draft.sourceCode);
  const explanationValid = Boolean(draft.explanation?.trim());
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./lawWorker.ts", import.meta.url), { type: "module", name: "cat-law-sandbox" });
    const timeout = window.setTimeout(() => {
      worker.terminate();
      resolve({
        ...draft,
        validation: { ...draft.validation, safety: false, messages: [...draft.validation.messages, "Worker 安全校验超时。"] },
      });
    }, 2_000);
    worker.onmessage = (event: MessageEvent<LawDraft["validation"] & { astHash: string }>) => {
      window.clearTimeout(timeout);
      worker.terminate();
      resolve({
        ...draft,
        astHash: event.data.astHash,
        validation: {
          syntax: event.data.syntax && draft.validation.syntax,
          safety: event.data.safety && draft.validation.safety && speechValidation.ok && documentationValidation.ok && explanationValid,
          examplesPassed: event.data.examplesPassed,
          examplesTotal: event.data.examplesTotal,
          messages: [...new Set([
            ...draft.validation.messages,
            ...event.data.messages,
            ...speechValidation.messages,
            ...documentationValidation.messages,
            ...(explanationValid ? [] : ["DeepSeek 白话解释为空。"]),
          ])],
        },
      });
    };
    worker.onerror = () => {
      window.clearTimeout(timeout);
      worker.terminate();
      resolve({
        ...draft,
        validation: { ...draft.validation, safety: false, messages: [...draft.validation.messages, "Worker 安全校验失败。"] },
      });
    };
    worker.postMessage({ sourceCode: draft.sourceCode, examples: draft.examples });
  });
}
