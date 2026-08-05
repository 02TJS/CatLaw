import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLawSystemPrompt, compileLaw } from "../../server/lawCompiler";
import { hashSource, MAX_LAW_AST_DEPTH, MAX_LAW_AST_NODES, MAX_LAW_SOURCE_BYTES } from "./lawInterpreter";
import { SHARED_BEHAVIOR_HASH, SHARED_BEHAVIOR_PROTOCOL, SHARED_BEHAVIOR_SOURCE } from "./lawProgram";

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeek immutable-law prompt", () => {
  const validSpeechTemplates = [
    "因{reason}，{action}能赚{gain}喵！",
    "按{law}，{reason}；{action}赚{gain}喵。",
    "这次{action}有{gain}收益，因为{reason}喵！",
    "我算过了：{action}赚{gain}，{reason}喵。",
    "因为{reason}，所以{action}，能赚{gain}喵！",
  ] as const;
  it("uses a build-independent manifest that drives the shared loop", () => {
    expect(SHARED_BEHAVIOR_SOURCE).toContain(`${SHARED_BEHAVIOR_PROTOCOL.id}/v${SHARED_BEHAVIOR_PROTOCOL.version}`);
    expect(SHARED_BEHAVIOR_SOURCE).toContain(`quarantine-after-faults=${SHARED_BEHAVIOR_PROTOCOL.quarantineAfterFaults}`);
    expect(SHARED_BEHAVIOR_SOURCE).toContain(`direct-action=${SHARED_BEHAVIOR_PROTOCOL.directActionMode}`);
    expect(SHARED_BEHAVIOR_HASH).toBe(hashSource(SHARED_BEHAVIOR_SOURCE));
  });

  it("includes the fixed shared behavior hash and category-free output", () => {
    const prompt = buildLawSystemPrompt([], { sourceCode: "sharedBehavior/v1", astHash: "shared-current" });
    expect(prompt).toContain("只读观察");
    expect(prompt).toContain("warehouseCount");
    expect(prompt).toContain("各解释一次法规");
    expect(prompt).toContain("shared-current");
    expect(prompt).toContain(`源码UTF-8不超过${MAX_LAW_SOURCE_BYTES}字节`);
    expect(prompt).toContain(`总AST不超过${MAX_LAW_AST_NODES}节点`);
    expect(prompt).toContain(`AST深度不超过${MAX_LAW_AST_DEPTH}层`);
    expect(prompt).not.toContain("总AST不超过200节点");
    expect(prompt).not.toContain('"program"');
    expect(prompt).not.toContain("replace-entire-behavior");
    expect(prompt).toContain("必须同时引用{action}、{reason}和{gain}");
    expect(prompt).toContain("运到东边的8号猫");
  });

  it("uses Flash thinking parameters and joins returned source lines", async () => {
    const sourceCodeLines = [
      "function decide(ctx) {",
      "  if (ctx.carrying !== null) return { type: 'pass', direction: ctx.carrying.nextDirection, itemId: ctx.carrying.itemId };",
      "  if (orderCount('*') > 0) adjust('craft', '*', 2, 0);",
      "  return choose();",
      "}",
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({ model: "deepseek-v4-flash", max_tokens: 4_096, stream: false });
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          title: "物流协调法",
          summary: "履约并按订单评分。",
          sourceCodeLines,
          warnings: [], examples: [],
          speechTemplates: validSpeechTemplates,
        }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const draft = await compileLaw({
      text: "听到订单时提高制作评分并继续选择",
      existingLaws: [],
      sharedBehavior: { sourceCode: "sharedBehavior/v1", astHash: "shared-current" },
    }, "redacted-test-key", { maxAttempts: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(draft.sourceCode).toBe(sourceCodeLines.join("\n"));
    expect(draft.program).toEqual({ version: 2 });
    expect(draft.speechTemplates).toHaveLength(5);
    expect(draft.speechTemplates?.every((line) => line.includes("喵"))).toBe(true);
    expect(draft.compileAudit).toMatchObject({ model: "deepseek-v4-flash", attempts: 1, sharedBehaviorHash: "shared-current" });
  });

  it("retries invalid decision speech once and accepts a corrected five-line response", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: "木材优先法",
        summary: "优先安排木材生产。",
        sourceCodeLines: ["function decide(ctx) {", "  adjust('craft', 'wood', 3, 0);", "  return choose();", "}"],
        warnings: [],
        examples: [],
        speechTemplates: calls === 1 ? ["不合格"] : validSpeechTemplates,
      }) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const draft = await compileLaw({ text: "优先制作木材", existingLaws: [] }, "redacted-test-key");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(draft.compileAudit?.attempts).toBe(2);
    expect(draft.speechTemplates).toEqual(validSpeechTemplates);
  });

  it("fails safely when both DeepSeek responses omit valid speech", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      title: "无效法",
      summary: "无效台词。",
      sourceCodeLines: ["function decide(ctx) { return null; }"],
      warnings: [],
      examples: [],
      speechTemplates: ["没有占位符喵", "仍然无效喵", "无效喵", "无效喵", "无效喵"],
    }) } }] }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(compileLaw({ text: "测试无效台词", existingLaws: [] }, "redacted-test-key")).rejects.toThrow("决策台词");
  });

  it("keeps the shared behavior source and runtime hash unchanged across compilations", async () => {
    const beforeSource = SHARED_BEHAVIOR_SOURCE;
    const beforeHash = SHARED_BEHAVIOR_HASH;
    const sharedBehavior = { sourceCode: beforeSource, astHash: beforeHash };
    const price = await compileLaw({ text: "把全部商品价格设为2倍，不改变动作", existingLaws: [], sharedBehavior });
    const logistics = await compileLaw({ text: "有订单时提高制作和传递评分并请求choose", existingLaws: [], sharedBehavior });
    expect(price.sourceCode).toContain('setPrice("*", 2)');
    expect(logistics.program).toEqual({ version: 2 });
    expect(SHARED_BEHAVIOR_SOURCE).toBe(beforeSource);
    expect(SHARED_BEHAVIOR_HASH).toBe(beforeHash);
  });

  it("compiles a warehouse threshold draft as one unified decision law", async () => {
    const draft = await compileLaw({
      text: "当玩家仓库木板低于5件时，优先生产木板",
      existingLaws: [],
      sharedBehavior: { sourceCode: SHARED_BEHAVIOR_SOURCE, astHash: SHARED_BEHAVIOR_HASH },
    });

    expect(draft.title).toContain("木板");
    expect(draft.sourceCode).toContain("warehouseCount('plank') < 5");
    expect(draft.sourceCode).toContain("adjust('craft', 'plank'");
    expect(draft.sourceCode).toContain("return choose()");
    expect(draft.program).toEqual({ version: 2 });
    expect(draft.validation).toMatchObject({ syntax: true, safety: true });
    expect(SHARED_BEHAVIOR_HASH).toBe(hashSource(SHARED_BEHAVIOR_SOURCE));
  });
});
