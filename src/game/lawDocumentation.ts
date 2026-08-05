const FUNCTION_SIGNATURES = {
  decide: ["ctx"],
  count: ["item"],
  has: ["item", "qty"],
  warehouseCount: ["item"],
  crafted: ["item"],
  recentCrafted: ["item"],
  marketNeed: ["rank"],
  neighborExists: ["direction"],
  neighborCount: ["direction", "item"],
  nearbyCount: ["item"],
  nearbyCatCount: [],
  onResource: ["item"],
  nearBuilding: ["building"],
  canCraft: ["itemOrRecipe"],
  at: ["x", "y"],
  cash: [],
  debt: [],
  netWorth: [],
  bestBid: ["item"],
  orderCount: ["item"],
  bounty: ["item"],
  buildingAsk: ["item"],
  broadcastCount: ["kind", "item"],
  carrying: ["item"],
  adjust: ["action", "item", "multiplier", "bonus"],
  choose: [],
  earnCoins: [],
  weighted: ["craftWeight", "passWeight", "legacyIgnored"],
  setPrice: ["item", "multiplier"],
  addPrice: ["item", "cents"],
  setCredit: ["baseCents", "netWorthFactor"],
  setBounty: ["multiplier"],
} as const;

export type DocumentedLawFunction = keyof typeof FUNCTION_SIGNATURES;
export const DOCUMENTED_LAW_FUNCTIONS = Object.freeze(Object.keys(FUNCTION_SIGNATURES) as DocumentedLawFunction[]);

export interface LawDocumentationValidation {
  ok: boolean;
  messages: string[];
  documentedFunctions: DocumentedLawFunction[];
}

export function lawFunctionSignature(name: DocumentedLawFunction): string {
  return `${name}(${FUNCTION_SIGNATURES[name].join(", ")})`;
}

export interface GeneratedFunctionDoc {
  name: string;
  explanation: string;
}

export function applyGeneratedLawDocumentation(
  sourceCode: string,
  generatedDocs: readonly GeneratedFunctionDoc[],
): { sourceCode: string; messages: string[] } {
  const executableLines = sourceCode.replace(/\r\n?/g, "\n").split("\n")
    .filter((line) => !line.trim().startsWith("//"));
  const used = DOCUMENTED_LAW_FUNCTIONS.filter((name) => firstOccurrenceLine(executableLines, name) >= 0);
  const docs = new Map(generatedDocs.map((entry) => [entry.name, entry.explanation.trim()]));
  const messages: string[] = [];
  const header = used.map((name) => {
    const explanation = docs.get(name) ?? "";
    if (explanation.length < 12 || !/表示|代表|是|为|用于|指定|控制|乘数|数量|比例|方向|评分|参数|商品|动作|请求|返回|选择|ID|id/i.test(explanation)) {
      messages.push(`DeepSeek 未完整解释函数参数：${lawFunctionSignature(name)}。`);
    }
    return `// ${lawFunctionSignature(name)}：${explanation}`;
  });
  return { sourceCode: [...header, ...executableLines].join("\n"), messages };
}

function codeBeforeLineComment(line: string): string {
  const commentAt = line.indexOf("//");
  return commentAt >= 0 ? line.slice(0, commentAt) : line;
}

function commentsBeforeFirstUse(lines: string[], lineIndex: number, name: DocumentedLawFunction): string {
  return lines.slice(0, lineIndex)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("//"))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.includes(name))
    .join(" ");
}

function firstOccurrenceLine(lines: string[], name: DocumentedLawFunction): number {
  const pattern = name === "decide"
    ? /\bfunction\s+decide\s*\(/
    : new RegExp(`\\b${name}\\s*\\(`);
  return lines.findIndex((line) => pattern.test(codeBeforeLineComment(line)));
}

/**
 * Generated laws are executable documentation: the first occurrence of the
 * entry point and every helper it uses must be introduced by a plain-language
 * parameter comment. Comments do not affect the AST or runtime step budget.
 */
export function validateLawDocumentation(sourceCode: string): LawDocumentationValidation {
  const lines = sourceCode.replace(/\r\n?/g, "\n").split("\n");
  const messages: string[] = [];
  const documentedFunctions: DocumentedLawFunction[] = [];

  for (const name of Object.keys(FUNCTION_SIGNATURES) as DocumentedLawFunction[]) {
    const lineIndex = firstOccurrenceLine(lines, name);
    if (lineIndex < 0) continue;
    const parameters = FUNCTION_SIGNATURES[name];
    const signature = lawFunctionSignature(name);
    const comment = commentsBeforeFirstUse(lines, lineIndex, name);
    const mentionsFunction = comment.includes(name);
    // Models sometimes use equally clear aliases such as itemId instead of
    // item. Requiring our internal spelling would reject correct parameter
    // explanations, so the hard gate checks a visible signature plus a real
    // purpose/meaning sentence before first use.
    const mentionsParameters = parameters.length
      ? /表示|代表|是|为|用于|指定|控制|乘数|数量|比例|方向|评分|参数|商品|动作|ID|id/i.test(comment)
      : /无参数|不接收参数|无需参数|请求|选择|返回|调用/.test(comment);
    const sufficientlyExplained = comment.length >= Math.max(18, signature.length + 8);
    if (!mentionsFunction || !mentionsParameters || !sufficientlyExplained) {
      messages.push(`函数首次出现前缺少完整参数注释：${signature}。`);
      continue;
    }
    documentedFunctions.push(name);
  }

  if (!documentedFunctions.includes("decide")) {
    messages.push("法规入口 decide(ctx) 必须在定义前解释 ctx 参数。 ".trim());
  }
  return { ok: messages.length === 0, messages: [...new Set(messages)], documentedFunctions };
}

export const LAW_FUNCTION_DOCUMENTATION_GUIDE = DOCUMENTED_LAW_FUNCTIONS
  .map((name) => lawFunctionSignature(name))
  .join("；");
