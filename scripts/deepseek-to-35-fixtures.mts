import { hashSource, validateLawSource } from "../src/game/lawInterpreter";
import type { LawDraft } from "../src/game/types";
import { DEEPSEEK_ACCEPTANCE_CASES } from "./deepseek-to-35-cases.mjs";

const passive = "function decide(ctx) { return null; }";

const priceBalancing = `function decide(ctx) {
  if (bounty("magnet") > 0 || bounty("lamp") > 0) {
    const own = ctx.ownPlan ? ctx.ownPlan.outputItemId : "";
    adjust("craft", "*", 0, 0);
    if (own) adjust("craft", own, 1, 800000);
    if (bounty("magnet") > 0) {
      if (at(-1, -1)) adjust("craft", "metal", 1, 1000000);
      else if (at(1, -1)) adjust("craft", "battery", 1, 1000000);
      else if (at(0, 0) || at(1, 1)) adjust("craft", "magnet", 1, 1000000);
    } else {
      if (at(-1, -1)) {
        if (count("glass") > 0) adjust("craft", "lamp", 1, 1000000);
        else adjust("craft", "glass", 1, 1000000);
      } else if (at(1, -1)) {
        if (count("cable") > 0) adjust("craft", "lamp", 1, 1000000);
        else adjust("craft", "cable", 1, 1000000);
      } else if (at(-1, 1)) {
        if (count("battery") > 0) adjust("craft", "lamp", 1, 1000000);
        else adjust("craft", "battery", 1, 1000000);
      }
      else if (at(0, 0) || at(1, 1)) adjust("craft", "lamp", 1, 1000000);
    }
  }
  return null;
}`;

const logistics = `function decide(ctx) {
  if (ctx.carrying !== null) return { type: "pass", direction: ctx.carrying.nextDirection, itemId: ctx.carrying.itemId };
  if (bounty("chip") > 0 || bounty("memory") > 0 || bounty("display") > 0) {
    const own = ctx.ownPlan ? ctx.ownPlan.outputItemId : "";
    const committed = ctx.ownPlan ? ctx.ownPlan.reason === "order" : false;
    adjust("craft", "*", 0, -1000000);
    adjust("craft", "*", 1, -1000000);
    adjust("craft", "*", 1, -1000000);
    if (committed) {
      adjust("craft", own, 1, 1000000);
      adjust("craft", own, 1, 1000000);
      adjust("craft", own, 1, 1000000);
      adjust("craft", own, 1, 1000000);
    } else {
      if (at(-1, 0) || at(0, -1)) {
        adjust("sell", "cable", 0, -1000000);
        if (count("cable") < 1 && count("metal") < 1) {
          adjust("craft", "metal", 1, 1000000);
          adjust("craft", "metal", 1, 1000000);
          adjust("craft", "metal", 1, 1000000);
          adjust("craft", "metal", 1, 1000000);
          adjust("craft", "metal", 1, 1000000);
        } else if (count("cable") < 1) {
          adjust("craft", "cable", 1, 1000000);
          adjust("craft", "cable", 1, 1000000);
          adjust("craft", "cable", 1, 1000000);
          adjust("craft", "cable", 1, 1000000);
          adjust("craft", "cable", 1, 1000000);
        }
      } else if (at(1, 0) || at(0, 1)) {
        adjust("sell", "chemical", 0, -1000000);
        if (count("chemical") < 1) {
          adjust("craft", "chemical", 1, 1000000);
          adjust("craft", "chemical", 1, 1000000);
          adjust("craft", "chemical", 1, 1000000);
          adjust("craft", "chemical", 1, 1000000);
          adjust("craft", "chemical", 1, 1000000);
        }
      }
      if (ctx.site && ctx.site.resourceItemId && count(ctx.site.resourceItemId) < 2) {
        adjust("craft", ctx.site.resourceItemId, 1, 1000000);
        adjust("craft", ctx.site.resourceItemId, 1, 1000000);
        adjust("craft", ctx.site.resourceItemId, 1, 1000000);
        adjust("craft", ctx.site.resourceItemId, 1, 1000000);
      }
      if (!ctx.site || !ctx.site.resourceItemId) {
        if (own === "paper") adjust("craft", "brick", 1, 1000000);
        else if (own) adjust("craft", "paper", 1, 1000000);
      }
    }
    if (bounty("display") > 0 && at(-1, -1)) {
      adjust("craft", "display", 1, 1000000);
      adjust("craft", "display", 1, 1000000);
      adjust("craft", "display", 1, 1000000);
      adjust("craft", "display", 1, 1000000);
      adjust("craft", "display", 1, 1000000);
      adjust("craft", "display", 1, 1000000);
      adjust("craft", "display", 1, 1000000);
      adjust("craft", "display", 1, 1000000);
    } else if (at(0, 0) && bounty("chip") > 0) {
      adjust("craft", "chip", 1, 1000000);
      adjust("craft", "chip", 1, 1000000);
      adjust("craft", "chip", 1, 1000000);
      adjust("craft", "chip", 1, 1000000);
      adjust("craft", "chip", 1, 1000000);
      adjust("craft", "chip", 1, 1000000);
      adjust("craft", "chip", 1, 1000000);
      adjust("craft", "chip", 1, 1000000);
    } else if (at(0, 0) && bounty("memory") > 0) {
      adjust("craft", "memory", 1, 1000000);
      adjust("craft", "memory", 1, 1000000);
      adjust("craft", "memory", 1, 1000000);
      adjust("craft", "memory", 1, 1000000);
      adjust("craft", "memory", 1, 1000000);
      adjust("craft", "memory", 1, 1000000);
      adjust("craft", "memory", 1, 1000000);
      adjust("craft", "memory", 1, 1000000);
    }
    return choose();
  }
  if (orderCount("*") > 0) adjust("pass", "*", 4, 100000);
  if (orderCount("chip") > 0) adjust("craft", "chip", 0, 1100000);
  if (at(-1, -1)) {
    if (bounty("wheel") > 0) adjust("craft", "wheel", 0, 1000000);
    else if (bounty("fuel") > 0) adjust("craft", "fuel", 0, 1000000);
    else if (bounty("coolant") > 0) adjust("craft", "coolant", 0, 1000000);
    else if (bounty("antenna") > 0) adjust("craft", "antenna", 0, 1000000);
  } else if (at(0, 0)) {
    if (bounty("machine_tool") > 0) adjust("craft", "machine_tool", 0, 1000000);
    else if (bounty("chip") > 0) adjust("craft", "chip", 0, 1000000);
    else if (bounty("memory") > 0) adjust("craft", "memory", 0, 1000000);
    else if (bounty("display") > 0) adjust("craft", "display", 0, 1000000);
  }
  return choose();
}`;

const flowBalance = `function decide(ctx) {
  if (onResource("wood")) {
    const woodDemand = recentCrafted("fire") + recentCrafted("plank") * 2 + recentCrafted("paper");
    const plankDemand = recentCrafted("tools") + recentCrafted("chassis");
    const fireDemand = recentCrafted("glass") + recentCrafted("metal") + recentCrafted("fuel");
    adjust("craft", "wood", 1, (woodDemand + 1 - recentCrafted("wood")) * 900000);
    adjust("craft", "plank", 1, (plankDemand + 1 + warehouseCount("plank") - recentCrafted("plank")) * 900000);
    if (warehouseCount("plank") > 0 && count("plank") < warehouseCount("plank")) {
      adjust("craft", "plank", 1, 3000000);
    }
    adjust("craft", "fire", 1, (fireDemand + 2 + warehouseCount("fire") - recentCrafted("fire")) * 900000);
    if (warehouseCount("fire") > 0 && count("fire") < warehouseCount("fire")) {
      adjust("craft", "fire", 1, 3000000);
    }
  }
  if (onResource("stone")) {
    const brickDemand = recentCrafted("factory") * 2;
    const toolsDemand = recentCrafted("factory") + recentCrafted("machine_tool");
    adjust("craft", "brick", 1, (brickDemand + 1 - recentCrafted("brick")) * 900000);
    adjust("craft", "tools", 1, (toolsDemand + 1 - recentCrafted("tools")) * 900000);
  }
  if (onResource("sand")) {
    const sandDemand = recentCrafted("glass") * 2 + recentCrafted("chip");
    adjust("craft", "sand", 1, (sandDemand + 1 - recentCrafted("sand")) * 3000000);
  }
  if (onResource("water")) {
    const waterDemand = recentCrafted("brick") + recentCrafted("paper") + recentCrafted("battery") + recentCrafted("chemical") + recentCrafted("coolant") * 2;
    adjust("craft", "water", 1, (waterDemand + 1 + warehouseCount("water") - recentCrafted("water")) * 900000);
    if (warehouseCount("water") > 0 && count("water") < warehouseCount("water")) {
      adjust("craft", "water", 1, 3000000);
    }
  }
  if (onResource("fiber")) {
    const fiberDemand = recentCrafted("thread") * 2 + recentCrafted("chemical");
    adjust("craft", "fiber", 1, (fiberDemand + 1 - recentCrafted("fiber")) * 900000);
  }
  if (onResource("ore")) {
    const oreDemand = recentCrafted("metal") * 2;
    adjust("craft", "ore", 1, (oreDemand + 1 + warehouseCount("ore") - recentCrafted("ore")) * 3000000);
    if (warehouseCount("ore") > 0 && count("ore") < warehouseCount("ore")) {
      adjust("craft", "ore", 1, 3000000);
    }
  }
  if (at(-1, 0) || at(0, -1)) {
    const metalDemand = recentCrafted("gear") * 2 + recentCrafted("cable") + recentCrafted("battery") + recentCrafted("chassis") + recentCrafted("magnet") + recentCrafted("coolant") + recentCrafted("antenna") + recentCrafted("machine_tool") + recentCrafted("memory");
    const cableDemand = recentCrafted("lamp") + recentCrafted("antenna") * 2 + recentCrafted("chip");
    const gearDemand = recentCrafted("factory") + recentCrafted("wheel") + recentCrafted("machine_tool");
    adjust("craft", "metal", 1, (metalDemand + 2 - recentCrafted("metal")) * 900000);
    adjust("craft", "cable", 1, (cableDemand + 1 - recentCrafted("cable")) * 900000);
    adjust("craft", "gear", 1, (gearDemand + 1 - recentCrafted("gear")) * 900000);
  }
  if (at(1, 0) || at(0, 1)) {
    const glassDemand = recentCrafted("factory") + recentCrafted("lamp") + recentCrafted("display");
    adjust("craft", "glass", 1, (glassDemand + 1 - recentCrafted("glass")) * 900000);
  }
  return choose();
}`;

const terminalDiscipline = `function decide(ctx) {
  adjust("craft", "wheel", 0, -1000000);
  adjust("craft", "fuel", 0, -1000000);
  adjust("craft", "coolant", 0, -1000000);
  adjust("craft", "antenna", 0, -1000000);
  adjust("craft", "machine_tool", 0, -1000000);
  adjust("craft", "chip", 0, -1000000);
  adjust("craft", "memory", 0, -1000000);
  adjust("craft", "display", 0, -1000000);
  return choose();
}`;

function marketNeedDeclarations(rankCount: number, indent = "    "): string {
  const ranks = Array.from({ length: rankCount }, (_, index) => index);
  return ranks.map((rank) => `${indent}const need${rank} = marketNeed(${rank});`).join("\n");
}

function rankedNeedSelection(items: readonly string[], rankCount: number, indent = "    "): string {
  const ranks = Array.from({ length: rankCount }, (_, index) => index);
  return ranks.map((rank, index) => {
    const condition = items.map((itemId) => `need${rank} === ${JSON.stringify(itemId)}`).join(" || ");
    return `${indent}${index === 0 ? "if" : "else if"} (${condition}) {
${indent}  adjust("craft", need${rank}, 0, 1000000);
${indent}  adjust("craft", need${rank}, 1, 1000000);
${indent}}`;
  }).join("\n");
}

function rankedNeedAliasSelection(aliases: readonly string[], rankCount: number, indent = "    "): string {
  const ranks = Array.from({ length: rankCount }, (_, index) => index);
  return ranks.map((rank, index) => {
    const condition = aliases.map((alias) => `need${rank} === ${alias}`).join(" || ");
    return `${indent}${index === 0 ? "if" : "else if"} (${condition}) {
${indent}  adjust("craft", need${rank}, 0, 1000000);
${indent}  adjust("craft", need${rank}, 1, 1000000);
${indent}}`;
  }).join("\n");
}

function rankedAdvancedSelection(rankCount: number): string {
  const ranks = Array.from({ length: rankCount }, (_, index) => index);
  const membership = (rank: number, aliases: readonly string[]) => aliases.map((alias) => `need${rank} === ${alias}`).join(" || ");
  return ranks.map((rank, index) => `${index === 0 ? "  if" : "  else if"} (
    (at(0, 0) && (${membership(rank, advancedCenterAliases)})) ||
    (at(-1, -1) && (${membership(rank, advancedWestAliases)}))
  ) {
    adjust("craft", need${rank}, 0, 1000000);
    adjust("craft", need${rank}, 1, 2000000);
  }`).join("\n");
}

function rankedNeedBranch(items: readonly string[], rankCount = 30): string {
  return `${marketNeedDeclarations(rankCount)}\n${rankedNeedSelection(items, rankCount)}`;
}

function boostOrderedItems(items: readonly string[], indent = "  ", repeats = 1, bonus = 900000): string {
  return items.map((itemId) => `${indent}if (orderCount(${JSON.stringify(itemId)}) > 0) {
${Array.from({ length: repeats }, () => `${indent}  adjust("craft", ${JSON.stringify(itemId)}, 1, ${bonus});`).join("\n")}
${indent}}`).join("\n");
}

function clearForeignPlan(items: readonly string[], indent = "    "): string {
  const allowed = items.map((itemId) => `own !== ${JSON.stringify(itemId)}`).join(" && ");
  return `${indent}if (own && !committed && ${allowed}) {
${indent}  adjust("craft", "*", 0, -1000000);
${indent}  adjust("craft", "*", 1, -1000000);
${indent}  adjust("craft", "*", 1, -1000000);
${indent}  if (own === "paper") adjust("craft", "brick", 1, 1000000);
${indent}  else adjust("craft", "paper", 1, 1000000);
${indent}}`;
}

const terminalSupplyItems = [
  "wood", "stone", "sand", "water", "fiber", "ore", "fire", "plank", "thread", "brick", "paper", "tools", "glass",
  "metal", "gear", "cable", "battery", "chemical", "chassis", "lamp", "magnet",
];
const advancedSupplyItems = ["water", "fiber", "ore", "gear", "battery", "lamp"];

const stableRotation = `function decide(ctx) {
  const own = ctx.ownPlan ? ctx.ownPlan.outputItemId : "";
  const committed = ctx.ownPlan ? ctx.ownPlan.reason === "order" : false;
  if (committed) {
    adjust("craft", own, 1, 1000000);
    adjust("craft", own, 1, 1000000);
    adjust("craft", own, 1, 1000000);
    adjust("craft", own, 1, 1000000);
  }
${marketNeedDeclarations(30, "  ")}
${boostOrderedItems(terminalSupplyItems, "  ", 1, 3000000)}
  if (recentCrafted("chassis") < 1) adjust("craft", "chassis", 1, 900000);
  if (ctx.position.y < 0 && !at(1, -1) && !at(-1, -1)) {
${clearForeignPlan(["wheel", "fuel"])}
    if (ctx.position.x < 0) {
      adjust("craft", "wheel", 0, 1000000);
      adjust("craft", "wheel", 1, 1000000);
      adjust("craft", "wheel", 1, 1000000);
      adjust("craft", "wheel", 1, 1000000);
    } else {
      adjust("craft", "fuel", 0, 1000000);
      adjust("craft", "fuel", 1, 1000000);
      adjust("craft", "fuel", 1, 1000000);
      adjust("craft", "fuel", 1, 1000000);
    }
  } else if (ctx.position.y >= 0 && !at(0, 0) && !at(1, 1) && !at(-1, 0) && !at(1, 0) && !at(0, 1)) {
${clearForeignPlan(["coolant", "antenna", "lamp"])}
    if (at(-1, 1)) {
      adjust("craft", "lamp", 0, 1000000);
      adjust("craft", "lamp", 1, 1000000);
      adjust("craft", "lamp", 1, 1000000);
      adjust("craft", "lamp", 1, 1000000);
    } else if (ctx.position.x < 0) {
      adjust("craft", "coolant", 0, 1000000);
      adjust("craft", "coolant", 1, 1000000);
      adjust("craft", "coolant", 1, 1000000);
      adjust("craft", "coolant", 1, 1000000);
    } else {
      adjust("craft", "antenna", 0, 1000000);
      adjust("craft", "antenna", 1, 1000000);
      adjust("craft", "antenna", 1, 1000000);
      adjust("craft", "antenna", 1, 1000000);
    }
  } else if (at(0, 0)) {
${clearForeignPlan(["machine_tool", "chip", "radio", "robot", "vehicle"])}
${rankedNeedSelection(["machine_tool", "chip"], 30)}
  } else if (at(-1, -1)) {
${clearForeignPlan(["memory", "display", "controller", "fabricator"])}
${rankedNeedSelection(["memory", "display"], 30)}
  } else if (at(1, -1)) {
${clearForeignPlan(["factory"])}
    adjust("craft", "factory", 0, 1000000);
    adjust("craft", "factory", 1, 1000000);
  } else if (at(1, 1)) {
${clearForeignPlan(["magnet"])}
    adjust("craft", "magnet", 0, 1000000);
    adjust("craft", "magnet", 1, 1000000);
  } else if (at(-1, 0)) {
${clearForeignPlan(["metal"])}
    adjust("craft", "metal", 0, 1000000);
    adjust("craft", "metal", 1, 1000000);
  } else if (at(1, 0) || at(0, 1)) {
${clearForeignPlan(["glass"])}
    adjust("craft", "glass", 0, 1000000);
    adjust("craft", "glass", 1, 1000000);
  }
  if (recentCrafted("factory") < 1 && at(1, -1)) {
    adjust("craft", "factory", 1, 1000000);
    adjust("craft", "factory", 1, 1000000);
    adjust("craft", "factory", 1, 1000000);
    adjust("craft", "factory", 1, 1000000);
  }
  return choose();
}`;

const advancedWest = ["memory", "display", "controller", "fabricator"];
const advancedCenter = ["machine_tool", "chip", "radio", "robot", "vehicle"];
const advancedCenterAliases = ["c0", "c1", "c2", "c3", "c4"];
const advancedWestAliases = ["w0", "w1", "w2", "w3"];
const advancedAliasDeclarations = [
  ...advancedCenter.map((itemId, index) => `  const ${advancedCenterAliases[index]} = ${JSON.stringify(itemId)};`),
  ...advancedWest.map((itemId, index) => `  const ${advancedWestAliases[index]} = ${JSON.stringify(itemId)};`),
].join("\n");

function suppressItems(items: readonly string[]): string {
  return items.map((itemId) => `    adjust("craft", ${JSON.stringify(itemId)}, 0, -1000000);`).join("\n");
}

function boostItem(itemId: string, count = 8): string {
  return Array.from({ length: count }, () => `      adjust("craft", ${JSON.stringify(itemId)}, 1, 1000000);`).join("\n");
}

const advanced = `function decide(ctx) {
  if (ctx.carrying !== null) return { type: "pass", direction: ctx.carrying.nextDirection, itemId: ctx.carrying.itemId };
  if (bounty("controller") > 0 || bounty("radio") > 0 || bounty("robot") > 0 || bounty("fabricator") > 0 || bounty("vehicle") > 0) {
    const own = ctx.ownPlan ? ctx.ownPlan.outputItemId : "";
    const committed = ctx.ownPlan ? ctx.ownPlan.reason === "order" : false;
    adjust("craft", "*", 0, -1000000);
    adjust("craft", "*", 1, -1000000);
    adjust("craft", "*", 1, -1000000);
    if (committed) {
      adjust("craft", own, 1, 1000000);
      adjust("craft", own, 1, 1000000);
      adjust("craft", own, 1, 1000000);
      adjust("craft", own, 1, 1000000);
    } else if (own === "paper") {
      adjust("craft", "brick", 1, 1000000);
    } else if (own) {
      adjust("craft", "paper", 1, 1000000);
    }
    if (bounty("radio") > 0 && at(0, 0)) {
${boostItem("radio")}
    } else if (bounty("controller") > 0 && at(-1, -1)) {
${boostItem("controller")}
    } else if (bounty("fabricator") > 0 && at(-1, -1)) {
${boostItem("fabricator")}
    } else if (bounty("robot") > 0 && at(0, 0)) {
${boostItem("robot")}
    } else if (bounty("vehicle") > 0 && at(0, 0)) {
${boostItem("vehicle")}
    }
    return choose();
  }
  if (orderCount("*") > 0) adjust("pass", "*", 4, 120000);
${boostOrderedItems(advancedSupplyItems)}
  if (recentCrafted("chassis") < 1) adjust("craft", "chassis", 1, 900000);
${advancedAliasDeclarations}
${marketNeedDeclarations(35, "  ")}
  if (!at(0, 0) && !at(-1, -1)) {
    adjust("craft", need0, 0, 1000000);
    adjust("craft", need0, 1, 1000000);
  } else if (at(0, 0)) {
${suppressItems(advancedCenter)}
  } else if (at(-1, -1)) {
${suppressItems(advancedWest)}
  }
${rankedAdvancedSelection(35)}
  return choose();
}`;

function withPrices(sourceCode: string, prices: ReadonlyArray<{ itemId: string; multiplier: number }>): string {
  if (prices.length === 0) return sourceCode;
  const opening = sourceCode.indexOf("{");
  const statements = prices.map((entry) => `\n  setPrice(${JSON.stringify(entry.itemId)}, ${entry.multiplier});`).join("");
  return opening < 0 ? sourceCode : `${sourceCode.slice(0, opening + 1)}${statements}${sourceCode.slice(opening + 1)}`;
}

function draft(id: string, rawSourceCode: string): LawDraft {
  const testCase = DEEPSEEK_ACCEPTANCE_CASES.find((entry) => entry.id === id)!;
  const sourceCode = withPrices(rawSourceCode, testCase.expectedPrices ?? []);
  const checked = validateLawSource(sourceCode);
  if (!checked.ok) throw new Error(`fixture ${id} is invalid: ${checked.messages.join("; ")}`);
  return {
    title: `固定夹具：${testCase.purpose}`,
    playerText: testCase.playerText,
    summary: testCase.purpose,
    sourceCode,
    astHash: hashSource(sourceCode),
    examples: [],
    warnings: ["CI固定模型响应夹具，不调用真实API。"],
    program: { version: 2 },
    validation: { syntax: true, safety: true, examplesPassed: 8, examplesTotal: 8, messages: [] },
  };
}

export function fixtureDrafts(): Record<string, LawDraft> {
  return Object.fromEntries(DEEPSEEK_ACCEPTANCE_CASES.map((testCase) => {
    if (testCase.id === "logistics-22-30") {
      return [testCase.id, draft(testCase.id, logistics)];
    }
    if (testCase.id === "terminal-discipline-23-30") {
      return [testCase.id, draft(testCase.id, terminalDiscipline)];
    }
    if (testCase.id === "stable-rotation-23-30") {
      return [testCase.id, draft(testCase.id, stableRotation)];
    }
    if (testCase.id === "flow-balance-1-30") {
      return [testCase.id, draft(testCase.id, flowBalance)];
    }
    if (testCase.id === "advanced-31-35") {
      return [testCase.id, draft(testCase.id, advanced)];
    }
    if (testCase.id === "selective-price-to-22") {
      return [testCase.id, draft(testCase.id, priceBalancing)];
    }
    return [testCase.id, draft(testCase.id, passive)];
  }));
}
