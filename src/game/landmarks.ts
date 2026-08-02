import type {
  DeployedLandmark,
  GameState,
  LandmarkDefinition,
  LandmarkEffects,
  LandmarkId,
  Position,
} from "./types";
import { resourceItemsAt } from "./logistics";
import { isPositionUnlocked, positionKey } from "./world";

export const LANDMARK_DEFINITIONS: readonly LandmarkDefinition[] = [
  {
    id: "founders_plaza", emoji: "⛲", name: "创业广场", radius: 2, blueprintPriceCents: 1_000,
    materials: [{ itemId: "stone", quantity: 6 }, { itemId: "plank", quantity: 2 }, { itemId: "tools", quantity: 1 }],
    description: "半径 2 · 全部动作加速 10%", effects: { actionSpeedReduction: 0.10 },
  },
  {
    id: "craft_academy", emoji: "🏛️", name: "工匠学院", radius: 3, blueprintPriceCents: 3_000,
    materials: [{ itemId: "brick", quantity: 4 }, { itemId: "paper", quantity: 4 }, { itemId: "tools", quantity: 2 }, { itemId: "glass", quantity: 2 }],
    description: "半径 3 · 制作加速 20%", effects: { craftSpeedReduction: 0.20 },
  },
  {
    id: "logistics_hub", emoji: "🚉", name: "物流枢纽", radius: 4, blueprintPriceCents: 15_800,
    materials: [{ itemId: "chassis", quantity: 4 }, { itemId: "wheel", quantity: 4 }, { itemId: "fuel", quantity: 2 }, { itemId: "radio", quantity: 1 }],
    description: "半径 4 · 传递加速 25% · 中转费 +20%", effects: { passSpeedReduction: 0.25, carrierFeeBonus: 0.20 },
  },
  {
    id: "market_center", emoji: "🏦", name: "商贸中心", radius: 3, blueprintPriceCents: 31_700,
    materials: [{ itemId: "brick", quantity: 6 }, { itemId: "display", quantity: 2 }, { itemId: "radio", quantity: 2 }, { itemId: "computer", quantity: 1 }],
    description: "半径 3 · 外部售价 +15% · 信用 +25 金币", effects: { saleValueBonus: 0.15, creditBonusCents: 2_500 },
  },
  {
    id: "energy_spire", emoji: "⚡", name: "能源尖塔", radius: 4, blueprintPriceCents: 19_000,
    materials: [{ itemId: "battery", quantity: 6 }, { itemId: "cable", quantity: 4 }, { itemId: "controller", quantity: 2 }, { itemId: "solar_array", quantity: 2 }],
    description: "半径 4 · 制作与传递加速 15%", effects: { craftSpeedReduction: 0.15, passSpeedReduction: 0.15 },
  },
  {
    id: "quantum_beacon", emoji: "🗼", name: "量子信标", radius: 5, blueprintPriceCents: 287_000,
    materials: [{ itemId: "satellite", quantity: 2 }, { itemId: "ai_core", quantity: 2 }, { itemId: "quantum_sensor", quantity: 1 }, { itemId: "superconductor", quantity: 2 }],
    description: "半径 5 · 观察半径 +1 · 全部动作加速 5%", effects: { visionRadiusBonus: 1, actionSpeedReduction: 0.05 },
  },
] as const;

export const LANDMARK_BY_ID = new Map(LANDMARK_DEFINITIONS.map((definition) => [definition.id, definition]));
export const MAX_LANDMARK_RADIUS = 5;
export type LandmarkSpatialIndex = ReadonlyMap<string, readonly DeployedLandmark[]>;

const emptyStacks = (): Record<LandmarkId, number> => Object.fromEntries(
  LANDMARK_DEFINITIONS.map((definition) => [definition.id, 0]),
) as Record<LandmarkId, number>;

export function createLandmarkSpatialIndex(state: GameState): LandmarkSpatialIndex {
  const mutable = new Map<string, DeployedLandmark[]>();
  for (const landmark of state.landmarks) {
    const key = positionKey(landmark.position);
    const entries = mutable.get(key) ?? [];
    entries.push(landmark);
    mutable.set(key, entries);
  }
  return mutable;
}

export function landmarkEffectsAt(
  state: GameState,
  position: Position,
  index?: LandmarkSpatialIndex,
): LandmarkEffects {
  const stacks = emptyStacks();
  const consider = (landmark: DeployedLandmark) => {
    const definition = LANDMARK_BY_ID.get(landmark.landmarkId);
    if (!definition) return;
    const distance = Math.abs(position.x - landmark.position.x) + Math.abs(position.y - landmark.position.y);
    if (distance <= definition.radius) stacks[definition.id] = Math.min(3, stacks[definition.id] + 1);
  };
  if (index) {
    for (let dy = -MAX_LANDMARK_RADIUS; dy <= MAX_LANDMARK_RADIUS; dy += 1) {
      const width = MAX_LANDMARK_RADIUS - Math.abs(dy);
      for (let dx = -width; dx <= width; dx += 1) {
        for (const landmark of index.get(`${position.x + dx},${position.y + dy}`) ?? []) consider(landmark);
      }
    }
  } else {
    for (const landmark of state.landmarks) consider(landmark);
  }
  const totals = {
    actionSpeedReduction: 0,
    craftSpeedReduction: 0,
    passSpeedReduction: 0,
    saleValueBonus: 0,
    creditBonusCents: 0,
    carrierFeeBonus: 0,
    visionRadiusBonus: 0,
  };
  for (const definition of LANDMARK_DEFINITIONS) {
    const count = stacks[definition.id];
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
      totals[key] += (definition.effects[key] ?? 0) * count;
    }
  }
  totals.actionSpeedReduction = Math.min(0.60, totals.actionSpeedReduction);
  totals.craftSpeedReduction = Math.min(0.60, totals.craftSpeedReduction);
  totals.passSpeedReduction = Math.min(0.60, totals.passSpeedReduction);
  totals.saleValueBonus = Math.min(0.45, totals.saleValueBonus);
  totals.creditBonusCents = Math.min(7_500, totals.creditBonusCents);
  totals.carrierFeeBonus = Math.min(0.60, totals.carrierFeeBonus);
  totals.visionRadiusBonus = Math.min(3, totals.visionRadiusBonus);
  return {
    ...totals,
    effectiveVisionRadius: Math.min(5, 2 + totals.visionRadiusBonus),
    stacks,
  };
}

export function actionSpeedReductionAt(
  state: GameState,
  position: Position,
  actionType: "craft" | "pass" | "sell",
  index?: LandmarkSpatialIndex,
): number {
  const effects = landmarkEffectsAt(state, position, index);
  const specific = actionType === "craft" ? effects.craftSpeedReduction : actionType === "pass" ? effects.passSpeedReduction : 0;
  return Math.min(0.60, effects.actionSpeedReduction + specific);
}

export function buyLandmarkBlueprint(state: GameState, landmarkId: LandmarkId): { ok: boolean; error?: string; cost?: number } {
  const definition = LANDMARK_BY_ID.get(landmarkId);
  if (!definition) return { ok: false, error: "未知地标图纸" };
  if (state.unlockedLandmarkIds.includes(landmarkId)) return { ok: false, error: "图纸已经永久解锁" };
  const undiscovered = definition.materials.filter((material) => !state.discoveredItems.includes(material.itemId));
  if (undiscovered.length) return { ok: false, error: `尚有 ${undiscovered.length} 种建材未发现` };
  if (state.treasuryCoins < definition.blueprintPriceCents) return { ok: false, error: "国库金币不足" };
  state.treasuryCoins -= definition.blueprintPriceCents;
  state.unlockedLandmarkIds.push(landmarkId);
  state.dirtyDecisions = true;
  return { ok: true, cost: definition.blueprintPriceCents };
}

export function landmarkPlacementFailure(state: GameState, landmarkId: LandmarkId, position: Position): string | null {
  const definition = LANDMARK_BY_ID.get(landmarkId);
  if (!definition) return "未知地标";
  if (!state.unlockedLandmarkIds.includes(landmarkId)) return "请先购买图纸";
  if (!Number.isInteger(position.x) || !Number.isInteger(position.y)) return "地标坐标必须是整数";
  if (!isPositionUnlocked(state.unlockedParcels, position)) return "只能建在已开拓土地";
  if (state.cats.some((cat) => positionKey(cat.position) === positionKey(position))) return "该格已有猫咪工位";
  if (state.resourceNodes.some((node) => positionKey(node.position) === positionKey(position)) || resourceItemsAt(state, position).length > 0) return "资源中心和采集格不能建地标";
  if (state.buildings.some((building) => positionKey(building.position) === positionKey(position))) return "该格已有工业建筑";
  if (state.landmarks.some((landmark) => positionKey(landmark.position) === positionKey(position))) return "该格已有地标";
  for (const material of definition.materials) {
    if ((state.playerBuildingInventory[material.itemId] ?? 0) < material.quantity) return `仓库缺少 ${material.itemId} ×${material.quantity}`;
  }
  return null;
}

export function placeLandmark(state: GameState, landmarkId: LandmarkId, position: Position): { ok: boolean; error?: string; landmark?: DeployedLandmark } {
  const failure = landmarkPlacementFailure(state, landmarkId, position);
  if (failure) return { ok: false, error: failure };
  const definition = LANDMARK_BY_ID.get(landmarkId)!;
  const landmark: DeployedLandmark = {
    id: `landmark-${state.nextLandmarkIndex++}`,
    landmarkId,
    position: { ...position },
    deployedAt: state.simTime,
  };
  for (const material of definition.materials) {
    state.playerBuildingInventory[material.itemId] -= material.quantity;
    if (state.playerBuildingInventory[material.itemId] <= 0) delete state.playerBuildingInventory[material.itemId];
  }
  state.landmarks.push(landmark);
  state.dirtyDecisions = true;
  return { ok: true, landmark };
}

export function dismantleLandmark(state: GameState, deployedId: string): { ok: boolean; error?: string; refunded?: Record<string, number> } {
  const index = state.landmarks.findIndex((landmark) => landmark.id === deployedId);
  if (index < 0) return { ok: false, error: "地标不存在" };
  const landmark = state.landmarks[index];
  const definition = LANDMARK_BY_ID.get(landmark.landmarkId);
  if (!definition) return { ok: false, error: "地标定义不存在" };
  const refunded: Record<string, number> = {};
  for (const material of definition.materials) {
    const quantity = Math.floor(material.quantity / 2);
    if (quantity <= 0) continue;
    state.playerBuildingInventory[material.itemId] = (state.playerBuildingInventory[material.itemId] ?? 0) + quantity;
    refunded[material.itemId] = quantity;
  }
  state.landmarks.splice(index, 1);
  state.dirtyDecisions = true;
  return { ok: true, refunded };
}
