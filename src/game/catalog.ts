import type { DifficultyLevel, ItemDefinition, ItemId, RecipeDefinition } from "./types.js";

export const CATALOG_VERSION = "cat-workshop-65-v5-difficulty";

export const DEPLOYABLE_BUILDING_IDS = ["factory", "machine_tool", "antenna", "lab", "reactor"] as const;

const FACTORY_REQUIRED = new Set([
  "chip", "memory", "display", "controller", "radio", "robot", "fabricator", "vehicle",
  "computer", "server", "network", "ai_core", "lab",
]);
const LAB_REQUIRED = new Set(["atom_core", "reactor", "solar_array", "telescope", "life_support", "star_map"]);
const REACTOR_REQUIRED = new Set([
  "rocket", "satellite", "lunar_base", "starship", "superconductor", "quantum_field", "quantum_sensor",
  "spacetime_clock", "quantum_computer", "spacetime_map", "singularity", "gate_key", "gate_ring", "stabilizer",
  "exotic_crystal", "address_core", "containment", "energy_matrix", "stargate",
]);
const MACHINE_TOOL_REQUIRED = new Set(["robot", "fabricator", "vehicle"]);
const ANTENNA_REQUIRED = new Set(["radio", "network", "satellite", "star_map", "address_core"]);

const compoundRequirement = (buildingItemId: typeof DEPLOYABLE_BUILDING_IDS[number], maxManhattanDistance: number, minDifficulty: DifficultyLevel) => ({
  buildingItemId,
  maxManhattanDistance,
  minDifficulty,
});

function siteRequirements(output: string): RecipeDefinition["siteRequirements"] {
  const requirements: RecipeDefinition["siteRequirements"] = [];
  if (FACTORY_REQUIRED.has(output)) requirements.push({ buildingItemId: "factory", maxManhattanDistance: 2 });
  if (LAB_REQUIRED.has(output)) requirements.push({ buildingItemId: "lab", maxManhattanDistance: 2 });
  if (REACTOR_REQUIRED.has(output)) requirements.push({ buildingItemId: "reactor", maxManhattanDistance: 3 });
  if (MACHINE_TOOL_REQUIRED.has(output)) requirements.push(compoundRequirement("machine_tool", 2, 3));
  if (ANTENNA_REQUIRED.has(output)) requirements.push(compoundRequirement("antenna", 2, 3));

  // Level 4 creates spatial specialization without adding a new action:
  // the same recipe must simply be executed in the overlap of two existing
  // building radii.
  if (output === "rocket" || output === "lunar_base") requirements.push(compoundRequirement("factory", 2, 4));
  if (output === "starship") requirements.push(compoundRequirement("lab", 2, 4));
  if (["quantum_field", "quantum_sensor", "spacetime_clock", "quantum_computer"].includes(output)) {
    requirements.push(compoundRequirement("lab", 2, 4));
  }
  if (["gate_ring", "containment", "energy_matrix"].includes(output)) requirements.push(compoundRequirement("factory", 2, 4));
  if (["gate_key", "address_core", "stargate"].includes(output)) requirements.push(compoundRequirement("antenna", 2, 4));
  if (["rocket", "satellite", "lunar_base", "starship", "superconductor", "quantum_field", "quantum_sensor", "spacetime_clock", "quantum_computer", "spacetime_map", "singularity", "gate_key", "gate_ring", "stabilizer", "exotic_crystal", "address_core", "containment", "energy_matrix", "stargate"].includes(output)) {
    // The reactor is already the high-energy anchor for these goods; the
    // requirement is retained at level 2+ and compounds with level 4 rules.
    if (!requirements.some((entry) => entry.buildingItemId === "reactor")) requirements.push({ buildingItemId: "reactor", maxManhattanDistance: 3 });
  }
  return requirements;
}

const item = (id: string, emoji: string, name: string, tier: number): ItemDefinition => ({ id, emoji, name, tier });
const recipe = (output: string, inputs: Array<[string, number]> = []): RecipeDefinition => ({
  id: `make_${output}`,
  output,
  inputs: inputs.map(([itemId, quantity]) => ({ itemId, quantity })),
  siteRequirements: siteRequirements(output),
});

export const ITEMS: ItemDefinition[] = [
  item("wood", "🪵", "木材", 0), item("stone", "🪨", "石料", 0), item("sand", "🏖️", "沙", 0),
  item("water", "💧", "水", 0), item("fiber", "🌿", "纤维", 0), item("ore", "⛏️", "矿石", 0),
  item("fire", "🔥", "炉火", 1), item("plank", "🪚", "木板", 1), item("brick", "🧱", "砖", 1),
  item("thread", "🧵", "线", 1), item("paper", "📄", "纸", 1), item("tools", "🔨", "工具", 1), item("glass", "🪟", "玻璃", 1),
  item("metal", "🔩", "金属", 2), item("gear", "⚙️", "齿轮", 2), item("cable", "🔌", "线缆", 2),
  item("battery", "🔋", "电池", 2), item("chemical", "🧪", "化学品", 2), item("chassis", "📦", "底盘", 2), item("factory", "🏭", "工厂", 2),
  item("lamp", "💡", "灯", 3), item("magnet", "🧲", "磁铁", 3), item("wheel", "🛞", "车轮", 3),
  item("fuel", "🛢️", "燃料", 3), item("coolant", "❄️", "冷却剂", 3), item("antenna", "📡", "天线", 3), item("machine_tool", "🛠️", "机床", 3),
  item("chip", "🔲", "芯片", 4), item("memory", "💾", "存储器", 4), item("display", "📺", "显示器", 4), item("controller", "🎛️", "控制器", 4),
  item("radio", "📻", "无线电", 4), item("robot", "🤖", "机器人", 4), item("fabricator", "🖨️", "制造机", 4), item("vehicle", "🚗", "车辆", 4),
  item("computer", "💻", "计算机", 5), item("server", "🖥️", "服务器", 5), item("network", "🌐", "网络", 5),
  item("ai_core", "🧠", "AI 核心", 5), item("lab", "🔬", "实验室", 5), item("atom_core", "⚛️", "原子核心", 5), item("reactor", "☢️", "反应堆", 5),
  item("solar_array", "☀️", "太阳能阵列", 6), item("telescope", "🔭", "望远镜", 6), item("rocket", "🚀", "火箭", 6), item("satellite", "🛰️", "卫星", 6),
  item("life_support", "🧬", "生命维持", 6), item("lunar_base", "🌕", "月球基地", 6), item("star_map", "🪐", "星图", 6), item("starship", "🛸", "星际飞船", 6),
  item("superconductor", "💠", "超导体", 7), item("quantum_field", "〰️", "量子场", 7), item("quantum_sensor", "🧿", "量子传感器", 7),
  item("spacetime_clock", "⏱️", "时空钟", 7), item("quantum_computer", "🔮", "量子计算机", 7), item("spacetime_map", "🌌", "时空图", 7),
  item("singularity", "🕳️", "奇点", 7), item("gate_key", "🔑", "星门密钥", 7),
  item("gate_ring", "⭕", "门环", 8), item("stabilizer", "🔺", "稳定器", 8), item("exotic_crystal", "💎", "奇异晶体", 8),
  item("address_core", "📍", "坐标核心", 8), item("containment", "🛡️", "约束场", 8), item("energy_matrix", "🌠", "能量矩阵", 8), item("stargate", "🌀", "星门", 8),
];

export const RECIPES: RecipeDefinition[] = [
  recipe("wood"), recipe("stone"), recipe("sand"), recipe("water"), recipe("fiber"), recipe("ore"),
  recipe("fire", [["wood", 1]]), recipe("plank", [["wood", 2]]), recipe("brick", [["stone", 2], ["water", 1]]),
  recipe("thread", [["fiber", 2]]), recipe("paper", [["wood", 1], ["water", 1]]), recipe("tools", [["plank", 1], ["stone", 1]]),
  recipe("glass", [["sand", 2], ["fire", 1]]), recipe("metal", [["ore", 2], ["fire", 1]]), recipe("gear", [["metal", 2]]),
  recipe("cable", [["metal", 1], ["thread", 1]]), recipe("battery", [["metal", 1], ["water", 1]]),
  recipe("chemical", [["water", 1], ["fiber", 1], ["glass", 1]]), recipe("chassis", [["plank", 1], ["metal", 1]]),
  recipe("factory", [["brick", 2], ["gear", 1], ["tools", 1], ["glass", 1]]),
  recipe("lamp", [["glass", 1], ["cable", 1], ["battery", 1]]), recipe("magnet", [["metal", 1], ["battery", 1]]),
  recipe("wheel", [["chassis", 1], ["gear", 1]]), recipe("fuel", [["chemical", 1], ["fire", 1]]),
  recipe("coolant", [["water", 2], ["chemical", 1], ["metal", 1]]), recipe("antenna", [["cable", 2], ["metal", 1]]),
  recipe("machine_tool", [["gear", 1], ["tools", 1], ["metal", 1]]), recipe("chip", [["sand", 1], ["chemical", 1], ["cable", 1]]),
  recipe("memory", [["chip", 1], ["metal", 1]]), recipe("display", [["glass", 1], ["chip", 1], ["lamp", 1]]),
  recipe("controller", [["chip", 1], ["gear", 1], ["battery", 1]]), recipe("radio", [["antenna", 1], ["controller", 1], ["battery", 1]]),
  recipe("robot", [["controller", 1], ["machine_tool", 1], ["battery", 1]]), recipe("fabricator", [["robot", 1], ["factory", 1], ["controller", 1]]),
  recipe("vehicle", [["wheel", 2], ["controller", 1], ["fuel", 1]]), recipe("computer", [["chip", 1], ["memory", 1], ["display", 1], ["controller", 1]]),
  recipe("server", [["computer", 2], ["coolant", 1]]), recipe("network", [["server", 1], ["antenna", 1], ["radio", 1]]),
  recipe("ai_core", [["server", 1], ["chip", 1], ["memory", 1]]), recipe("lab", [["computer", 1], ["glass", 1], ["chemical", 1]]),
  recipe("atom_core", [["lab", 1], ["battery", 1], ["magnet", 1]]), recipe("reactor", [["atom_core", 1], ["factory", 1], ["coolant", 1]]),
  recipe("solar_array", [["glass", 2], ["chip", 1], ["cable", 1]]), recipe("telescope", [["glass", 2], ["computer", 1], ["antenna", 1]]),
  recipe("rocket", [["fuel", 2], ["robot", 1], ["computer", 1], ["metal", 1]]),
  recipe("satellite", [["rocket", 1], ["antenna", 1], ["solar_array", 1], ["computer", 1]]),
  recipe("life_support", [["chemical", 1], ["water", 2], ["ai_core", 1], ["coolant", 1]]),
  recipe("lunar_base", [["rocket", 2], ["factory", 1], ["robot", 1], ["life_support", 1]]),
  recipe("star_map", [["telescope", 1], ["satellite", 1], ["ai_core", 1]]),
  recipe("starship", [["rocket", 2], ["reactor", 1], ["ai_core", 1], ["life_support", 1]]),
  recipe("superconductor", [["coolant", 2], ["metal", 1], ["reactor", 1]]),
  recipe("quantum_field", [["reactor", 1], ["superconductor", 1], ["ai_core", 1]]),
  recipe("quantum_sensor", [["quantum_field", 1], ["telescope", 1], ["chip", 1]]),
  recipe("spacetime_clock", [["quantum_sensor", 1], ["ai_core", 1], ["superconductor", 1]]),
  recipe("quantum_computer", [["ai_core", 2], ["quantum_sensor", 1], ["superconductor", 1]]),
  recipe("spacetime_map", [["star_map", 1], ["quantum_computer", 1], ["spacetime_clock", 1]]),
  recipe("singularity", [["reactor", 2], ["quantum_field", 1], ["quantum_computer", 1]]),
  recipe("gate_key", [["spacetime_map", 1], ["singularity", 1], ["ai_core", 1]]),
  recipe("gate_ring", [["superconductor", 4], ["metal", 4]]),
  recipe("stabilizer", [["quantum_field", 1], ["quantum_sensor", 1], ["reactor", 1]]),
  recipe("exotic_crystal", [["singularity", 1], ["chemical", 1], ["superconductor", 1]]),
  recipe("address_core", [["gate_key", 1], ["spacetime_map", 1], ["quantum_computer", 1]]),
  recipe("containment", [["gate_ring", 1], ["stabilizer", 1], ["ai_core", 1]]),
  recipe("energy_matrix", [["reactor", 2], ["exotic_crystal", 1], ["quantum_field", 1]]),
  recipe("stargate", [["gate_ring", 1], ["stabilizer", 1], ["exotic_crystal", 1], ["address_core", 1], ["containment", 1], ["energy_matrix", 1]]),
];

export const ITEM_BY_ID = new Map(ITEMS.map((entry) => [entry.id, entry]));
export const RECIPE_BY_ID = new Map(RECIPES.map((entry) => [entry.id, entry]));
export const RECIPE_BY_OUTPUT = new Map(RECIPES.map((entry) => [entry.output, entry]));

export const BASE_RECIPE_IDS = RECIPES.filter((entry) => entry.inputs.length === 0).map((entry) => entry.id);
/** 前 9 项是免费启蒙；第 10–15 项构成第一道市场挑战。 */
export const INTRO_RECIPE_IDS = RECIPES.slice(0, 9).map((entry) => entry.id);
export const MARKET_CHALLENGE_RECIPE_IDS = RECIPES.slice(9, 15).map((entry) => entry.id);
export const MARKET_CERTIFICATION_ITEM_IDS = RECIPES.slice(9, 15).map((entry) => entry.output);
/** 教学不会在免费配方结束时停止；玩家解锁后会继续带领猫咪首次制造到第 15 项。 */
export const TUTORIAL_RECIPE_IDS = RECIPES.slice(0, 15).map((entry) => entry.id);
/** 第 16–20 项共享第 10–15 项的实际制造认证闸门。 */
export const INDUSTRIAL_GATE_RECIPE_IDS = RECIPES.slice(15, 20).map((entry) => entry.id);

export interface CatalogAnalysis {
  workUnits: Record<ItemId, number>;
  basePrices: Record<ItemId, number>;
  sellPrices: Record<ItemId, number>;
}

export function validateCatalog(): CatalogAnalysis {
  if (ITEMS.length !== 65 || RECIPES.length !== 65) throw new Error(`Expected 65 items and recipes, got ${ITEMS.length}/${RECIPES.length}`);
  if (ITEM_BY_ID.size !== ITEMS.length) throw new Error("Duplicate item id");
  if (new Set(ITEMS.map((entry) => entry.emoji)).size !== ITEMS.length) throw new Error("Duplicate emoji");
  if (RECIPE_BY_ID.size !== RECIPES.length || RECIPE_BY_OUTPUT.size !== ITEMS.length) throw new Error("Duplicate or missing recipe");
  for (const entry of RECIPES) {
    if (!ITEM_BY_ID.has(entry.output)) throw new Error(`Unknown output ${entry.output}`);
    for (const input of entry.inputs) {
      if (!ITEM_BY_ID.has(input.itemId)) throw new Error(`Unknown ingredient ${input.itemId}`);
      if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new Error(`Invalid quantity in ${entry.id}`);
    }
    for (const requirement of entry.siteRequirements) {
      if (!DEPLOYABLE_BUILDING_IDS.includes(requirement.buildingItemId as typeof DEPLOYABLE_BUILDING_IDS[number])) {
        throw new Error(`Unknown building ${requirement.buildingItemId} in ${entry.id}`);
      }
      if (!Number.isInteger(requirement.maxManhattanDistance) || requirement.maxManhattanDistance <= 0) {
        throw new Error(`Invalid building range in ${entry.id}`);
      }
      if (requirement.minDifficulty !== undefined
        && (!Number.isInteger(requirement.minDifficulty) || requirement.minDifficulty < 1 || requirement.minDifficulty > 5)) {
        throw new Error(`Invalid difficulty gate in ${entry.id}`);
      }
    }
  }

  const workUnits: Record<string, number> = {};
  const visiting = new Set<string>();
  const calculate = (id: string): number => {
    if (workUnits[id]) return workUnits[id];
    if (visiting.has(id)) throw new Error(`Recipe cycle at ${id}`);
    visiting.add(id);
    const source = RECIPE_BY_OUTPUT.get(id);
    if (!source) throw new Error(`No recipe for ${id}`);
    const value = source.inputs.length === 0
      ? 1
      : 1 + source.inputs.reduce((sum, input) => sum + calculate(input.itemId) * input.quantity, 0);
    visiting.delete(id);
    workUnits[id] = value;
    return value;
  };
  for (const entry of ITEMS) calculate(entry.id);

  const sellPrices = Object.fromEntries(ITEMS.map((entry) => [entry.id, Math.ceil(workUnits[entry.id] * (1 + 0.15 * entry.tier))]));
  return { workUnits, basePrices: sellPrices, sellPrices };
}

export const CATALOG_ANALYSIS = validateCatalog();

export function recipeUnlockCost(recipeId: string): number {
  const entry = RECIPE_BY_ID.get(recipeId);
  if (!entry || INTRO_RECIPE_IDS.includes(recipeId)) return 0;
  return Math.max(100, CATALOG_ANALYSIS.sellPrices[entry.output] * 200);
}

export function recipePrerequisiteIds(recipeId: string): string[] {
  const entry = RECIPE_BY_ID.get(recipeId);
  if (!entry) return [];
  return [...new Set(entry.inputs.map((input) => RECIPE_BY_OUTPUT.get(input.itemId)?.id).filter((id): id is string => Boolean(id)))];
}

export function missingProductionCertifications(recipeId: string, craftedItems: Iterable<ItemId>): ItemId[] {
  if (!INDUSTRIAL_GATE_RECIPE_IDS.includes(recipeId)) return [];
  const crafted = new Set(craftedItems);
  return MARKET_CERTIFICATION_ITEM_IDS.filter((itemId) => !crafted.has(itemId));
}

export function canUnlockRecipe(recipeId: string, unlocked: Iterable<string>, craftedItems: Iterable<ItemId> = []): boolean {
  const entry = RECIPE_BY_ID.get(recipeId);
  if (!entry || entry.inputs.length === 0) return false;
  const known = new Set(unlocked);
  return !known.has(recipeId)
    && recipePrerequisiteIds(recipeId).every((id) => known.has(id))
    && missingProductionCertifications(recipeId, craftedItems).length === 0;
}

export function unlockedRecipeIds(discovered: Iterable<ItemId>): string[] {
  const known = new Set(discovered);
  return RECIPES.filter((entry) => entry.inputs.length === 0 || entry.inputs.every((input) => known.has(input.itemId))).map((entry) => entry.id);
}

export function describeRecipe(recipeId: string): string {
  const entry = RECIPE_BY_ID.get(recipeId);
  if (!entry) return recipeId;
  const output = ITEM_BY_ID.get(entry.output)!;
  if (entry.inputs.length === 0) return `${output.emoji} ${output.name}（空手采集）`;
  return `${output.emoji} ${output.name} = ${entry.inputs.map((input) => {
    const source = ITEM_BY_ID.get(input.itemId)!;
    return `${source.emoji}${source.name}${input.quantity > 1 ? `×${input.quantity}` : ""}`;
  }).join(" + ")}`;
}

export function itemDependencyDistance(sourceItemId: ItemId, targetItemId: ItemId): number {
  if (sourceItemId === targetItemId) return 0;
  const visiting = new Set<ItemId>();
  const visit = (target: ItemId): number => {
    if (sourceItemId === target) return 0;
    if (visiting.has(target)) return -1;
    visiting.add(target);
    const recipe = RECIPE_BY_OUTPUT.get(target);
    let best = Number.POSITIVE_INFINITY;
    for (const input of recipe?.inputs ?? []) {
      const distance = visit(input.itemId);
      if (distance >= 0) best = Math.min(best, distance + 1);
    }
    visiting.delete(target);
    return Number.isFinite(best) ? best : -1;
  };
  return visit(targetItemId);
}
