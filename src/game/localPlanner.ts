import { ITEM_BY_ID, RECIPE_BY_ID, RECIPE_BY_OUTPUT, itemDependencyDistance } from "./catalog";
import { effectiveRecipeInputs } from "./difficulty";
import { siteFailure } from "./logistics";
import {
  bountyBroadcastsForCat,
  contractActionForCat,
  expectedActionGainCents,
  planForCatPublic,
  signalsForCat,
  unreservedOwnedQuantity,
  unofferedOwnedQuantity,
} from "./market";
import type { CatAction, CatState, GameState, ItemId, LogisticsStatus } from "./types";
import { positionKey } from "./world";
import { landmarkEffectsAt, type LandmarkSpatialIndex } from "./landmarks";

export const LOCAL_VISION_RADIUS = 2;

interface Candidate {
  action: Exclude<CatAction, null>;
  score: number;
  reason: string;
  targetItemId: ItemId;
  kind: LogisticsStatus["kind"];
}

export interface LocalLogisticsPlan {
  assignments: Map<string, Exclude<CatAction, null>>;
  traces: Map<string, string[]>;
  status: LogisticsStatus[];
}

export interface LocalActionWeights {
  craft: number;
  pass: number;
  sell: number;
}

export interface LocalScoreAdjustment {
  actionType: "craft" | "pass" | "sell" | "*";
  itemId: ItemId | "*";
  multiplier: number;
  bonus: number;
}

export function localVisibleCats(state: GameState, origin: CatState, positionMap?: Map<string, CatState>, radius = LOCAL_VISION_RADIUS): CatState[] {
  const map = positionMap ?? new Map(state.cats.map((cat) => [positionKey(cat.position), cat]));
  const visible: CatState[] = [];
  const effectiveRadius = Math.max(LOCAL_VISION_RADIUS, Math.min(5, Math.floor(radius)));
  for (let dy = -effectiveRadius; dy <= effectiveRadius; dy += 1) {
    const width = effectiveRadius - Math.abs(dy);
    for (let dx = -width; dx <= width; dx += 1) {
      const cat = map.get(`${origin.position.x + dx},${origin.position.y + dy}`);
      if (cat) visible.push(cat);
    }
  }
  return visible.sort((left, right) => (
    manhattan(left, origin) - manhattan(right, origin) || left.createdIndex - right.createdIndex
  ));
}

export function planLocalLogistics(state: GameState, priceOf: (itemId: ItemId) => number, landmarkIndex?: LandmarkSpatialIndex): LocalLogisticsPlan {
  const assignments = new Map<string, Exclude<CatAction, null>>();
  const traces = new Map<string, string[]>();
  const status: LogisticsStatus[] = [];
  const map = new Map(state.cats.map((cat) => [positionKey(cat.position), cat]));
  for (const cat of [...state.cats].sort((a, b) => a.createdIndex - b.createdIndex)) {
    const visible = localVisibleCats(state, cat, map, landmarkEffectsAt(state, cat.position, landmarkIndex).effectiveVisionRadius);
    if (cat.action) {
      traces.set(cat.id, [`局部视野 ${visible.length} 个工位 · 已在工作`]);
      continue;
    }
    const candidate = chooseLocalAction(state, cat, priceOf, { craft: 1, pass: 1, sell: 1 });
    if (candidate) assignments.set(cat.id, candidate.action);
    const plan = planForCatPublic(state, cat.id);
    const message = candidate
      ? `利己收益 ${candidate.score.toFixed(0)}分：${candidate.reason}`
      : plan
        ? `等待订单 ${plan.outputItemId} 的原料到达`
        : `局部视野 ${visible.length} 个工位内没有非亏损动作`;
    traces.set(cat.id, [message]);
    status.push({
      componentId: `local-${cat.id}`,
      catIds: visible.map((entry) => entry.id),
      kind: candidate?.kind ?? "idle",
      targetItemId: candidate?.targetItemId ?? plan?.outputItemId ?? null,
      blockedReason: candidate ? null : message,
    });
  }
  return { assignments, traces, status };
}

export function chooseWeightedLocalAction(
  state: GameState,
  cat: CatState,
  priceOf: (itemId: ItemId) => number,
  weights: LocalActionWeights,
): CatAction {
  return chooseLocalAction(state, cat, priceOf, {
    craft: clampWeight(weights.craft),
    pass: clampWeight(weights.pass),
    sell: clampWeight(weights.sell),
  })?.action ?? null;
}

export function chooseAdjustedLocalAction(
  state: GameState,
  cat: CatState,
  priceOf: (itemId: ItemId) => number,
  adjustments: ReadonlyArray<LocalScoreAdjustment>,
): CatAction {
  return chooseLocalAction(state, cat, priceOf, { craft: 1, pass: 1, sell: 1 }, adjustments)?.action ?? null;
}

function chooseLocalAction(
  state: GameState,
  cat: CatState,
  priceOf: (itemId: ItemId) => number,
  weights: LocalActionWeights,
  adjustments: ReadonlyArray<LocalScoreAdjustment> = [],
): Candidate | undefined {
  const candidates: Candidate[] = [];
  const contractAction = contractActionForCat(state, cat);
  if (contractAction?.type === "pass") {
    candidates.push({
      action: contractAction,
      score: 1_000_000 + expectedActionGainCents(state, cat, contractAction, priceOf),
      reason: `履行有偿运输合同 ${contractAction.itemId}`,
      targetItemId: contractAction.itemId,
      kind: "profit",
    });
  }

  const activePlan = planForCatPublic(state, cat.id);
  const heardItems = new Set(signalsForCat(state, cat.id)
    .map((signal) => state.demandOrders.find((order) => order.id === signal.orderId)?.itemId)
    .filter((itemId): itemId is ItemId => Boolean(itemId)));
  const heardBounties = new Set(bountyBroadcastsForCat(state, cat.id).map((broadcast) => broadcast.itemId));
  const planNeeds = activePlan ? neededItemsForTarget(activePlan.outputItemId, cat.inventory, state.difficulty) : new Set<ItemId>();
  const heardNeeds = new Map([...heardItems].map((itemId) => [itemId, neededItemsForTarget(itemId, cat.inventory, state.difficulty)]));
  const protectedInputs = new Set(
    activePlan ? effectiveRecipeInputs(RECIPE_BY_ID.get(activePlan.recipeId)!, state.difficulty).map((input) => input.itemId) ?? [] : [],
  );
  for (const recipeId of state.unlockedRecipes) {
    const recipe = RECIPE_BY_ID.get(recipeId);
    if (!recipe || siteFailure(state, cat, recipe)) continue;
    const planDistance = activePlan && planNeeds.has(recipe.output)
      ? itemDependencyDistance(recipe.output, activePlan.outputItemId)
      : -1;
    const orderDistance = [...heardNeeds.entries()].reduce((best, [targetItemId, needed]) => {
      if (!needed.has(recipe.output)) return best;
      const distance = itemDependencyDistance(recipe.output, targetItemId);
      return distance >= 0 && (best < 0 || distance < best) ? distance : best;
    }, -1);
    const producingForPlan = planDistance >= 0;
    const producingForOrder = orderDistance >= 0;
    const bountyAvailable = heardBounties.has(recipe.output);
    if (!producingForPlan && !producingForOrder && !bountyAvailable) continue;
    if (activePlan?.recipeId !== recipeId && effectiveRecipeInputs(recipe, state.difficulty).some((input) => protectedInputs.has(input.itemId))) continue;
    if (recipe.inputs.length === 0
      && activePlan?.recipeId !== recipeId
      && !producingForOrder
      && unreservedOwnedQuantity(state, cat, recipe.output) >= 1) continue;
    if (!effectiveRecipeInputs(recipe, state.difficulty).every((input) => unofferedOwnedQuantity(state, cat, input.itemId) >= input.quantity)) continue;
    const action: Exclude<CatAction, null> = { type: "craft", recipeId };
    const gain = expectedActionGainCents(state, cat, action, priceOf);
    if (gain < 0) continue;
    candidates.push({
      action,
      score: gain + (activePlan?.recipeId === recipeId
        ? 100_000
        : producingForPlan
          ? 80_000 - planDistance * 1_000
          : producingForOrder
            ? 50_000 - orderDistance * 1_000
            : 0),
      reason: activePlan?.recipeId === recipeId ? `执行盈利计划，制作 ${recipe.output}` : producingForOrder ? `响应全局订单广播，制作 ${recipe.output}` : `制作后净资产不下降：${recipe.output}`,
      targetItemId: recipe.output,
      kind: activePlan?.reason === "bounty" ? "tutorial" : "profit",
    });
  }

  for (const [itemId, quantity] of Object.entries(cat.inventory)) {
    if (quantity <= 0 || unreservedOwnedQuantity(state, cat, itemId) <= 0 || !ITEM_BY_ID.has(itemId) || protectedInputs.has(itemId)) continue;
    const action: Exclude<CatAction, null> = { type: "sell", itemId };
    const gain = expectedActionGainCents(state, cat, action, priceOf);
    if (gain <= 0) continue;
    candidates.push({
      action,
      score: gain,
      reason: `外部出售 ${itemId}，税后收入 ${gain}分`,
      targetItemId: itemId,
      kind: "profit",
    });
  }

  for (const candidate of candidates) {
    candidate.score *= weights[candidate.action.type];
    for (const adjustment of adjustments) {
      if (adjustment.actionType !== "*" && adjustment.actionType !== candidate.action.type) continue;
      if (adjustment.itemId !== "*" && adjustment.itemId !== candidate.targetItemId) continue;
      candidate.score = candidate.score * clampWeight(adjustment.multiplier) + clampBonus(adjustment.bonus);
    }
  }
  return candidates.filter((candidate) => candidate.score > 0).sort((left, right) => (
    right.score - left.score
    || left.targetItemId.localeCompare(right.targetItemId)
    || actionKey(left.action).localeCompare(actionKey(right.action))
  ))[0];
}

function neededItemsForTarget(targetItemId: ItemId, inventory: Readonly<Record<ItemId, number>>, difficulty: GameState["difficulty"]): Set<ItemId> {
  const needed = new Set<ItemId>([targetItemId]);
  const visiting = new Set<ItemId>();
  const visit = (itemId: ItemId): void => {
    if (visiting.has(itemId)) return;
    visiting.add(itemId);
    const recipe = RECIPE_BY_OUTPUT.get(itemId);
    for (const input of recipe ? effectiveRecipeInputs(recipe, difficulty) : []) {
      if ((inventory[input.itemId] ?? 0) >= input.quantity) continue;
      needed.add(input.itemId);
      visit(input.itemId);
    }
    visiting.delete(itemId);
  };
  visit(targetItemId);
  return needed;
}

function clampWeight(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 1;
}

function clampBonus(value: number): number {
  return Number.isFinite(value) ? Math.max(-1_000_000, Math.min(1_000_000, value)) : 0;
}

function actionKey(action: Exclude<CatAction, null>): string {
  return action.type === "craft" ? action.recipeId : `${action.type}:${action.itemId}:${action.type === "pass" ? action.direction : ""}`;
}

function manhattan(left: CatState, right: CatState): number {
  return Math.abs(left.position.x - right.position.x) + Math.abs(left.position.y - right.position.y);
}
