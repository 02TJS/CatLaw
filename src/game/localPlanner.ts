import { RECIPE_BY_ID, RECIPE_BY_OUTPUT, itemDependencyDistance } from "./catalog";
import { effectiveRecipeInputs } from "./difficulty";
import { siteFailure } from "./logistics";
import {
  availableInputQuantityForPlan,
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
  influences: Map<string, { delta: number; priority: number }>;
}

export interface LocalActionDecision {
  action: Exclude<CatAction, null>;
  score: number;
  reason: string;
  targetItemId: ItemId;
  kind: LogisticsStatus["kind"];
  attributedLawId?: string;
}

export interface LocalLogisticsPlan {
  assignments: Map<string, Exclude<CatAction, null>>;
  decisions: Map<string, LocalActionDecision>;
  traces: Map<string, string[]>;
  status: LogisticsStatus[];
}

export interface LocalActionWeights {
  craft: number;
  pass: number;
}

export interface LocalScoreAdjustment {
  actionType: "craft" | "pass" | "*";
  itemId: ItemId | "*";
  multiplier: number;
  bonus: number;
  lawId?: string;
  lawPriority?: number;
}

export function localVisibleCats(state: GameState, origin: CatState, positionMap?: Map<string, CatState>, _radius = LOCAL_VISION_RADIUS): CatState[] {
  const map = positionMap ?? new Map(state.cats.map((cat) => [positionKey(cat.position), cat]));
  const visible: CatState[] = [];
  const effectiveRadius = LOCAL_VISION_RADIUS;
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

export function planLocalLogistics(state: GameState, priceOf: (itemId: ItemId, cat: CatState) => number, landmarkIndex?: LandmarkSpatialIndex): LocalLogisticsPlan {
  const assignments = new Map<string, Exclude<CatAction, null>>();
  const decisions = new Map<string, LocalActionDecision>();
  const traces = new Map<string, string[]>();
  const status: LogisticsStatus[] = [];
  const map = new Map(state.cats.map((cat) => [positionKey(cat.position), cat]));
  for (const cat of [...state.cats].sort((a, b) => a.createdIndex - b.createdIndex)) {
    const visible = localVisibleCats(state, cat, map);
    if (cat.action) {
      traces.set(cat.id, [`局部视野 ${visible.length} 个工位 · 已在工作`]);
      continue;
    }
    const candidate = chooseLocalAction(state, cat, (itemId) => priceOf(itemId, cat), { craft: 1, pass: 1 });
    if (candidate) {
      assignments.set(cat.id, candidate.action);
      decisions.set(cat.id, toDecision(candidate));
    }
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
  return { assignments, decisions, traces, status };
}

export function chooseAdjustedLocalAction(
  state: GameState,
  cat: CatState,
  priceOf: (itemId: ItemId) => number,
  adjustments: ReadonlyArray<LocalScoreAdjustment>,
): CatAction {
  return chooseLocalAction(state, cat, priceOf, { craft: 1, pass: 1 }, adjustments)?.action ?? null;
}

export function chooseAdjustedLocalDecision(
  state: GameState,
  cat: CatState,
  priceOf: (itemId: ItemId) => number,
  adjustments: ReadonlyArray<LocalScoreAdjustment>,
): LocalActionDecision | null {
  const candidate = chooseLocalAction(state, cat, priceOf, { craft: 1, pass: 1 }, adjustments);
  return candidate ? toDecision(candidate) : null;
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
      reason: "履行有偿运输合同",
      targetItemId: contractAction.itemId,
      kind: "profit",
      influences: new Map(),
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
    // A funded procurement plan owns exactly one production job. Missing
    // ingredients must arrive through its committed orders; the buyer may not
    // silently recurse through the recipe tree and make every part itself.
    const producingForPlan = activePlan?.recipeId === recipeId;
    const producingForOrder = false;
    const bountyAvailable = false;
    if (!producingForPlan && !producingForOrder && !bountyAvailable) continue;
    if (activePlan?.recipeId !== recipeId && effectiveRecipeInputs(recipe, state.difficulty).some((input) => protectedInputs.has(input.itemId))) continue;
    if (recipe.inputs.length === 0
      && activePlan?.recipeId !== recipeId
      && !producingForOrder
      && unreservedOwnedQuantity(state, cat, recipe.output) >= 1) continue;
    if (!effectiveRecipeInputs(recipe, state.difficulty).every((input) => (
      !activePlan || availableInputQuantityForPlan(state, cat, activePlan, input.itemId) >= input.quantity
    ))) continue;
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
      reason: activePlan?.recipeId === recipeId ? "执行盈利生产计划" : producingForOrder ? "响应全局订单广播" : "预计不会降低净资产",
      targetItemId: recipe.output,
      kind: activePlan?.reason === "bounty" ? "bounty" : "profit",
      influences: new Map(),
    });
  }

  for (const candidate of candidates) {
    candidate.score *= weights[candidate.action.type];
    for (const adjustment of adjustments) {
      if (adjustment.actionType !== "*" && adjustment.actionType !== candidate.action.type) continue;
      if (adjustment.itemId !== "*" && adjustment.itemId !== candidate.targetItemId) continue;
      const before = candidate.score;
      candidate.score = candidate.score * clampWeight(adjustment.multiplier) + clampBonus(adjustment.bonus);
      const delta = candidate.score - before;
      if (delta > 0 && adjustment.lawId) {
        const previous = candidate.influences.get(adjustment.lawId);
        candidate.influences.set(adjustment.lawId, {
          delta: (previous?.delta ?? 0) + delta,
          priority: Math.min(previous?.priority ?? Number.MAX_SAFE_INTEGER, adjustment.lawPriority ?? Number.MAX_SAFE_INTEGER),
        });
      }
    }
  }
  return candidates.filter((candidate) => candidate.score > 0).sort((left, right) => (
    right.score - left.score
    || left.targetItemId.localeCompare(right.targetItemId)
    || actionKey(left.action).localeCompare(actionKey(right.action))
  ))[0];
}

function toDecision(candidate: Candidate): LocalActionDecision {
  const attributedLawId = [...candidate.influences.entries()].sort((left, right) => (
    right[1].delta - left[1].delta
    || left[1].priority - right[1].priority
    || left[0].localeCompare(right[0])
  ))[0]?.[0];
  return {
    action: candidate.action,
    score: candidate.score,
    reason: candidate.reason,
    targetItemId: candidate.targetItemId,
    kind: candidate.kind,
    attributedLawId,
  };
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
