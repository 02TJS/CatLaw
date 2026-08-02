import { parse } from "acorn";
import { RECIPE_BY_ID } from "./catalog.js";
import type { CatAction, CatObservation, DecisionResult, Direction } from "./types.js";

type AstNode = { type: string; [key: string]: unknown };

const BANNED_PROPERTIES = new Set(["__proto__", "prototype", "constructor"]);
const HELPER_NAMES = new Set(["count", "has", "neighborExists", "neighborCount", "nearbyCount", "nearbyCatCount", "onResource", "nearBuilding", "canCraft", "at", "cash", "debt", "netWorth", "bestBid", "orderCount", "bounty", "buildingAsk", "broadcastCount", "carrying", "earnCoins", "weighted", "adjust", "choose"]);
const cache = new Map<string, AstNode>();

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
  const messages: string[] = [];
  let program: AstNode;
  try {
    program = parse(source, { ecmaVersion: 2022, sourceType: "script" }) as unknown as AstNode;
  } catch (error) {
    return { ok: false, hash: hashSource(source), messages: [`语法错误：${error instanceof Error ? error.message : String(error)}`] };
  }
  const body = program.body as AstNode[];
  if (!Array.isArray(body) || body.length !== 1 || body[0]?.type !== "FunctionDeclaration") {
    messages.push("源码必须只包含一个 function decide(ctx) 声明。");
    return { ok: false, hash: hashSource(source), messages };
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
  const stack: AstNode[] = [program];
  let count = 0;
  while (stack.length) {
    const node = stack.pop()!;
    count += 1;
    if (count > 200) {
      messages.push("AST 超过 200 个节点。");
      break;
    }
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
    stack.push(...children(node));
  }
  const uniqueMessages = [...new Set(messages)];
  const hash = hashSource(source);
  if (uniqueMessages.length === 0) cache.set(hash, fn.body as AstNode);
  return { ok: uniqueMessages.length === 0, hash, messages: uniqueMessages, ast: uniqueMessages.length === 0 ? fn.body as AstNode : undefined };
}

class ReturnSignal {
  constructor(readonly value: unknown) {}
}

function cloneObservation(observation: CatObservation): CatObservation {
  return structuredClone(observation);
}

export interface LawRuntimeHelpers {
  canCraft?: (recipeId: string) => boolean;
  earnCoins?: () => CatAction;
  weighted?: (craftWeight: number, passWeight: number, sellWeight: number) => CatAction;
  adjust?: (actionType: string, itemId: string, multiplier: number, bonus: number) => void;
  choose?: () => CatAction;
}

export function executeLawSource(source: string, observation: CatObservation, stepLimit = 200, runtime: LawRuntimeHelpers = {}): DecisionResult {
  const hash = hashSource(source);
  let body = cache.get(hash);
  if (!body) {
    const checked = validateLawSource(source);
    if (!checked.ok || !checked.ast) return { action: null, error: checked.messages.join(" "), steps: 0 };
    body = checked.ast;
  }

  const ctx = cloneObservation(observation);
  const env = new Map<string, unknown>([["ctx", ctx]]);
  let steps = 0;
  const tick = () => {
    steps += 1;
    if (steps > stepLimit) throw new Error(`解释步数超过 ${stepLimit}`);
  };
  const helpers: Record<string, (...args: unknown[]) => unknown> = {
    count: (itemId) => ctx.inventory[String(itemId)] ?? 0,
    has: (itemId, quantity = 1) => (ctx.inventory[String(itemId)] ?? 0) >= Number(quantity),
    neighborExists: (direction) => Boolean(ctx.neighbors[String(direction) as Direction]),
    neighborCount: (direction, itemId) => ctx.neighbors[String(direction) as Direction]?.inventory[String(itemId)] ?? 0,
    nearbyCount: (itemId) => (ctx.nearby ?? []).reduce((sum, cat) => sum + (cat.inventory[String(itemId)] ?? 0), 0),
    nearbyCatCount: () => ctx.nearby?.length ?? 0,
    onResource: (itemId) => ctx.site?.resourceItemIds?.includes(String(itemId))
      ?? ctx.site?.resourceItemId === String(itemId),
    nearBuilding: (itemId) => (ctx.nearby ?? []).some((cat) => cat.buildingItemId === String(itemId))
      || ctx.site?.buildingItemId === String(itemId),
    canCraft: (recipeId) => {
      if (runtime.canCraft) return runtime.canCraft(String(recipeId));
      const entry = RECIPE_BY_ID.get(String(recipeId));
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
      .filter((order) => String(itemId) === "*" || order.itemId === String(itemId)).length,
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
    if (error instanceof ReturnSignal) return { action: normalizeAction(error.value), steps };
    return { action: null, error: error instanceof Error ? error.message : String(error), steps };
  }
}

function normalizeAction(value: unknown): CatAction {
  if (value == null) return null;
  if (typeof value !== "object") return null;
  const action = value as Record<string, unknown>;
  if (action.type === "craft" && typeof action.recipeId === "string") return { type: "craft", recipeId: action.recipeId };
  if (action.type === "sell" && typeof action.itemId === "string") return { type: "sell", itemId: action.itemId };
  if (action.type === "pass" && typeof action.itemId === "string" && ["north", "east", "south", "west"].includes(String(action.direction))) {
    return { type: "pass", itemId: action.itemId, direction: action.direction as Direction };
  }
  return null;
}

export const STARTER_LAW_SOURCE = `function decide(ctx) {
  return earnCoins();
}`;
