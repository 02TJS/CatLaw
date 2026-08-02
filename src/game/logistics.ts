import { CATALOG_ANALYSIS, ITEM_BY_ID, RECIPE_BY_ID, RECIPE_BY_OUTPUT, TUTORIAL_RECIPE_IDS } from "./catalog";
import { difficultySiteRequirements, effectiveRecipeInputs } from "./difficulty";
import type { CatAction, CatState, Direction, GameState, ItemId, LogisticsStatus, Position, RecipeDefinition } from "./types";
import { positionKey, resourceNodesAtPosition } from "./world";

const OFFSETS: Record<Direction, Position> = {
  north: { x: 0, y: -1 },
  east: { x: 1, y: 0 },
  south: { x: 0, y: 1 },
  west: { x: -1, y: 0 },
};
const DIRECTIONS: Direction[] = ["north", "east", "south", "west"];

export interface LogisticsPlan {
  assignments: Map<string, Exclude<CatAction, null>>;
  traces: Map<string, string[]>;
  status: LogisticsStatus[];
}

export function resourceItemAt(state: GameState, position: Position): ItemId | undefined {
  return resourceItemsAt(state, position)[0];
}

export function resourceItemsAt(state: GameState, position: Position): ItemId[] {
  return resourceNodesAtPosition(state.resourceNodes, position).map((node) => node.itemId);
}

export function siteFailure(state: GameState, cat: CatState, recipe: RecipeDefinition): string | null {
  if (recipe.inputs.length === 0) {
    return resourceItemsAt(state, cat.position).includes(recipe.output)
      ? null
      : `这里不在 ${ITEM_BY_ID.get(recipe.output)?.name ?? recipe.output}采集区`;
  }
  for (const requirement of difficultySiteRequirements(recipe, state.difficulty)) {
    const nearby = state.buildings.some((building) => building.itemId === requirement.buildingItemId
      && manhattan(building.position, cat.position) <= requirement.maxManhattanDistance);
    if (!nearby) {
      return `需要位于${ITEM_BY_ID.get(requirement.buildingItemId)?.name ?? requirement.buildingItemId}${requirement.maxManhattanDistance}格内`;
    }
  }
  return null;
}

export function planLogistics(state: GameState, priceOf: (itemId: ItemId) => number): LogisticsPlan {
  const assignments = new Map<string, Exclude<CatAction, null>>();
  const traces = new Map<string, string[]>();
  const status: LogisticsStatus[] = [];
  const shadow = new Map(state.cats.map((cat) => [cat.id, { ...cat.inventory }]));
  const map = new Map(state.cats.map((cat) => [positionKey(cat.position), cat]));
  const components = connectedComponents(state.cats, map);

  for (const component of components) {
    const ids = new Set(component.map((cat) => cat.id));
    const order = [...state.buildingOrders].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .find((entry) => ids.has(entry.targetCatId));
    const tutorial = nextTutorial(state);
    let kind: LogisticsStatus["kind"] = "idle";
    let target: RecipeDefinition | undefined;
    let destination: CatState | undefined;
    let blockedReason: string | null = null;

    if (order) {
      kind = "building";
      target = RECIPE_BY_OUTPUT.get(order.itemId);
      destination = component.find((cat) => cat.id === order.targetCatId);
      if (!target || !destination) blockedReason = "建筑订单目标不存在";
      else if (!component.some((cat) => (cat.inventory[order.itemId] ?? 0) > 0)
        && !isFeasible(state, component, target)) blockedReason = "缺少已连通的资源或合法制造工位";
    } else if (tutorial && isFeasible(state, component, tutorial)) {
      kind = "tutorial";
      target = tutorial;
    } else {
      target = bestProfitTarget(state, component, priceOf);
      kind = target ? "profit" : "idle";
      if (!target && tutorial) blockedReason = `教学目标 ${tutorial.output} 在此猫链不可达`;
    }
    if (target && !blockedReason) {
      const producer = selectProducer(state, component, target, destination, map);
      if (!producer) blockedReason = "没有满足资源或建筑范围的制造猫";
      else if (kind === "profit") {
        const holder = component.filter((cat) => available(shadow, cat.id, target!.output) > 0 && idle(cat, assignments))
          .sort((a, b) => a.createdIndex - b.createdIndex)[0];
        if (holder) assignSell(assignments, shadow, holder, target.output);
        else {
          sellUnneeded(state, component, recipeClosure(target.output), assignments, shadow, priceOf);
          ensureAt(state, component, target.output, producer, assignments, shadow, map, new Set());
        }
      } else {
        ensureAt(state, component, target.output, destination ?? producer, assignments, shadow, map, new Set());
      }
      fillParallelCrafts(state, component, target, assignments, shadow);
      fillBaseBuffers(state, component, target, assignments, shadow);
    } else if (!tutorial) {
      fallback(state, component, assignments, shadow, priceOf);
    }

    const message = blockedReason ?? (target
      ? `${kind === "building" ? "筹建" : kind === "tutorial" ? "教学" : "赚钱"}目标：${target.output}`
      : "没有可行目标");
    for (const cat of component) traces.set(cat.id, [message]);
    status.push({
      componentId: `component-${component[0]?.createdIndex ?? "empty"}`,
      catIds: component.map((cat) => cat.id),
      kind,
      targetItemId: target?.output ?? null,
      blockedReason,
    });
  }
  return { assignments, traces, status };
}

function idle(cat: CatState, assignments: Map<string, Exclude<CatAction, null>>): boolean {
  return !cat.action && !assignments.has(cat.id);
}

function available(shadow: Map<string, Record<ItemId, number>>, catId: string, itemId: ItemId): number {
  return shadow.get(catId)?.[itemId] ?? 0;
}

function reserve(shadow: Map<string, Record<ItemId, number>>, catId: string, itemId: ItemId, quantity = 1): boolean {
  const inventory = shadow.get(catId)!;
  if ((inventory[itemId] ?? 0) < quantity) return false;
  inventory[itemId] -= quantity;
  if (inventory[itemId] <= 0) delete inventory[itemId];
  return true;
}

function connectedComponents(cats: CatState[], map: Map<string, CatState>): CatState[][] {
  const remaining = new Set(cats.map((cat) => cat.id));
  const result: CatState[][] = [];
  for (const first of [...cats].sort((a, b) => a.createdIndex - b.createdIndex)) {
    if (!remaining.delete(first.id)) continue;
    const queue = [first];
    const component: CatState[] = [];
    while (queue.length) {
      const cat = queue.shift()!;
      component.push(cat);
      for (const direction of DIRECTIONS) {
        const offset = OFFSETS[direction];
        const neighbor = map.get(`${cat.position.x + offset.x},${cat.position.y + offset.y}`);
        if (neighbor && remaining.delete(neighbor.id)) queue.push(neighbor);
      }
    }
    result.push(component.sort((a, b) => a.createdIndex - b.createdIndex));
  }
  return result;
}

function pathBetween(component: CatState[], from: CatState, to: CatState, map: Map<string, CatState>): CatState[] | null {
  if (from.id === to.id) return [from];
  const allowed = new Set(component.map((cat) => cat.id));
  const byId = new Map(component.map((cat) => [cat.id, cat]));
  const queue = [from];
  const visited = new Set([from.id]);
  const previous = new Map<string, string>();
  while (queue.length) {
    const current = queue.shift()!;
    for (const direction of DIRECTIONS) {
      const offset = OFFSETS[direction];
      const neighbor = map.get(`${current.position.x + offset.x},${current.position.y + offset.y}`);
      if (!neighbor || !allowed.has(neighbor.id) || visited.has(neighbor.id)) continue;
      previous.set(neighbor.id, current.id);
      if (neighbor.id === to.id) {
        const ids = [to.id];
        let cursor = to.id;
        while (cursor !== from.id) {
          cursor = previous.get(cursor)!;
          ids.push(cursor);
        }
        return ids.reverse().map((id) => byId.get(id)!);
      }
      visited.add(neighbor.id);
      queue.push(neighbor);
    }
  }
  return null;
}

function directionBetween(from: Position, to: Position): Direction {
  if (to.y < from.y) return "north";
  if (to.x > from.x) return "east";
  if (to.y > from.y) return "south";
  return "west";
}

function nextTutorial(state: GameState): RecipeDefinition | undefined {
  return TUTORIAL_RECIPE_IDS.map((id) => RECIPE_BY_ID.get(id)).find((recipe) => recipe
    && state.unlockedRecipes.includes(recipe.id)
    && !state.discoveredItems.includes(recipe.output));
}

function isFeasible(state: GameState, component: CatState[], recipe: RecipeDefinition, visiting = new Set<string>()): boolean {
  if (!state.unlockedRecipes.includes(recipe.id) || visiting.has(recipe.id)) return false;
  const next = new Set(visiting).add(recipe.id);
  const producerExists = recipe.inputs.length === 0
    ? component.some((cat) => resourceItemsAt(state, cat.position).includes(recipe.output))
    : component.some((cat) => siteFailure(state, cat, recipe) === null);
  return producerExists && effectiveRecipeInputs(recipe, state.difficulty).every((input) => {
    const source = RECIPE_BY_OUTPUT.get(input.itemId);
    return Boolean(source && isFeasible(state, component, source, next));
  });
}

function bestProfitTarget(state: GameState, component: CatState[], priceOf: (itemId: ItemId) => number): RecipeDefinition | undefined {
  return state.unlockedRecipes.map((id) => RECIPE_BY_ID.get(id))
    .filter((recipe): recipe is RecipeDefinition => Boolean(recipe && isFeasible(state, component, recipe)))
    .sort((left, right) => {
      const leftCost = CATALOG_ANALYSIS.workUnits[left.output] + 1 + transportEstimate(state, component, left);
      const rightCost = CATALOG_ANALYSIS.workUnits[right.output] + 1 + transportEstimate(state, component, right);
      return priceOf(right.output) / rightCost - priceOf(left.output) / leftCost
        || priceOf(right.output) - priceOf(left.output) || left.id.localeCompare(right.id);
    })[0];
}

function transportEstimate(state: GameState, component: CatState[], recipe: RecipeDefinition): number {
  if (!recipe.inputs.length) return 0;
  const producers = component.filter((cat) => siteFailure(state, cat, recipe) === null);
  const bases = Object.entries(baseRequirements(recipe.output, 1, {}, state.difficulty));
  const sourceByItem = new Map(bases.map(([itemId]) => [
    itemId,
    component.filter((cat) => resourceItemsAt(state, cat.position).includes(itemId)),
  ]));
  return Math.min(...producers.map((producer) => bases.reduce((sum, [itemId, quantity]) => {
    const sources = sourceByItem.get(itemId) ?? [];
    const distance = sources.length ? Math.min(...sources.map((source) => manhattan(source.position, producer.position))) : 1_000;
    return sum + distance * quantity;
  }, 0)));
}

function selectProducer(
  state: GameState,
  component: CatState[],
  recipe: RecipeDefinition,
  destination: CatState | undefined,
  map: Map<string, CatState>,
): CatState | undefined {
  const candidates = recipe.inputs.length === 0
    ? component.filter((cat) => resourceItemsAt(state, cat.position).includes(recipe.output))
    : component.filter((cat) => siteFailure(state, cat, recipe) === null);
  if (destination && candidates.some((cat) => cat.id === destination.id)) return destination;
  const distances = destination ? distancesFrom(component, destination, map) : null;
  return candidates.sort((left, right) => {
    const leftDistance = distances?.get(left.id) ?? (destination ? 10_000 : 0);
    const rightDistance = distances?.get(right.id) ?? (destination ? 10_000 : 0);
    const inputs = effectiveRecipeInputs(recipe, state.difficulty);
    const leftMissing = inputs.reduce((sum, input) => sum + Math.max(0, input.quantity - (left.inventory[input.itemId] ?? 0)), 0);
    const rightMissing = inputs.reduce((sum, input) => sum + Math.max(0, input.quantity - (right.inventory[input.itemId] ?? 0)), 0);
    const leftResource = recipe.inputs.length && resourceItemAt(state, left.position) ? 1 : 0;
    const rightResource = recipe.inputs.length && resourceItemAt(state, right.position) ? 1 : 0;
    return leftDistance - rightDistance || leftResource - rightResource || leftMissing - rightMissing || left.createdIndex - right.createdIndex;
  })[0];
}

function distancesFrom(component: CatState[], origin: CatState, map: Map<string, CatState>): Map<string, number> {
  const allowed = new Set(component.map((cat) => cat.id));
  const distances = new Map<string, number>([[origin.id, 0]]);
  const queue = [origin];
  let cursor = 0;
  while (cursor < queue.length) {
    const current = queue[cursor++];
    const distance = distances.get(current.id)! + 1;
    for (const direction of DIRECTIONS) {
      const offset = OFFSETS[direction];
      const neighbor = map.get(`${current.position.x + offset.x},${current.position.y + offset.y}`);
      if (!neighbor || !allowed.has(neighbor.id) || distances.has(neighbor.id)) continue;
      distances.set(neighbor.id, distance);
      queue.push(neighbor);
    }
  }
  return distances;
}

function ensureAt(
  state: GameState,
  component: CatState[],
  itemId: ItemId,
  destination: CatState,
  assignments: Map<string, Exclude<CatAction, null>>,
  shadow: Map<string, Record<ItemId, number>>,
  map: Map<string, CatState>,
  visiting: Set<ItemId>,
  acceptExisting = true,
): boolean {
  if (acceptExisting && available(shadow, destination.id, itemId) > 0) return true;
  const holders = component.filter((cat) => cat.id !== destination.id && idle(cat, assignments) && available(shadow, cat.id, itemId) > 0)
    .map((cat) => ({ cat, path: pathBetween(component, cat, destination, map) }))
    .filter((entry): entry is { cat: CatState; path: CatState[] } => Boolean(entry.path && entry.path.length > 1))
    .sort((a, b) => a.path.length - b.path.length || a.cat.createdIndex - b.cat.createdIndex);
  if (holders.length) {
    const { cat, path } = holders[0];
    assignments.set(cat.id, { type: "pass", direction: directionBetween(cat.position, path[1].position), itemId });
    reserve(shadow, cat.id, itemId);
    return false;
  }
  if (visiting.has(itemId)) return false;
  const recipe = RECIPE_BY_OUTPUT.get(itemId);
  if (!recipe || !state.unlockedRecipes.includes(recipe.id)) return false;
  const producer = selectProducer(state, component, recipe, destination, map);
  if (!producer) return false;
  return produceAt(state, component, recipe, producer, assignments, shadow, map, new Set(visiting).add(itemId))
    && producer.id === destination.id;
}

function produceAt(
  state: GameState,
  component: CatState[],
  recipe: RecipeDefinition,
  producer: CatState,
  assignments: Map<string, Exclude<CatAction, null>>,
  shadow: Map<string, Record<ItemId, number>>,
  map: Map<string, CatState>,
  visiting: Set<ItemId>,
): boolean {
  let ready = true;
  for (const input of effectiveRecipeInputs(recipe, state.difficulty)) {
    const present = available(shadow, producer.id, input.itemId);
    if (present >= input.quantity) continue;
    ready = false;
    for (let count = present; count < input.quantity; count += 1) {
      ensureAt(state, component, input.itemId, producer, assignments, shadow, map, visiting, false);
    }
  }
  if (!ready || !idle(producer, assignments)) return false;
  assignments.set(producer.id, { type: "craft", recipeId: recipe.id });
  for (const input of effectiveRecipeInputs(recipe, state.difficulty)) reserve(shadow, producer.id, input.itemId, input.quantity);
  return true;
}

function fillBaseBuffers(
  state: GameState,
  component: CatState[],
  target: RecipeDefinition,
  assignments: Map<string, Exclude<CatAction, null>>,
  shadow: Map<string, Record<ItemId, number>>,
): void {
  for (const itemId of Object.keys(baseRequirements(target.output))) {
    const total = component.reduce((sum, cat) => sum + available(shadow, cat.id, itemId)
      + (cat.action?.type === "craft" && cat.action.itemId === itemId ? 1 : 0), 0);
    if (total >= 2) continue;
    const source = component.find((cat) => idle(cat, assignments) && resourceItemsAt(state, cat.position).includes(itemId));
    const recipe = RECIPE_BY_OUTPUT.get(itemId);
    if (source && recipe) assignments.set(source.id, { type: "craft", recipeId: recipe.id });
  }
}

function fillParallelCrafts(
  state: GameState,
  component: CatState[],
  target: RecipeDefinition,
  assignments: Map<string, Exclude<CatAction, null>>,
  shadow: Map<string, Record<ItemId, number>>,
): void {
  const recipes = [...recipeClosure(target.output)]
    .map((itemId) => RECIPE_BY_OUTPUT.get(itemId))
    .filter((recipe): recipe is RecipeDefinition => Boolean(recipe && recipe.inputs.length > 0 && state.unlockedRecipes.includes(recipe.id)))
    .sort((left, right) => CATALOG_ANALYSIS.workUnits[right.output] - CATALOG_ANALYSIS.workUnits[left.output]
      || left.id.localeCompare(right.id));
  const buffered = new Map(recipes.map((recipe) => [
    recipe.output,
    component.reduce((sum, holder) => sum + available(shadow, holder.id, recipe.output)
      + (holder.action?.type === "craft" && holder.action.itemId === recipe.output ? 1 : 0), 0),
  ]));
  for (const cat of component) {
    if (!idle(cat, assignments)) continue;
    const recipe = recipes.find((entry) => {
      if (siteFailure(state, cat, entry)) return false;
      const inputs = effectiveRecipeInputs(entry, state.difficulty);
      return (buffered.get(entry.output) ?? 0) < 2
        && inputs.every((input) => available(shadow, cat.id, input.itemId) >= input.quantity);
    });
    if (!recipe) continue;
    assignments.set(cat.id, { type: "craft", recipeId: recipe.id });
    for (const input of effectiveRecipeInputs(recipe, state.difficulty)) reserve(shadow, cat.id, input.itemId, input.quantity);
    buffered.set(recipe.output, (buffered.get(recipe.output) ?? 0) + 1);
  }
}

function sellUnneeded(
  state: GameState,
  component: CatState[],
  closure: Set<ItemId>,
  assignments: Map<string, Exclude<CatAction, null>>,
  shadow: Map<string, Record<ItemId, number>>,
  priceOf: (itemId: ItemId) => number,
): void {
  for (const cat of component) {
    if (!idle(cat, assignments)) continue;
    const itemId = Object.keys(shadow.get(cat.id) ?? {}).filter((id) => !closure.has(id) && ITEM_BY_ID.has(id) && available(shadow, cat.id, id) > 0)
      .sort((a, b) => priceOf(b) - priceOf(a) || a.localeCompare(b))[0];
    if (itemId) assignSell(assignments, shadow, cat, itemId);
  }
}

function fallback(
  state: GameState,
  component: CatState[],
  assignments: Map<string, Exclude<CatAction, null>>,
  shadow: Map<string, Record<ItemId, number>>,
  priceOf: (itemId: ItemId) => number,
): void {
  for (const cat of component) {
    if (!idle(cat, assignments)) continue;
    const itemId = Object.keys(shadow.get(cat.id) ?? {}).filter((id) => ITEM_BY_ID.has(id) && available(shadow, cat.id, id) > 0)
      .sort((a, b) => priceOf(b) - priceOf(a))[0];
    if (itemId) {
      assignSell(assignments, shadow, cat, itemId);
      continue;
    }
    const resource = resourceItemAt(state, cat.position);
    const recipe = resource ? RECIPE_BY_OUTPUT.get(resource) : undefined;
    if (recipe && state.unlockedRecipes.includes(recipe.id)) assignments.set(cat.id, { type: "craft", recipeId: recipe.id });
  }
}

function assignSell(
  assignments: Map<string, Exclude<CatAction, null>>,
  shadow: Map<string, Record<ItemId, number>>,
  cat: CatState,
  itemId: ItemId,
): void {
  assignments.set(cat.id, { type: "sell", itemId });
  reserve(shadow, cat.id, itemId);
}

function baseRequirements(itemId: ItemId, multiplier = 1, result: Record<ItemId, number> = {}, difficulty: GameState["difficulty"] = 2): Record<ItemId, number> {
  const recipe = RECIPE_BY_OUTPUT.get(itemId);
  if (!recipe) return result;
  if (!recipe.inputs.length) {
    result[itemId] = (result[itemId] ?? 0) + multiplier;
  } else {
    for (const input of effectiveRecipeInputs(recipe, difficulty)) baseRequirements(input.itemId, multiplier * input.quantity, result, difficulty);
  }
  return result;
}

function recipeClosure(itemId: ItemId, result = new Set<ItemId>()): Set<ItemId> {
  if (result.has(itemId)) return result;
  result.add(itemId);
  for (const input of RECIPE_BY_OUTPUT.get(itemId)?.inputs ?? []) recipeClosure(input.itemId, result);
  return result;
}

function manhattan(left: Position, right: Position): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}
