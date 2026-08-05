import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLawSystemPrompt, compileLaw } from "../../server/lawCompiler";
import { validateLawDocumentation } from "./lawDocumentation";
import { hashSource, MAX_LAW_AST_DEPTH, MAX_LAW_AST_NODES, MAX_LAW_SOURCE_BYTES } from "./lawInterpreter";
import { SHARED_BEHAVIOR_HASH, SHARED_BEHAVIOR_PROTOCOL, SHARED_BEHAVIOR_SOURCE } from "./lawProgram";
import { DEFAULT_LAW_SPEECH_TEMPLATES } from "./speech";

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeek three-stage immutable-law compiler", () => {
  const validSpeechTemplates = [
    "按{law}，因{reason}，{action}能赚{gain}喵！",
    "照{law}算，{reason}；{action}赚{gain}喵。",
    "{law}说得明白：{action}有{gain}，因为{reason}喵！",
    "我按{law}算过，{action}赚{gain}，{reason}喵。",
    "因为{reason}，依{law}做{action}，能赚{gain}喵！",
  ] as const;
  const explanation = "这条法规先检查当前猫是否正在履行运输合同，有合同时按合同给出的方向和商品继续运输。没有合同时，它查看当前能听到的订单数量；只要存在订单，就把全部制作候选的评分提高两倍。最后仍由共享贪心选择器在合法候选中选出行动，不能绕过配方、原料、利润、场地和合同校验。";
  const sourceCodeLines = [
    "// decide(ctx)：ctx 表示当前猫本次决策可读取的坐标、库存、钱包、订单广播和运输合同等只读信息。",
    "function decide(ctx) {",
    "  if (ctx.carrying !== null) return { type: 'pass', direction: ctx.carrying.nextDirection, itemId: ctx.carrying.itemId };",
    "  // orderCount(item)：item 表示要统计订单的稳定商品 ID，星号表示统计任意商品订单。",
    "  if (orderCount('*') > 0) {",
    "    // adjust(action, item, multiplier, bonus)：action 是动作类型，item 是商品，multiplier 是评分乘数，bonus 是固定加分。",
    "    adjust('craft', '*', 2, 0);",
    "  }",
    "  // choose()：这个函数无参数，请求共享贪心选择器从所有合法候选中选出最终行动。",
    "  return choose();",
    "}",
  ];
  const functionDocs = [
    { name: "decide", explanation: "ctx表示当前猫能读取的坐标、库存、钱包、市场广播和运输合同；函数据此应用本法规。" },
    { name: "orderCount", explanation: "item表示要统计订单的稳定商品ID，星号表示任意商品；函数返回听到的订单数量。" },
    { name: "adjust", explanation: "action表示候选动作，item表示商品，multiplier表示评分乘数，bonus表示固定加分；函数修改候选评分。" },
    { name: "choose", explanation: "这个函数无参数，用于请求共享贪心选择器选出最终合法行动。" },
  ];

  function response(content: unknown): Response {
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  function validThreeStageFetch(programLines = sourceCodeLines, docs = functionDocs) {
    return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({ model: "deepseek-v4-flash", stream: false, thinking: { type: "disabled" } });
      expect(request.messages?.[0]?.content).toContain("MANDATORY TEMPORARY-EFFECT CONTRACT");
      if (request.max_tokens === 8_192) {
        return response({
        title: "物流协调法",
        summary: "履约并按订单调整制作评分。",
        sourceCodeLines: programLines,
        functionDocs: docs,
        warnings: [],
        examples: [],
        });
      }
      if (request.max_tokens === 2_048) return response({ speechTemplates: validSpeechTemplates });
      if (request.max_tokens === 4_096) return response({ explanation });
      throw new Error(`unexpected max_tokens ${request.max_tokens}`);
    });
  }

  it("uses a build-independent manifest that drives the shared loop", () => {
    expect(SHARED_BEHAVIOR_SOURCE).toContain(`${SHARED_BEHAVIOR_PROTOCOL.id}/v${SHARED_BEHAVIOR_PROTOCOL.version}`);
    expect(SHARED_BEHAVIOR_SOURCE).toContain(`quarantine-after-faults=${SHARED_BEHAVIOR_PROTOCOL.quarantineAfterFaults}`);
    expect(SHARED_BEHAVIOR_SOURCE).toContain(`direct-action=${SHARED_BEHAVIOR_PROTOCOL.directActionMode}`);
    expect(SHARED_BEHAVIOR_HASH).toBe(hashSource(SHARED_BEHAVIOR_SOURCE));
  });

  it("includes the shared behavior hash, static limits, and mandatory first-use comments", () => {
    const prompt = buildLawSystemPrompt([], { sourceCode: "sharedBehavior/v1", astHash: "shared-current" });
    expect(prompt).toContain("只读观察");
    expect(prompt).toContain("warehouseCount");
    expect(prompt).toContain("各解释一次法规");
    expect(prompt).toContain("shared-current");
    expect(prompt).toContain(`源码UTF-8不超过${MAX_LAW_SOURCE_BYTES}字节`);
    expect(prompt).toContain(`总AST不超过${MAX_LAW_AST_NODES}节点`);
    expect(prompt).toContain(`AST深度不超过${MAX_LAW_AST_DEPTH}层`);
    expect(prompt).toContain("functionDocs由你生成");
    expect(prompt).toContain("adjust(action, item, multiplier, bonus)");
    expect(prompt).toContain("无参数函数也要明确说“无参数”");
    expect(prompt).not.toContain('"program"');
    expect(prompt).not.toContain("speechTemplates");
  });

  it("makes exactly three purpose-specific calls and combines their results", async () => {
    const fetchMock = validThreeStageFetch();
    vi.stubGlobal("fetch", fetchMock);
    const draft = await compileLaw({
      text: "听到订单时提高制作评分并继续选择",
      existingLaws: [],
      sharedBehavior: { sourceCode: "sharedBehavior/v1", astHash: "shared-current" },
    }, "redacted-test-key", { maxAttempts: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(draft.sourceCode).toContain("// decide(ctx)：");
    expect(draft.sourceCode).toContain("// adjust(action, item, multiplier, bonus)：");
    expect(draft.sourceCode).toContain("if (orderCount('*') > 0)");
    expect(draft.program).toEqual({ version: 2 });
    expect(draft.speechTemplates).toEqual(validSpeechTemplates);
    expect(draft.explanation).toBe(explanation);
    expect(draft.compileAudit).toMatchObject({
      model: "deepseek-v4-flash",
      attempts: 1,
      callCount: 3,
      sharedBehaviorHash: "shared-current",
    });
    expect(draft.compileAudit?.calls?.map((call) => call.stage)).toEqual(["program", "speech", "explanation"]);
    expect(draft.compileAudit?.usage.total_tokens).toBe(900);
  });

  it("repairs a model's coordinate guess for a same-era price request", async () => {
    const wrongLines = [
      "function decide(ctx) {",
      "  if (ctx.position.x >= 0) setPrice('*', 1.2);",
      "  return null;",
      "}",
    ];
    const fetchMock = validThreeStageFetch(wrongLines, [
      { name: "decide", explanation: "ctx表示当前猫能读取的坐标和库存等只读观察；函数据此应用法规。" },
      { name: "setPrice", explanation: "item表示目标商品ID，multiplier表示基础价格乘数；函数提交本次价格覆盖。" },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const draft = await compileLaw({
      text: "燃料同一时代的除了燃料都*1.2价格",
      existingLaws: [],
    }, "redacted-test-key");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(draft.sourceCode).not.toContain("ctx.position");
    expect(draft.sourceCode).not.toContain("setPrice('*'");
    expect(draft.sourceCode).not.toContain("setPrice('fuel'");
    expect(draft.sourceCode).toContain("setPrice('lamp', 1.2)");
    const executablePriceCalls = draft.sourceCode.split("\n").filter((line) => !line.trimStart().startsWith("//"));
    expect(executablePriceCalls.filter((line) => /setPrice\(/u.test(line))).toHaveLength(6);
  });

  it("repairs a model's 3x guess into a temporary three-coin addition", async () => {
    const wrongLines = [
      "function decide(ctx) {",
      "  setPrice('fuel', 3);",
      "  return null;",
      "}",
    ];
    const fetchMock = validThreeStageFetch(wrongLines, [
      { name: "decide", explanation: "ctx表示当前猫能读取的只读观察；函数据此应用法规。" },
      { name: "setPrice", explanation: "item表示目标商品ID，multiplier表示基础价格乘数；函数提交本次价格覆盖。" },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const draft = await compileLaw({ text: "燃料的价格+3", existingLaws: [] }, "redacted-test-key");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(draft.sourceCode).not.toContain("setPrice(");
    expect(draft.sourceCode).toContain('addPrice("fuel", 300)');
    expect(draft.sourceCode).toContain("return null");
    expect(draft.warnings.join(" ")).toContain("价格加法");
  });

  it("replaces repeated model speech with five diverse safe templates", async () => {
    const repeated = "按{law}，因{reason}，{action}能赚{gain}喵！";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (request.max_tokens === 8_192) return response({
        title: "物流协调法", summary: "履约并按订单调整制作评分。", sourceCodeLines, functionDocs, warnings: [], examples: [],
      });
      if (request.max_tokens === 2_048) return response({ speechTemplates: Array(5).fill(repeated) });
      return response({ explanation });
    });
    vi.stubGlobal("fetch", fetchMock);
    const draft = await compileLaw({ text: "听到订单时提高制作评分", existingLaws: [] }, "redacted-test-key");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(draft.speechTemplates).toEqual(DEFAULT_LAW_SPEECH_TEMPLATES);
    expect(new Set(draft.speechTemplates)).toHaveLength(5);
  });

  it("rejects a program before downstream calls when first-use parameter comments are missing", async () => {
    const undocumented = [
      "function decide(ctx) {",
      "  adjust('craft', 'wood', 3, 0);",
      "  return choose();",
      "}",
    ];
    const fetchMock = validThreeStageFetch(undocumented, [{
      name: "decide", explanation: "ctx表示当前猫可读取的只读观察；函数据此应用法规。",
    }]);
    vi.stubGlobal("fetch", fetchMock);
    await expect(compileLaw({ text: "优先制作木材", existingLaws: [] }, "redacted-test-key"))
      .rejects.toThrow("源码注释不完整");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(validateLawDocumentation(undocumented.join("\n")).ok).toBe(false);
  });

  it("fails safely when the dedicated speech call is not law-aware", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (request.max_tokens === 8_192) return response({
        title: "木材优先法", summary: "优先安排木材生产。", sourceCodeLines, functionDocs, warnings: [], examples: [],
      });
      if (request.max_tokens === 2_048) return response({
        speechTemplates: validSpeechTemplates.map((line) => line.replace("{law}", "这条法")),
      });
      return response({ explanation });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(compileLaw({ text: "测试无效台词", existingLaws: [] }, "redacted-test-key"))
      .rejects.toThrow("决策台词");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails safely when the dedicated explanation is empty or abbreviated", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (request.max_tokens === 8_192) return response({
        title: "木材优先法", summary: "优先安排木材生产。", sourceCodeLines, functionDocs, warnings: [], examples: [],
      });
      if (request.max_tokens === 2_048) return response({ speechTemplates: validSpeechTemplates });
      return response({ explanation: "提高木材评分。" });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(compileLaw({ text: "测试过短解释", existingLaws: [] }, "redacted-test-key"))
      .rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps the shared behavior source and runtime hash unchanged across local compilations", async () => {
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

  it("compiles a documented warehouse threshold draft as one unified law", async () => {
    const draft = await compileLaw({
      text: "当玩家仓库木板低于5件时，优先生产木板",
      existingLaws: [],
      sharedBehavior: { sourceCode: SHARED_BEHAVIOR_SOURCE, astHash: SHARED_BEHAVIOR_HASH },
    });
    expect(draft.title).toContain("木板");
    expect(draft.sourceCode).toContain("warehouseCount('plank') < 5");
    expect(draft.sourceCode).toContain("adjust('craft', 'plank'");
    expect(draft.explanation?.length).toBeGreaterThan(80);
    expect(validateLawDocumentation(draft.sourceCode).ok).toBe(true);
    expect(draft.validation).toMatchObject({ syntax: true, safety: true });
  });
});
