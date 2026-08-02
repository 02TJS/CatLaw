/// <reference lib="webworker" />
import { executeLawSource, validateLawSource } from "./lawInterpreter";
import type { LawExample } from "./types";

interface RequestPayload {
  sourceCode: string;
  examples: LawExample[];
}

self.onmessage = (event: MessageEvent<RequestPayload>) => {
  const checked = validateLawSource(event.data.sourceCode);
  const messages = [...checked.messages];
  let examplesPassed = 0;
  if (checked.ok) {
    for (const example of event.data.examples) {
      const result = executeLawSource(event.data.sourceCode, example.input);
      if (!result.error && JSON.stringify(result.action) === JSON.stringify(example.expected)) examplesPassed += 1;
      else messages.push(`Worker 样例失败：${result.error ?? "输出与期望不一致"}`);
    }
  }
  self.postMessage({
    syntax: checked.ok,
    safety: checked.ok && examplesPassed === event.data.examples.length,
    examplesPassed,
    examplesTotal: event.data.examples.length,
    messages,
    astHash: checked.hash,
  });
};

export {};
