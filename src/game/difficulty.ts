import type { DifficultyLevel, RecipeDefinition } from "./types.js";

export interface DifficultyProfile {
  level: DifficultyLevel;
  name: string;
  description: string;
  initialTreasuryCents: number;
  bountyMultiplier: number;
  baseCreditCents: number;
  buildingAskMultiplier: number;
  parcelCostMultiplier: number;
  specializedSites: boolean;
  compoundSites: boolean;
  bulkRecipes: boolean;
}

export const DEFAULT_DIFFICULTY: DifficultyLevel = 3;
export const LEGACY_SAVE_DIFFICULTY: DifficultyLevel = 2;

export const DIFFICULTY_PROFILES: Readonly<Record<DifficultyLevel, DifficultyProfile>> = {
  1: {
    level: 1,
    name: "休闲",
    description: "宽松资金与单建筑范围",
    initialTreasuryCents: 25_000,
    bountyMultiplier: 4,
    baseCreditCents: 15_000,
    buildingAskMultiplier: 1.05,
    parcelCostMultiplier: 0.75,
    specializedSites: false,
    compoundSites: false,
    bulkRecipes: false,
  },
  2: {
    level: 2,
    name: "标准",
    description: "当前市场参数与产业认证",
    initialTreasuryCents: 15_000,
    bountyMultiplier: 3,
    baseCreditCents: 12_500,
    buildingAskMultiplier: 1.1,
    parcelCostMultiplier: 1,
    specializedSites: false,
    compoundSites: false,
    bulkRecipes: false,
  },
  3: {
    level: 3,
    name: "空间工业",
    description: "机床、天线与第一批复合工区",
    initialTreasuryCents: 15_000,
    bountyMultiplier: 3,
    baseCreditCents: 10_000,
    buildingAskMultiplier: 1.1,
    parcelCostMultiplier: 1,
    specializedSites: true,
    compoundSites: false,
    bulkRecipes: false,
  },
  4: {
    level: 4,
    name: "复合工业",
    description: "航天、量子和星门配方需要复合工区",
    initialTreasuryCents: 15_000,
    bountyMultiplier: 3,
    baseCreditCents: 7_500,
    buildingAskMultiplier: 1.1,
    parcelCostMultiplier: 1,
    specializedSites: true,
    compoundSites: true,
    bulkRecipes: false,
  },
  5: {
    level: 5,
    name: "极限物流",
    description: "复合工区与大宗汇聚配方",
    initialTreasuryCents: 15_000,
    bountyMultiplier: 3,
    baseCreditCents: 5_000,
    buildingAskMultiplier: 1.1,
    parcelCostMultiplier: 1,
    specializedSites: true,
    compoundSites: true,
    bulkRecipes: true,
  },
};

export function normalizeDifficulty(value: unknown, fallback: DifficultyLevel = DEFAULT_DIFFICULTY): DifficultyLevel {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 5 ? numeric as DifficultyLevel : fallback;
}

export function difficultyProfile(level: DifficultyLevel): DifficultyProfile {
  return DIFFICULTY_PROFILES[normalizeDifficulty(level)];
}

const BULK_INPUTS: Readonly<Record<string, ReadonlyArray<[string, number]>>> = {
  fabricator: [["factory", 2]],
  vehicle: [["wheel", 4], ["fuel", 2]],
  server: [["computer", 3], ["coolant", 2]],
  network: [["antenna", 2], ["radio", 2]],
  reactor: [["factory", 2], ["coolant", 2]],
  rocket: [["fuel", 4], ["metal", 2]],
  satellite: [["solar_array", 2]],
  lunar_base: [["robot", 2], ["life_support", 2]],
  starship: [["rocket", 3], ["reactor", 2]],
  energy_matrix: [["reactor", 3]],
};

export function effectiveRecipeInputs(recipe: RecipeDefinition, difficulty: DifficultyLevel): RecipeDefinition["inputs"] {
  if (difficulty < 5 || !BULK_INPUTS[recipe.output]) return recipe.inputs;
  const overrides = new Map(BULK_INPUTS[recipe.output]);
  return recipe.inputs.map((input) => ({ itemId: input.itemId, quantity: overrides.get(input.itemId) ?? input.quantity }));
}

export function difficultySiteRequirements(recipe: RecipeDefinition, difficulty: DifficultyLevel): RecipeDefinition["siteRequirements"] {
  return recipe.siteRequirements.filter((requirement) => (requirement.minDifficulty ?? 1) <= difficulty);
}
