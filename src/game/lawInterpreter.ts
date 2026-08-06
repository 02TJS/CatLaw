import { parse } from "acorn";
import { RECIPE_BY_ID, RECIPE_BY_OUTPUT } from "./catalog.js";
import { BoundedLruCache } from "./boundedLru.js";
import type { CatAction, CatObservation, DecisionResult, Direction } from "./types.js";

type AstNode = { type: string; [key: string]: unknown };

const BANNED_PROPERTIES = new Set(["__proto__", "prototype", "constructor"]);
const HELPER_NAMES = new Set(["count", "has", "warehouseCount", "crafted", "recentCrafted", "marketNeed", "neighborExists", "neighborCount", "nearbyCount", "nearbyCatCount", "onResource", "nearBuilding", "nearLandmark", "landmarkDistance", "canCraft", "at", "cash", "debt", "netWorth", "bestBid", "orderCount", "bounty", "buildingAsk", "broadcastCount", "carrying", "earnCoins", "weighted", "adjust", "choose", "setPrice", "addPrice", "setCredit", "setBounty"]);
export const MAX_CACHED_LAW_ASTS = 128;
const cache = new BoundedLruCache<string, { source: string; body: AstNode }>(MAX_CACHED_LAW_ASTS);

export function cachedLawAstCount(): number {
  return cache.size;
}

export const MAX_LAW_SOURCE_BYTES = 24 * 1024;
export const MAX_LAW_AST_NODES = 4_096;
export const MAX_LAW_AST_DEPTH = 64;
export const MAX_LAW_EXECUTION_STEPS = 10_000;

export function hashSource(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function children(node: AstNode): AstNode[] {
  const result: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (["start", "end", "loc"].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child === "object" && "type" in child) result.push(child as AstNode);
    } else if (value && typeof value === "object" && "type" in value) result.push(value as AstNode);
  }
  return result;
}

function literalPropertyName(node: AstNode): string | null {
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "Literal") return String(node.value);
  return null;
}

export function validateLawSource(source: string): { ok: boolean; hash: string; messages: string[]; ast?: AstNode } {
  const hash = hashSource(source);
  const sourceBytes = new TextEncoder().encode(source).byteLength;
  if (sourceBytes > MAX_LAW_SOURCE_BYTES) {
    return {
      ok: false,
      hash,
      messages: [`源码超过 ${MAX_LAW_SOURCE_BYTES} 字节（当前 ${sourceBytes} 字节）。`],
    };
  }
  const messages: string[] = [];
  let program: AstNode;
  try {
    program = parse(source, { ecmaVersion: 2022, sourceType: "script" }) as unknown as AstNode;
  } catch (error) {
    return { ok: false, hash, messages: [`语法错误：${error instanceof Error ? error.message : String(error)}`] };
  }
  const body = program.body as AstNode[];
  if (!Array.isArray(body) || body.length !== 1 || body[0]?.type !== "FunctionDeclaration") {
    messages.push("源码必须只包含一个 function decide(ctx) 声明。");
    return { ok: false, hash, messages };
  }
  const fn = body[0];
  if ((fn.id as AstNode | undefined)?.name !== "decide") messages.push("函数名必须是 decide。");
  const params = fn.params as AstNode[];
  if (!Array.isArray(params) || params.length !== 1 || params[0]?.type !== "Identifier" || params[0].name !== "ctx") {
    messages.push("函数必须且只能接收一个 ctx 参数。");
  }

  const allowed = new Set([
    "Program", "FunctionDeclaration", "Identifier", "BlockStatement", "ReturnStatement", "IfStatement", "VariableDeclaration",
    "VariableDeclarator", "Literal", "ObjectExpression", "Property", "MemberExpression", "BinaryExpression", "LogicalExpression",
    "UnaryExpression", "ConditionalExpression", "CallExpression",
    "ExpressionStatement",
  ]);
  const stack: Array<{ node: AstNode; depth: number }> = [{ node: program, depth: 1 }];
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    count += 1;
    if (count > MAX_LAW_AST_NODES) {
      messages.push(`AST 超过 ${MAX_LAW_AST_NODES} 个节点。`);
      break;
    }
    if (depth > MAX_LAW_AST_DEPTH) messages.push(`AST 深度超过 ${MAX_LAW_AST_DEPTH} 层。`);
    if (!allowed.has(node.type)) messages.push(`禁止的语法节点：${node.type}`);
    if (node.type === "VariableDeclaration" && node.kind !== "const") messages.push("只允许 const 局部变量。");
    if (node.type === "CallExpression") {
      const callee = node.callee as AstNode;
      if (callee?.type !== "Identifier" || !HELPER_NAMES.has(String(callee.name))) messages.push("只允许调用白名单辅助函数。");
    }
    if (node.type === "MemberExpression") {
      const property = literalPropertyName(node.property as AstNode);
      if (!property || BANNED_PROPERTIES.has(property)) messages.push("成员访问包含禁止或动态属性。");
    }
    if (node.type === "Property") {
      const key = literalPropertyName(node.key as AstNode);
      if (!key || BANNED_PROPERTIES.has(key) || node.kind !== "init" || node.method || node.computed) messages.push("对象属性必须是安全的静态键。");
    }
    for (const child of children(node)) stack.push({ node: child, depth: depth + 1 });
  }
  const uniqueMessages = [...new Set(messages)];
  if (uniqueMessages.length === 0) cache.set(hash, { source, body: fn.body as AstNode });
  return { ok: uniqueMessages.length === 0, hash, messages: uniqueMessages, ast: uniqueMessages.length === 0 ? fn.body as AstNode : undefined };
}

class ReturnSignal {
  constructor(readonly value: unknown) {}
}

function cloneObservation(observation: CatObservation): CatObservation {
  return structuredClone(observation);
}

export interface LawRuntimeHelpers {
  /** The engine already builds a detached, read-only decision snapshot. */
  observationIsSnapshot?: boolean;
  canCraft?: (recipeId: string) => boolean;
  earnCoins?: () => CatAction;
  weighted?: (craftWeight: number, passWeight: number, sellWeight: number) => CatAction;
  adjust?: (actionType: string, itemId: string, multiplier: number, bonus: number) => void;
  choose?: () => CatAction;
  warehouseCount?: (itemId: string) => number;
  crafted?: (itemId: string) => number;
  recentCrafted?: (itemId: string) => number;
  marketNeed?: (rank: number) => string;
  setPrice?: (itemId: string, multiplier: number) => void;
  addPrice?: (itemId: string, cents: number) => void;
  setCredit?: (baseCents: number, netWorthFactor: number) => void;
  setBounty?: (multiplier: number) => void;
}

export function executeLawSource(source: string, observation: CatObservation, stepLimit = MAX_LAW_EXECUTION_STEPS, runtime: LawRuntimeHelpers = {}): DecisionResult {
  const hash = hashSource(source);
  const cached = cache.get(hash);
  let body = cached?.source === source ? cached.body : undefined;
  if (!body) {
    const checked = validateLawSource(source);
    if (!checked.ok || !checked.ast) return { action: null, error: checked.messages.join(" "), steps: 0 };
    body = checked.ast;
  }

  // Generated programs cannot assign, mutate, call prototypes or retain the
  // context. The engine therefore reuses its already-detached snapshot across
  // every law in the shared loop instead of cloning the same broadcast list
  // once per law. Standalone callers keep the defensive clone by default.
  const ctx = runtime.observationIsSnapshot ? observation : cloneObservation(observation);
  const env = new Map<string, unknown>([["ctx", ctx]]);
  let steps = 0;
  const tick = () => {
    steps += 1;
    if (steps > stepLimit) throw new Error(`解释步数超过 ${stepLimit}`);
  };
  const helpers: Record<string, (...args: unknown[]) => unknown> = {
    count: (itemId) => ctx.inventory[String(itemId)] ?? 0,
    has: (itemId, quantity = 1) => (ctx.inventory[String(itemId)] ?? 0) >= Number(quantity),
    warehouseCount: (itemId) => runtime.warehouseCount?.(String(itemId)) ?? latestBroadcastAmount(ctx, "warehouse-stock", String(itemId)),
    crafted: (itemId) => runtime.crafted?.(String(itemId)) ?? latestBroadcastAmount(ctx, "production-total", String(itemId)),
    recentCrafted: (itemId) => runtime.recentCrafted?.(String(itemId)) ?? (ctx.broadcasts ?? [])
      .filter((entry) => entry.kind === "production-event" && entry.itemId === String(itemId)).length,
    marketNeed: (rank = 0) => runtime.marketNeed?.(Math.max(0, Math.floor(Number(rank)))) ?? "",
    neighborExists: (direction) => Boolean(ctx.neighbors[String(direction) as Direction]),
    neighborCount: (direction, itemId) => ctx.neighbors[String(direction) as Direction]?.inventory[String(itemId)] ?? 0,
    nearbyCount: (itemId) => (ctx.nearby ?? []).reduce((sum, cat) => sum + (cat.inventory[String(itemId)] ?? 0), 0),
    nearbyCatCount: () => ctx.nearby?.length ?? 0,
    onResource: (itemId) => ctx.site?.resourceItemIds?.includes(String(itemId))
      ?? ctx.site?.resourceItemId === String(itemId),
    nearBuilding: (itemId) => (ctx.nearby ?? []).some((cat) => cat.buildingItemId === String(itemId))
      || ctx.site?.buildingItemId === String(itemId),
    landmarkDistance: (name) => {
      const key = String(name).normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
      const distances = (ctx.landmarks ?? [])
        .filter((landmark) => landmark.name.normalize("NFKC").trim().toLocaleLowerCase("zh-CN") === key)
        .map((landmark) => landmark.distance);
      return distances.length ? Math.min(...distances) : -1;
    },
    nearLandmark: (name, maxDistance = 2) => {
      const key = String(name).normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
      const limit = Math.max(0, Math.floor(Number(maxDistance)));
      return (ctx.landmarks ?? []).some((landmark) => (
        landmark.name.normalize("NFKC").trim().toLocaleLowerCase("zh-CN") === key && landmark.distance <= limit
      ));
    },
    canCraft: (recipeId) => {
      if (runtime.canCraft) return runtime.canCraft(String(recipeId));
      const entry = RECIPE_BY_ID.get(String(recipeId)) ?? RECIPE_BY_OUTPUT.get(String(recipeId));
      return Boolean(entry && entry.inputs.every((input) => (ctx.inventory[input.itemId] ?? 0) >= input.quantity));
    },
    at: (x, y) => ctx.position.x === Number(x) && ctx.position.y === Number(y),
    cash: () => ctx.wallet?.cashCents ?? 0,
    debt: () => ctx.wallet?.debtCents ?? 0,
    netWorth: () => ctx.wallet?.netWorthCents ?? 0,
    bestBid: (itemId = "*") => (ctx.heardOrders ?? [])
      .filter((order) => String(itemId) === "*" || order.itemId === String(itemId))
      .reduce((best, order) => Math.max(best, order.effectiveBidCents), 0),
    orderCount: (itemId = "*") => (ctx.heardOrders ?? [])
      .filter((order) => String(itemId) === "*" || order.itemId === String(itemId))
      .reduce((sum, order) => sum + Math.max(1, Math.floor(order.count ?? 1)), 0),
    bounty: (itemId = "*") => (ctx.heardBounties ?? [])
      .filter((entry) => String(itemId) === "*" || entry.itemId === String(itemId))
      .reduce((best, entry) => Math.max(best, entry.amountCents), 0),
    buildingAsk: (itemId = "*") => {
      const asks = (ctx.heardBuildingOffers ?? [])
        .filter((entry) => String(itemId) === "*" || entry.itemId === String(itemId))
        .map((entry) => entry.askCents);
      return asks.length > 0 ? Math.min(...asks) : 0;
    },
    broadcastCount: (kind = "*", itemId = "*") => (ctx.broadcasts ?? [])
      .filter((entry) => (String(kind) === "*" || entry.kind === String(kind))
        && (String(itemId) === "*" || entry.itemId === String(itemId))).length,
    carrying: (itemId = "*") => Boolean(ctx.carrying && (String(itemId) === "*" || ctx.carrying.itemId === String(itemId))),
    earnCoins: () => runtime.earnCoins?.() ?? null,
    weighted: (craftWeight = 1, passWeight = 1, sellWeight = 1) => runtime.weighted?.(
      Number(craftWeight), Number(passWeight), Number(sellWeight),
    ) ?? runtime.earnCoins?.() ?? null,
    adjust: (actionType = "*", itemId = "*", multiplier = 1, bonus = 0) => {
      runtime.adjust?.(String(actionType), String(itemId), Number(multiplier), Number(bonus));
      return null;
    },
    choose: () => runtime.choose?.() ?? runtime.earnCoins?.() ?? null,
    setPrice: (itemId = "*", multiplier = 1) => {
      runtime.setPrice?.(String(itemId), Number(multiplier));
      return null;
    },
    addPrice: (itemId = "*", cents = 0) => {
      runtime.addPrice?.(String(itemId), Number(cents));
      return null;
    },
    setCredit: (baseCents = 0, netWorthFactor = 0) => {
      runtime.setCredit?.(Number(baseCents), Number(netWorthFactor));
      return null;
    },
    setBounty: (multiplier = 1) => {
      runtime.setBounty?.(Number(multiplier));
      return null;
    },
  };

  const getProperty = (target: unknown, property: string): unknown => {
    if (BANNED_PROPERTIES.has(property)) throw new Error("禁止的属性访问");
    if (target === null || typeof target !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(target, property)) return undefined;
    return (target as Record<string, unknown>)[property];
  };

  const evaluate = (node: AstNode): unknown => {
    tick();
    switch (node.type) {
      case "Literal": return node.value;
      case "Identifier": {
        const name = String(node.name);
        if (env.has(name)) return env.get(name);
        if (name === "undefined") return undefined;
        throw new Error(`未知标识符 ${name}`);
      }
      case "MemberExpression": {
        const target = evaluate(node.object as AstNode);
        const property = literalPropertyName(node.property as AstNode);
        if (!property) throw new Error("动态属性被拒绝");
        return getProperty(target, property);
      }
      case "ObjectExpression": {
        const result: Record<string, unknown> = Object.create(null);
        for (const property of node.properties as AstNode[]) {
          const key = literalPropertyName(property.key as AstNode);
          if (!key || BANNED_PROPERTIES.has(key)) throw new Error("非法对象键");
          result[key] = evaluate(property.value as AstNode);
        }
        return result;
      }
      case "UnaryExpression": {
        const value = evaluate(node.argument as AstNode);
        if (node.operator === "!") return !value;
        if (node.operator === "+") return Number(value);
        if (node.operator === "-") return -Number(value);
        throw new Error(`不支持一元运算 ${String(node.operator)}`);
      }
      case "LogicalExpression": {
        const left = evaluate(node.left as AstNode);
        if (node.operator === "&&") return left && evaluate(node.right as AstNode);
        if (node.operator === "||") return left || evaluate(node.right as AstNode);
        if (node.operator === "??") return left ?? evaluate(node.right as AstNode);
        throw new Error(`不支持逻辑运算 ${String(node.operator)}`);
      }
      case "BinaryExpression": {
        const left = evaluate(node.left as AstNode) as never;
        const right = evaluate(node.right as AstNode) as never;
        switch (node.operator) {
          case "===": return left === right;
          case "!==": return left !== right;
          case "==": return left == right; // Generated DSL compatibility; operands are isolated primitives.
          case "!=": return left != right;
          case ">": return left > right;
          case ">=": return left >= right;
          case "<": return left < right;
          case "<=": return left <= right;
          case "+": return (left as number) + (right as number);
          case "-": return (left as number) - (right as number);
          case "*": return (left as number) * (right as number);
          case "%": return (left as number) % (right as number);
          default: throw new Error(`不支持二元运算 ${String(node.operator)}`);
        }
      }
      case "ConditionalExpression": return evaluate(node.test as AstNode) ? evaluate(node.consequent as AstNode) : evaluate(node.alternate as AstNode);
      case "CallExpression": {
        const name = String((node.callee as AstNode).name);
        const helper = helpers[name];
        if (!helper) throw new Error(`禁止调用 ${name}`);
        return helper(...(node.arguments as AstNode[]).map(evaluate));
      }
      default: throw new Error(`表达式 ${node.type} 不受支持`);
    }
  };

  const executeStatement = (node: AstNode): void => {
    tick();
    switch (node.type) {
      case "BlockStatement":
        for (const statement of node.body as AstNode[]) executeStatement(statement);
        return;
      case "ReturnStatement":
        throw new ReturnSignal(node.argument ? evaluate(node.argument as AstNode) : null);
      case "IfStatement":
        if (evaluate(node.test as AstNode)) executeStatement(node.consequent as AstNode);
        else if (node.alternate) executeStatement(node.alternate as AstNode);
        return;
      case "VariableDeclaration":
        for (const declaration of node.declarations as AstNode[]) {
          const id = declaration.id as AstNode;
          if (id.type !== "Identifier") throw new Error("只允许简单局部变量");
          env.set(String(id.name), declaration.init ? evaluate(declaration.init as AstNode) : undefined);
        }
        return;
      case "ExpressionStatement":
        evaluate(node.expression as AstNode);
        return;
      default: throw new Error(`语句 ${node.type} 不受支持`);
    }
  };

  try {
    executeStatement(body);
    return { action: null, steps };
  } catch (error) {
    if (error instanceof ReturnSignal) {
      const action = normalizeAction(error.value);
      if (error.value !== null && error.value !== undefined && action === null) {
        return { action: null, error: "返回了格式错误的动作对象", steps };
      }
      return { action, steps };
    }
    return { action: null, error: error instanceof Error ? error.message : String(error), steps };
  }
}

function normalizeAction(value: unknown): CatAction {
  if (value == null) return null;
  if (typeof value !== "object") return null;
  const action = value as Record<string, unknown>;
  if (action.type === "craft" && typeof action.recipeId === "string") return { type: "craft", recipeId: action.recipeId };
  if (action.type === "pass" && typeof action.itemId === "string" && ["north", "east", "south", "west"].includes(String(action.direction))) {
    return { type: "pass", itemId: action.itemId, direction: action.direction as Direction };
  }
  return null;
}

function latestBroadcastAmount(ctx: CatObservation, kind: string, itemId: string): number {
  const match = (ctx.broadcasts ?? [])
    .filter((entry) => entry.kind === kind && entry.itemId === itemId)
    .sort((left, right) => right.publishedAt - left.publishedAt)[0];
  return match?.amountCents ?? 0;
}

export const STARTER_LAW_SOURCE = `function decide(ctx) {
  return choose();
}`;

export const STARTER_RESOURCE_STOCK_SOURCE = `function decide(ctx) {
  adjust("craft", "wood", 1, 350000 - recentCrafted("wood") * 50000);
  adjust("craft", "stone", 1, 300000 - recentCrafted("stone") * 50000);
  adjust("craft", "sand", 1, 300000 - recentCrafted("sand") * 50000);
  adjust("craft", "water", 1, 300000 - recentCrafted("water") * 50000);
  adjust("craft", "fiber", 1, 300000 - recentCrafted("fiber") * 50000);
  adjust("craft", "ore", 1, 300000 - recentCrafted("ore") * 50000);
  return null;
}`;

export const STARTER_PRIMARY_MATERIAL_BALANCE_SOURCE = `function decide(ctx) {
  adjust("craft", "wood", 1, ((recentCrafted("fire") + recentCrafted("plank") * 2 + recentCrafted("paper")) * 1.4 - recentCrafted("wood")) * 100000);
  adjust("craft", "stone", 1, (recentCrafted("brick") * 2 + recentCrafted("tools") - recentCrafted("stone")) * 100000);
  adjust("craft", "sand", 1, (recentCrafted("glass") * 2 - recentCrafted("sand")) * 100000);
  if (recentCrafted("wood") === 0) adjust("craft", "wood", 1, 600000);
  if (recentCrafted("stone") === 0) adjust("craft", "stone", 1, 600000);
  if (recentCrafted("sand") === 0) adjust("craft", "sand", 1, 600000);
  if (orderCount("wood") > 0) adjust("craft", "wood", 1, 900000);
  if (orderCount("stone") > 0) adjust("craft", "stone", 1, 900000);
  if (orderCount("sand") > 0) adjust("craft", "sand", 1, 900000);
  return null;
}`;

export const STARTER_SECONDARY_MATERIAL_BALANCE_SOURCE = `function decide(ctx) {
  adjust("craft", "water", 1, (recentCrafted("brick") + recentCrafted("paper") - recentCrafted("water")) * 100000);
  adjust("craft", "fiber", 1, ((recentCrafted("thread") * 2 + recentCrafted("chemical")) * 1.1 - recentCrafted("fiber")) * 100000);
  adjust("craft", "ore", 1, (recentCrafted("metal") * 2 - recentCrafted("ore")) * 100000);
  if (recentCrafted("water") === 0) adjust("craft", "water", 1, 600000);
  if (recentCrafted("fiber") === 0) adjust("craft", "fiber", 1, 600000);
  if (recentCrafted("ore") === 0) adjust("craft", "ore", 1, 600000);
  if (orderCount("water") > 0) adjust("craft", "water", 1, 900000);
  if (orderCount("fiber") > 0) adjust("craft", "fiber", 1, 900000);
  if (orderCount("ore") > 0) adjust("craft", "ore", 1, 900000);
  return null;
}`;

export const STARTER_FOUNDATION_STOCK_SOURCE = `function decide(ctx) {
  if (!onResource("wood") && orderCount("plank") === 0) adjust("craft", "plank", 1, -250000);
  if (!onResource("wood") && !at(0, 0) && orderCount("fire") === 0) adjust("craft", "fire", 1, -250000);
  if (!onResource("stone") && orderCount("brick") === 0) adjust("craft", "brick", 1, -250000);
  if (onResource("wood")) {
    adjust("craft", "plank", 1, 120000 - recentCrafted("plank") * 200000);
    adjust("craft", "fire", 1, 120000 - recentCrafted("fire") * 200000);
  }
  if (at(0, 0)) adjust("craft", "fire", 1, 120000 - recentCrafted("fire") * 200000);
  if (onResource("stone")) adjust("craft", "brick", 1, 120000 - recentCrafted("brick") * 200000);
  return null;
}`;

export const STARTER_FOUNDATION_BALANCE_SOURCE = `function decide(ctx) {
  if (orderCount("fire") > 0) adjust("craft", "fire", 4, 0);
  if (onResource("wood") || at(0, 0)) adjust("craft", "plank", 1, ((recentCrafted("tools") + recentCrafted("chassis")) * 1.4 - recentCrafted("plank")) * 300000);
  if (onResource("wood") || at(0, 0)) adjust("craft", "fire", 1, ((recentCrafted("glass") + recentCrafted("metal")) * 2.1 - recentCrafted("fire")) * 300000);
  if ((onResource("wood") || at(0, 0)) && recentCrafted("plank") === 0) adjust("craft", "plank", 1, 600000);
  if ((onResource("wood") || at(0, 0)) && recentCrafted("fire") === 0) adjust("craft", "fire", 1, 600000);
  if (onResource("stone") && recentCrafted("brick") === 0) adjust("craft", "brick", 1, 950000);
  return null;
}`;

export const STARTER_FOUNDATION_FINISHING_SOURCE = `function decide(ctx) {
  if (!onResource("fiber") && orderCount("thread") === 0) adjust("craft", "thread", 1, -250000);
  if (!onResource("water") && orderCount("paper") === 0) adjust("craft", "paper", 1, -250000);
  if (onResource("fiber")) adjust("craft", "thread", 1, 120000 - recentCrafted("thread") * 200000);
  if (onResource("water")) adjust("craft", "paper", 1, 120000 - recentCrafted("paper") * 200000);
  return null;
}`;

export const STARTER_FINISHING_PULSE_SOURCE = `function decide(ctx) {
  if (onResource("fiber") && recentCrafted("thread") === 0) adjust("craft", "thread", 1, 600000);
  if (onResource("water") && recentCrafted("paper") === 0) adjust("craft", "paper", 1, 950000);
  return null;
}`;

export const STARTER_FIRE_DISCIPLINE_SOURCE = `function decide(ctx) {
  if (onResource("wood") && crafted("glass") === 0) adjust("craft", "fire", 1, 35000 - recentCrafted("fire") * 5000);
  if (onResource("wood") && crafted("glass") > 0) adjust("craft", "fire", 1, 5000 - recentCrafted("fire") * 10000);
  if (crafted("glass") === 0 && ctx.position.x !== 0 && !onResource("wood")) adjust("craft", "fire", 1, -100000);
  return null;
}`;

export const STARTER_WORKSHOP_STOCK_SOURCE = `function decide(ctx) {
  if (!onResource("stone") && orderCount("tools") === 0) adjust("craft", "tools", 1, -250000);
  if (!onResource("sand") && orderCount("glass") === 0) adjust("craft", "glass", 1, -250000);
  if (!onResource("ore") && orderCount("metal") === 0) adjust("craft", "metal", 1, -250000);
  if (!onResource("ore") && orderCount("gear") === 0) adjust("craft", "gear", 1, -250000);
  if (onResource("stone")) adjust("craft", "tools", 1, 120000 - recentCrafted("tools") * 200000);
  if (onResource("sand")) adjust("craft", "glass", 1, 120000 - recentCrafted("glass") * 200000);
  if (onResource("ore")) {
    adjust("craft", "metal", 1, 120000 - recentCrafted("metal") * 200000);
    adjust("craft", "gear", 1, 120000 - recentCrafted("gear") * 200000);
  }
  return null;
}`;

export const STARTER_WORKSHOP_BALANCE_SOURCE = `function decide(ctx) {
  if (orderCount("metal") > 0) adjust("craft", "metal", 1, 300000);
  if (onResource("ore")) adjust("craft", "metal", 1, ((recentCrafted("gear") * 2 + recentCrafted("cable") + recentCrafted("battery") + recentCrafted("chassis")) * 1.35 - recentCrafted("metal")) * 200000);
  if (onResource("stone") && recentCrafted("tools") === 0) adjust("craft", "tools", 1, 600000);
  if (onResource("sand") && recentCrafted("glass") === 0) adjust("craft", "glass", 1, 600000);
  if (onResource("ore") && recentCrafted("metal") === 0) adjust("craft", "metal", 1, 600000);
  if (onResource("ore") && recentCrafted("gear") === 0) adjust("craft", "gear", 1, 600000);
  if (onResource("ore") && recentCrafted("gear") === 0 && (recentCrafted("cable") > 0 || crafted("gear") <= crafted("cable") + 2)) adjust("craft", "gear", 1, 900000);
  return null;
}`;

export const STARTER_LIGHT_INDUSTRY_STOCK_SOURCE = `function decide(ctx) {
  adjust("craft", "cable", 1, -250000);
  adjust("craft", "battery", 1, -250000);
  adjust("craft", "chemical", 1, -250000);
  adjust("craft", "chassis", 1, -250000);
  if (onResource("ore")) adjust("craft", "cable", 1, 550000 - recentCrafted("cable") * 100000);
  if (onResource("water")) adjust("craft", "battery", 1, 1000000 - recentCrafted("battery") * 100000);
  if (onResource("fiber")) adjust("craft", "chemical", 1, 550000 - recentCrafted("chemical") * 100000);
  if (onResource("wood") && crafted("chassis") <= crafted("battery") + 1) adjust("craft", "chassis", 1, 550000 - recentCrafted("chassis") * 100000);
  if (onResource("ore") && recentCrafted("cable") === 0) adjust("craft", "cable", 1, 900000);
  if (onResource("wood") && recentCrafted("chassis") === 0 && crafted("chassis") <= crafted("battery") + 1) adjust("craft", "chassis", 1, 900000);
  return null;
}`;

export const STARTER_LIGHT_INDUSTRY_ORDER_SOURCE = `function decide(ctx) {
  if (orderCount("cable") > 0) adjust("craft", "cable", 1, 600000);
  if (orderCount("battery") > 0) adjust("craft", "battery", 1, 900000);
  if (orderCount("chemical") > 0) adjust("craft", "chemical", 1, 900000);
  if (orderCount("chassis") > 0) adjust("craft", "chassis", 1, 900000);
  return null;
}`;

function mergeStarterLawSources(...sources: string[]): string {
  const bodies = sources.map((source) => {
    const opening = source.indexOf("{");
    const closing = source.lastIndexOf("}");
    if (opening < 0 || closing <= opening) throw new Error("Invalid starter law source");
    return source.slice(opening + 1, closing).trim().replace(/\s*return null;\s*$/, "");
  });
  return `function decide(ctx) {\n  ${bodies.join("\n  ")}\n  return null;\n}`;
}

/**
 * Six resources share one local replenishment regulation. The only extra
 * signal is the cat's own inventory: a resource workstation gets a bounded
 * recovery pulse at zero stock, plus a small premium for real downstream
 * orders. It never names a recipe table or observes another cat's inventory.
 */
export const STARTER_RESOURCE_SUPPLY_SOURCE = mergeStarterLawSources(
  `function decide(ctx) {
    const item = ctx.site && ctx.site.resourceItemId ? ctx.site.resourceItemId : "";
    if (item) {
      adjust("craft", item, 1, 500000 - recentCrafted(item) * 50000 + orderCount(item) * 20000);
      if (count(item) <= 0) adjust("craft", item, 1, 100000);
    }
    return null;
  }`,
);

/** The five introductory crafted goods share one replenishment regulation. */
export const STARTER_FOUNDATION_CYCLE_SOURCE = mergeStarterLawSources(
  `function decide(ctx) {
    const item = ctx.ownPlan ? ctx.ownPlan.outputItemId : "";
    if (item) adjust("craft", item, 8, 3000000);
    return null;
  }`,
);

/**
 * One shared production-score law keeps the first fifteen goods regenerative
 * without embedding a recipe table. `marketNeed` still rotates the least
 * recently produced unlocked item; the explicit balance terms are the
 * observable one-batch consumption relations of the introductory chain.
 */
export const STARTER_WORKSHOP_CYCLE_SOURCE = mergeStarterLawSources(
  `function decide(ctx) {
    const need0 = marketNeed(0);
    const need1 = marketNeed(1);
    const need2 = marketNeed(2);
    const need3 = marketNeed(3);
    const need4 = marketNeed(4);
    const need5 = marketNeed(5);
    const need6 = marketNeed(6);
    const need7 = marketNeed(7);
    const need8 = marketNeed(8);
    const need9 = marketNeed(9);
    const need10 = marketNeed(10);
    const need11 = marketNeed(11);
    const need12 = marketNeed(12);
    const need13 = marketNeed(13);
    const need14 = marketNeed(14);
    if (need0) adjust("craft", need0, 1, orderCount(need0) * 250000 + 120000);
    if (need1) adjust("craft", need1, 1, orderCount(need1) * 250000 + 112000);
    if (need2) adjust("craft", need2, 1, orderCount(need2) * 250000 + 104000);
    if (need3) adjust("craft", need3, 1, orderCount(need3) * 250000 + 96000);
    if (need4) adjust("craft", need4, 1, orderCount(need4) * 250000 + 88000);
    if (need5) adjust("craft", need5, 1, orderCount(need5) * 250000 + 80000);
    if (need6) adjust("craft", need6, 1, orderCount(need6) * 250000 + 72000);
    if (need7) adjust("craft", need7, 1, orderCount(need7) * 250000 + 64000);
    if (need8) adjust("craft", need8, 1, orderCount(need8) * 250000 + 56000);
    if (need9) adjust("craft", need9, 1, orderCount(need9) * 250000 + 48000);
    if (need10) adjust("craft", need10, 1, orderCount(need10) * 250000 + 40000);
    if (need11) adjust("craft", need11, 1, orderCount(need11) * 250000 + 32000);
    if (need12) adjust("craft", need12, 1, orderCount(need12) * 250000 + 24000);
    if (need13) adjust("craft", need13, 1, orderCount(need13) * 250000 + 16000);
    if (need14) adjust("craft", need14, 1, orderCount(need14) * 250000 + 8000);
    adjust("craft", "wood", 1, (recentCrafted("fire") + recentCrafted("plank") * 2 + recentCrafted("paper") - recentCrafted("wood")) * 900000);
    adjust("craft", "stone", 1, (recentCrafted("brick") * 2 + recentCrafted("tools") - recentCrafted("stone")) * 900000);
    adjust("craft", "sand", 1, (recentCrafted("glass") * 2 - recentCrafted("sand")) * 900000);
    adjust("craft", "water", 1, (recentCrafted("brick") + recentCrafted("paper") - recentCrafted("water")) * 900000);
    adjust("craft", "fiber", 1, (recentCrafted("thread") * 2 - recentCrafted("fiber")) * 900000);
    adjust("craft", "ore", 1, (recentCrafted("metal") * 2 - recentCrafted("ore")) * 900000);
    adjust("craft", "fire", 1, (recentCrafted("glass") + recentCrafted("metal") - recentCrafted("fire")) * 900000);
    adjust("craft", "plank", 1, (recentCrafted("tools") - recentCrafted("plank")) * 900000);
    adjust("craft", "metal", 1, (recentCrafted("gear") * 2 - recentCrafted("metal")) * 900000);
    adjust("craft", "wood", 1, (recentCrafted("fire") + recentCrafted("plank") * 2 + recentCrafted("paper") + 1 - recentCrafted("wood")) * 900000);
    adjust("craft", "fiber", 1, (recentCrafted("thread") * 2 + 1 - recentCrafted("fiber")) * 900000);
    if (recentCrafted("brick") === 0) adjust("craft", "brick", 1, 900000);
    if (recentCrafted("paper") === 0) adjust("craft", "paper", 1, 900000);
    if (recentCrafted("tools") > recentCrafted("plank")) adjust("craft", "plank", 1, 900000);
    if (recentCrafted("glass") === 0) adjust("craft", "glass", 1, 900000);
    if (recentCrafted("brick") < 1) adjust("craft", "brick", 1, 900000);
    if (recentCrafted("tools") < 1) adjust("craft", "tools", 1, 900000);
    if (recentCrafted("gear") < 1) adjust("craft", "gear", 1, 900000);
    if (recentCrafted("paper") < 1) adjust("craft", "paper", 1, 900000);
    if (recentCrafted("glass") + recentCrafted("metal") > recentCrafted("fire") + 1) adjust("craft", "fire", 1, 900000);
    if (recentCrafted("gear") * 2 + recentCrafted("cable") + recentCrafted("battery") + recentCrafted("chassis") > recentCrafted("metal") + 1) adjust("craft", "metal", 1, 900000);
    return null;
  }`,
);
