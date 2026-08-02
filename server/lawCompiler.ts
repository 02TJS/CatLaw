import { z } from "zod";
import { CATALOG_ANALYSIS, ITEM_BY_ID, ITEMS } from "../src/game/catalog.js";
import { executeLawSource, hashSource, validateLawSource } from "../src/game/lawInterpreter.js";
import type { CatObservation, LawDraft, LawExample } from "../src/game/types.js";

export const compileRequestSchema = z.object({
  text: z.string().trim().min(2).max(1_500),
  existingLaws: z.array(z.object({ title: z.string().max(80), summary: z.string().max(300), category: z.enum(["behavior", "price", "tax"]) })).max(100),
});

const modelOutputSchema = z.object({
  title: z.string().min(1).max(60),
  summary: z.string().min(1).max(400),
  category: z.enum(["behavior", "price", "tax"]),
  taxRate: z.number().min(0).max(1).nullable().optional(),
  priceItemId: z.string().max(80).nullable().optional(),
  priceMultiplier: z.number().min(0.1).max(10).nullable().optional(),
  sourceCode: z.string().max(6_000).optional(),
  warnings: z.array(z.string().max(300)).max(8).default([]),
  examples: z.array(z.object({ input: z.unknown(), expected: z.unknown() })).max(8).default([]),
});

const DIRECTIONS = ["north", "east", "south", "west"] as const;

function emptyObservation(): CatObservation {
  return {
    position: { x: 0, y: 0 },
    inventory: {},
    neighbors: { north: null, east: null, south: null, west: null },
    landmarkEffects: {
      effectiveVisionRadius: 2,
      actionSpeedReduction: 0,
      craftSpeedReduction: 0,
      passSpeedReduction: 0,
      saleValueBonus: 0,
      creditBonusCents: 0,
      carrierFeeBonus: 0,
      visionRadiusBonus: 0,
      stacks: {
        founders_plaza: 0, craft_academy: 0, logistics_hub: 0,
        market_center: 0, energy_spire: 0, quantum_beacon: 0,
      },
    },
  };
}

function sanitizeExamples(raw: Array<{ input: unknown; expected: unknown }>): LawExample[] {
  const examples: LawExample[] = [];
  for (const entry of raw) {
    if (!entry.input || typeof entry.input !== "object") continue;
    const source = entry.input as Record<string, unknown>;
    const position = source.position as Record<string, unknown> | undefined;
    const inventory = source.inventory && typeof source.inventory === "object" ? source.inventory as Record<string, number> : {};
    const neighborsSource = source.neighbors && typeof source.neighbors === "object" ? source.neighbors as Record<string, unknown> : {};
    const input: CatObservation = {
      position: { x: Number(position?.x ?? 0), y: Number(position?.y ?? 0) },
      inventory: Object.fromEntries(Object.entries(inventory).filter(([id, quantity]) => ITEM_BY_ID.has(id) && Number.isFinite(quantity) && quantity >= 0)),
      neighbors: { north: null, east: null, south: null, west: null },
    };
    for (const direction of DIRECTIONS) {
      const neighbor = neighborsSource[direction];
      if (!neighbor || typeof neighbor !== "object") continue;
      const data = neighbor as Record<string, unknown>;
      const neighborPosition = data.position as Record<string, unknown> | undefined;
      input.neighbors[direction] = {
        position: { x: Number(neighborPosition?.x ?? 0), y: Number(neighborPosition?.y ?? 0) },
        inventory: data.inventory && typeof data.inventory === "object" ? data.inventory as Record<string, number> : {},
      };
    }
    examples.push({ input, expected: normalizeExpected(entry.expected) });
  }
  return examples;
}

function normalizeExpected(value: unknown): LawExample["expected"] {
  if (!value || typeof value !== "object") return null;
  const action = value as Record<string, unknown>;
  if (action.type === "craft" && typeof action.recipeId === "string") return { type: "craft", recipeId: action.recipeId };
  if (action.type === "sell" && typeof action.itemId === "string") return { type: "sell", itemId: action.itemId };
  if (action.type === "pass" && typeof action.itemId === "string" && DIRECTIONS.includes(action.direction as typeof DIRECTIONS[number])) {
    return { type: "pass", itemId: action.itemId, direction: action.direction as typeof DIRECTIONS[number] };
  }
  return null;
}

function stripCodeFences(source: string): string {
  return source.replace(/^```(?:javascript|js)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function sameAction(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildDraft(playerText: string, raw: z.infer<typeof modelOutputSchema>): LawDraft {
  const category = raw.category;
  const sourceCode = category === "behavior"
    ? stripCodeFences(raw.sourceCode ?? "function decide(ctx) { return earnCoins(); }")
    : "function decide(ctx) { return null; }";
  const checked = validateLawSource(sourceCode);
  const examples = sanitizeExamples(raw.examples);
  const messages = [...checked.messages];
  let examplesPassed = 0;
  if (checked.ok) {
    const fixed = [emptyObservation(), { ...emptyObservation(), position: { x: -999_999, y: 999_999 } }];
    for (const observation of fixed) {
      const result = executeLawSource(sourceCode, observation);
      if (result.error) messages.push(`边界样例失败：${result.error}`);
    }
    for (const example of examples) {
      const result = executeLawSource(sourceCode, example.input);
      if (!result.error && sameAction(result.action, example.expected)) examplesPassed += 1;
      else messages.push(`模型样例不一致：期望 ${JSON.stringify(example.expected)}，得到 ${JSON.stringify(result.action)}`);
    }
  }
  const taxRate = category === "tax" ? Math.max(0, Math.min(1, raw.taxRate ?? 0)) : null;
  const requestedItem = raw.priceItemId ?? "*";
  const priceItemId = category === "price" && (requestedItem === "*" || ITEM_BY_ID.has(requestedItem)) ? requestedItem : null;
  const priceMultiplier = category === "price" ? Math.max(0.1, Math.min(10, raw.priceMultiplier ?? 1)) : null;
  if (category === "tax" && taxRate === 0) messages.push("税率为 0%，国库不会获得收入。");
  if (category === "price" && priceItemId === null) messages.push(`未知商品 ID：${requestedItem}`);
  return {
    title: raw.title,
    playerText,
    summary: raw.summary,
    sourceCode,
    astHash: checked.hash || hashSource(sourceCode),
    examples,
    warnings: raw.warnings,
    category,
    taxRate,
    priceItemId,
    priceMultiplier,
    validation: {
      syntax: checked.ok,
      safety: checked.ok && !messages.some((message) => message.startsWith("边界样例失败") || message.startsWith("未知商品")) && examplesPassed === examples.length,
      examplesPassed,
      examplesTotal: examples.length,
      messages,
    },
  };
}

function localFallback(text: string): LawDraft {
  const isTax = /税|tax|国库/i.test(text);
  if (isTax) {
    const percent = Number(text.match(/(\d{1,3})(?:\s*%|\s*％|\s*成)?/)?.[1] ?? 20);
    const normalized = /成/.test(text) && !/%|％/.test(text) ? percent / 10 : percent / 100;
    return buildDraft(text, {
      title: "销售税条例",
      summary: `猫咪出售物品时，将 ${Math.round(Math.min(1, normalized) * 100)}% 收入缴入玩家国库。`,
      category: "tax",
      taxRate: Math.min(1, Math.max(0, normalized)),
      sourceCode: "function decide(ctx) { return null; }",
      warnings: ["未配置 DEEPSEEK_API_KEY，当前使用本地演示编译器。"],
      examples: [],
    });
  }

  const itemMatch = ITEMS.find((entry) => text.includes(entry.name) || text.toLowerCase().includes(entry.id));
  const direction = /北|上/.test(text) ? "north" : /东|右/.test(text) ? "east" : /南|下/.test(text) ? "south" : /西|左/.test(text) ? "west" : null;
  const itemId = itemMatch?.id ?? "wood";
  if (/传|送|搬/.test(text) && direction) {
    return buildDraft(text, {
      title: `${itemMatch?.name ?? "物品"}局部传递条例`,
      summary: `托管${itemMatch?.name ?? itemId}且合同下一跳为${direction}时履约；否则采用局部贪心。`,
      category: "behavior",
      sourceCode: `function decide(ctx) { if (carrying("${itemId}") && ctx.carrying.nextDirection === "${direction}") return { type: "pass", direction: "${direction}", itemId: "${itemId}" }; return earnCoins(); }`,
      warnings: ["未配置 DEEPSEEK_API_KEY，当前使用本地逻辑法条编译器。"],
      examples: [],
    });
  }
  if (/制作|制造|合成/.test(text) && itemMatch && !/评分|权重|候选/.test(text)) {
    return buildDraft(text, {
      title: `${itemMatch.name}局部制造条例`,
      summary: `当前工位能制作${itemMatch.name}时优先制作，否则采用局部贪心。`,
      category: "behavior",
      sourceCode: `function decide(ctx) { if (canCraft("make_${itemId}")) return { type: "craft", recipeId: "make_${itemId}" }; return earnCoins(); }`,
      warnings: ["未配置 DEEPSEEK_API_KEY，当前使用本地逻辑法条编译器。"],
      examples: [],
    });
  }
  if (/卖|出售/.test(text) && itemMatch) {
    return buildDraft(text, {
      title: `${itemMatch.name}局部出售条例`,
      summary: `当前工位持有${itemMatch.name}时优先出售，否则采用局部贪心。`,
      category: "behavior",
      sourceCode: `function decide(ctx) { if (has("${itemId}")) return { type: "sell", itemId: "${itemId}" }; return earnCoins(); }`,
      warnings: ["未配置 DEEPSEEK_API_KEY，当前使用本地逻辑法条编译器。"],
      examples: [],
    });
  }
  if (/评分|权重|优先/.test(text) && itemMatch) {
    const actionType = /传|送|搬/.test(text) ? "pass" : /制作|制造|合成/.test(text) ? "craft" : "sell";
    const multiplier = Math.max(0.1, Math.min(20, Number(text.match(/([\d.]+)\s*倍/)?.[1] ?? 3)));
    return buildDraft(text, {
      title: `${itemMatch.name}局部评分条例`,
      summary: `在全体共享逻辑中把${itemMatch.name}的${actionType}候选评分乘以 ${multiplier}，其余候选保持局部贪心。`,
      category: "behavior",
      sourceCode: `function decide(ctx) { adjust("${actionType}", "${itemId}", ${multiplier}, 0); return choose(); }`,
      warnings: ["未配置 DEEPSEEK_API_KEY，当前使用本地逻辑法条编译器。"],
      examples: [],
    });
  }
  const percent = Number(text.match(/(\d{1,3})(?:\s*%|\s*％)/)?.[1] ?? 20) / 100;
  const multiple = Number(text.match(/([\d.]+)\s*倍/)?.[1] ?? 0);
  const priceMultiplier = multiple > 0 ? multiple : /降低|下调|降价/.test(text) ? Math.max(0.1, 1 - percent) : 1 + percent;
  const priceItemId = itemMatch?.id ?? "*";
  const itemName = itemMatch?.name ?? "全部商品";
  return buildDraft(text, {
    title: `${itemName}价格条例`,
    summary: `${itemName}实际售价修正为基础价格的 ${Math.round(priceMultiplier * 100)}%。`,
    category: "price",
    taxRate: null,
    priceItemId,
    priceMultiplier,
    sourceCode: "function decide(ctx) { return null; }",
    warnings: ["未配置 DEEPSEEK_API_KEY，当前使用本地价格条例编译器。"],
    examples: [],
  });
}

function systemPrompt(existingLaws: Array<{ title: string; summary: string; category: string }>): string {
  const priceCatalog = ITEMS.map((item) => `${item.id}:${item.name}:${CATALOG_ANALYSIS.basePrices[item.id]}`).join("；");
  return `你是“猫咪工坊”的法条编译器。必须只输出 JSON 对象，不要 Markdown。
法典允许三类：behavior 局部逻辑法、price 商品价格条例、tax 销售税法。不要保存、推测或复述配料表。
每只猫只读取曼哈顿距离 2 内的工位。behavior 的 sourceCode 是 function decide(ctx) { ... }。不要强迫使用某种模板：你应自行判断是直接返回动作对象、调用 earnCoins()，还是在函数中间修改局部候选评分，以上方式可任意混用。直接动作对象格式为 { type: "craft", recipeId: "make_wood" }、{ type: "pass", direction: "east", itemId: "wood" } 或 { type: "sell", itemId: "wood" }。配方 ID 统一为 make_商品ID。
ctx 只包含自身 position、inventory、四邻 neighbors、半径2 nearby、自身 site、wallet、全局即时广播 heardOrders/heardBounties/heardBuildingOffers/broadcasts 和当前 carrying；不会提供远方库存或配方表。广播由具体猫咪署名发布，不沿猫链传播；只有实物运输需要相邻猫链。只允许 const、if、return、字面量、比较/布尔运算和安全对象返回；禁止循环、赋值、递归、异步、DOM、网络、存储、时间和随机数。
评分逻辑可在任意条件分支调用 adjust(actionType,itemId,multiplier,bonus) 一次或多次，再 return choose()。actionType 可为 craft/pass/sell/*，itemId 可为稳定英文 ID 或 *；多个修正按调用顺序叠加。weighted(craftWeight,passWeight,sellWeight) 只为简单情形与旧法兼容，并非固定结构。
白名单函数：count(itemId)、has(itemId,quantity)、neighborExists(direction)、neighborCount(direction,itemId)、nearbyCount(itemId)、nearbyCatCount()、onResource(itemId)、nearBuilding(itemId)、canCraft(recipeId)、at(x,y)、cash()、debt()、netWorth()、bestBid(itemId)、orderCount(itemId)、bounty(itemId)、buildingAsk(itemId)、broadcastCount(kind,itemId)、carrying(itemId)、earnCoins()、adjust(actionType,itemId,multiplier,bonus)、choose()、weighted(craftWeight,passWeight,sellWeight)。金额助手均返回整数分。
直接动作示例：function decide(ctx) { if (carrying("wood")) return { type: "pass", direction: ctx.carrying.nextDirection, itemId: "wood" }; return earnCoins(); }
混合评分示例：function decide(ctx) { if (orderCount("ore") > 0) adjust("craft", "ore", 3, 30); if (nearbyCount("wood") >= 2) adjust("craft", "plank", 2, 20); return choose(); }
除非玩家明确要求全部待机，否则 behavior 不得只返回 null。必须完整回应玩家描述的条件或评分意图。
行为逻辑之后还会经过不可绕过的利己经济门槛：无运输合同的 pass 会因“没有对价”失败；亏损制作、税后亏损出售或超额信用也会失败。内部订单免销售税，外部出售才应用税法。
price 条例用 priceItemId 指定稳定英文商品 ID，或用 * 表示全部商品；priceMultiplier 是相对基础价格的倍率，范围 0.1 到 10。若多个价格条例命中同一商品，只采用优先级最高的一条。
tax 条例用 taxRate 表示 0 到 1 的税率；最高优先级税法生效，税款进入玩家国库，其余收入归卖方猫咪。
price/tax 的 sourceCode 固定输出 function decide(ctx) { return null; }。warnings 和 examples 通常为空数组。
输出格式：{"title":"...","summary":"...","category":"behavior|price|tax","taxRate":null,"priceItemId":null,"priceMultiplier":null,"sourceCode":"function decide(ctx) { return earnCoins(); }","warnings":[],"examples":[]}。
商品 ID、中文名与基础价格（不是配料表）：${priceCatalog}
现行法摘要：${JSON.stringify(existingLaws)}
地标上下文更新：前述“半径2”是基础值；量子信标可把 nearby 的有效曼哈顿半径提升到最高5。ctx.landmarkEffects 提供 effectiveVisionRadius、actionSpeedReduction、craftSpeedReduction、passSpeedReduction、saleValueBonus、creditBonusCents、carrierFeeBonus、visionRadiusBonus 与六类地标 stacks。生成法条可读取这些字段，但不得修改它们。`;
}

async function callDeepSeek(apiKey: string, text: string, existingLaws: Array<{ title: string; summary: string; category: "behavior" | "price" | "tax" }>): Promise<z.infer<typeof modelOutputSchema>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const retryInstruction = attempt === 0 ? "" : "\n上一次输出为空、无效或退化成默认逻辑。请重新独立编译，忠实实现每个条件和评分修正，不要返回空法条或默认行为。";
      const payload = {
        model: "deepseek-v4-flash",
        messages: [
          { role: "system", content: systemPrompt(existingLaws) },
          { role: "user", content: `请把以下玩家法条编译为安全 JSON。若有合理解释就直接实现，不要以歧义为由退回默认行为：\n${text}${retryInstruction}` },
        ],
        response_format: { type: "json_object" },
        max_tokens: 4_096,
        temperature: 0.2 + attempt * 0.2,
        stream: false,
      };
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(40_000),
      });
      if (!response.ok) throw new Error(`DeepSeek 返回 HTTP ${response.status}`);
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("DeepSeek 返回空内容");
      const output = modelOutputSchema.parse(JSON.parse(content));
      const economicRequested = /价格|售价|基础价|税|国库|price|tax/i.test(text);
      const behaviorRequested = !economicRequested && /如果|否则|传|送|搬|制作|制造|合成|出售|卖掉|行动|评分|权重|贪心|工位|邻居|东边|西边|南边|北边/i.test(text);
      if (behaviorRequested && output.category !== "behavior") throw new Error("DeepSeek 未把局部行动描述编译为行为逻辑");
      if (output.category === "behavior") {
        const source = stripCodeFences(output.sourceCode ?? "");
        const checked = validateLawSource(source);
        if (!checked.ok) throw new Error(`DeepSeek 行为逻辑未通过沙箱：${checked.messages.join(" ")}`);
        const nullOnly = /^function\s+decide\s*\(\s*ctx\s*\)\s*\{\s*return\s+null\s*;?\s*\}$/s.test(source);
        const defaultOnly = /^function\s+decide\s*\(\s*ctx\s*\)\s*\{\s*return\s+(?:earnCoins|choose)\s*\(\s*\)\s*;?\s*\}$/s.test(source);
        const idleRequested = /待机|不动作|不要行动|停止行动|return\s+null/i.test(text);
        if (nullOnly && !idleRequested) throw new Error("DeepSeek 返回了与玩家意图不符的空行为逻辑");
        if (behaviorRequested && defaultOnly) throw new Error("DeepSeek 忽略了玩家指定的条件或评分修正");
        if (output.warnings.some((warning) => /无法解析|默认行为|重新输入/.test(warning))) throw new Error("DeepSeek 声明未能解析玩家法条");
      }
      return output;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("DeepSeek 编译失败");
}

export async function compileLaw(input: z.infer<typeof compileRequestSchema>, apiKey?: string): Promise<LawDraft> {
  if (!apiKey) return localFallback(input.text);
  const output = await callDeepSeek(apiKey, input.text, input.existingLaws);
  return buildDraft(input.text, output);
}
