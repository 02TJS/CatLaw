import type { ItemDefinition, RecipeDefinition } from "../game/types";

export interface GraphPoint {
  x: number;
  y: number;
}

export interface GraphRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RecipeGraphNode extends GraphRect {
  id: string;
  tier: number;
  order: number;
}

export interface RecipeGraphEdge {
  id: string;
  source: string;
  target: string;
  quantity: number;
  points: GraphPoint[];
}

export interface RecipeGraphLayout {
  width: number;
  height: number;
  nodes: RecipeGraphNode[];
  edges: RecipeGraphEdge[];
}

export const RECIPE_NODE_WIDTH = 168;
export const RECIPE_NODE_HEIGHT = 134;
export const RECIPE_COLUMN_STEP = 330;
export const RECIPE_ROUTE_GRID = 10;
// The normal wire halo is 4.6 px wide. Eight pixels between centre lines leaves
// visible whitespace even before a related path is highlighted.
export const RECIPE_MIN_ROUTE_GAP = 8;

const NODE_GAP = 74;
const MARGIN_LEFT = 20;
const MARGIN_RIGHT = 100;
const MARGIN_Y = 160;
const ROUTE_MARGIN = 14;

interface GridState {
  x: number;
  y: number;
  direction: number;
  cost: number;
  estimate: number;
  sequence: number;
  previous?: string;
}

class MinHeap {
  private entries: GridState[] = [];

  private compare(a: GridState, b: GridState): number {
    return a.estimate - b.estimate
      || a.cost - b.cost
      || a.y - b.y
      || a.x - b.x
      || a.direction - b.direction
      || a.sequence - b.sequence;
  }

  push(entry: GridState): void {
    this.entries.push(entry);
    let index = this.entries.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.entries[parent], entry) <= 0) break;
      this.entries[index] = this.entries[parent];
      index = parent;
    }
    this.entries[index] = entry;
  }

  pop(): GridState | undefined {
    const first = this.entries[0];
    const tail = this.entries.pop();
    if (!first || !tail || this.entries.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.entries.length) break;
      const child = right < this.entries.length && this.compare(this.entries[right], this.entries[left]) < 0 ? right : left;
      if (this.compare(this.entries[child], tail) >= 0) break;
      this.entries[index] = this.entries[child];
      index = child;
    }
    this.entries[index] = tail;
    return first;
  }

  get size(): number {
    return this.entries.length;
  }
}

function average(values: number[]): number {
  return values.length === 0 ? Number.POSITIVE_INFINITY : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Apply a visual preference without ever violating the recipe DAG. A plain
 * barycentric sort can put a same-era ingredient below the product that uses
 * it; this stable Kahn pass treats those dependencies as hard constraints and
 * uses the visual score only to choose between currently independent nodes.
 */
function constrainedColumnOrder(
  column: ItemDefinition[],
  scoreOf: (item: ItemDefinition) => number,
  sameTierChildren: ReadonlyMap<string, readonly string[]>,
  catalogOrder: ReadonlyMap<string, number>,
): ItemDefinition[] {
  const ids = new Set(column.map((item) => item.id));
  const indegree = new Map(column.map((item) => [item.id, 0]));
  for (const item of column) {
    for (const childId of sameTierChildren.get(item.id) ?? []) {
      if (ids.has(childId)) indegree.set(childId, (indegree.get(childId) ?? 0) + 1);
    }
  }

  const ready = column.filter((item) => indegree.get(item.id) === 0);
  const compare = (a: ItemDefinition, b: ItemDefinition) => {
    const aScore = scoreOf(a);
    const bScore = scoreOf(b);
    const finiteDifference = Number.isFinite(aScore) && Number.isFinite(bScore) ? aScore - bScore : 0;
    return finiteDifference || (catalogOrder.get(a.id) ?? 0) - (catalogOrder.get(b.id) ?? 0);
  };
  ready.sort(compare);

  const ordered: ItemDefinition[] = [];
  while (ready.length > 0) {
    const item = ready.shift()!;
    ordered.push(item);
    for (const childId of sameTierChildren.get(item.id) ?? []) {
      if (!ids.has(childId)) continue;
      const remaining = (indegree.get(childId) ?? 0) - 1;
      indegree.set(childId, remaining);
      if (remaining === 0) {
        const child = column.find((candidate) => candidate.id === childId);
        if (child) {
          ready.push(child);
          ready.sort(compare);
        }
      }
    }
  }
  if (ordered.length !== column.length) throw new Error(`Same-era recipe dependency cycle in tier ${column[0]?.tier ?? "unknown"}`);
  return ordered;
}

function orderedColumns(items: ItemDefinition[], recipes: RecipeDefinition[]): ItemDefinition[][] {
  const maxTier = Math.max(...items.map((item) => item.tier));
  const columns = Array.from({ length: maxTier + 1 }, (_, tier) => items.filter((item) => item.tier === tier));
  const parents = new Map(recipes.map((recipe) => [recipe.output, recipe.inputs.map((input) => input.itemId)]));
  const children = new Map(items.map((item) => [item.id, [] as string[]]));
  for (const recipe of recipes) {
    for (const input of recipe.inputs) children.get(input.itemId)?.push(recipe.output);
  }
  const catalogOrder = new Map(items.map((item, index) => [item.id, index]));

  const positions = () => new Map(columns.flatMap((column) => column.map((item, index) => [item.id, index] as const)));
  for (let sweep = 0; sweep < 4; sweep += 1) {
    let order = positions();
    for (let tier = 1; tier < columns.length; tier += 1) {
      columns[tier] = constrainedColumnOrder(
        columns[tier],
        (item) => average((parents.get(item.id) ?? []).map((id) => order.get(id) ?? 0)),
        children,
        catalogOrder,
      );
      order = positions();
    }
    for (let tier = columns.length - 2; tier >= 0; tier -= 1) {
      columns[tier] = constrainedColumnOrder(
        columns[tier],
        (item) => average((children.get(item.id) ?? []).map((id) => order.get(id) ?? 0)),
        children,
        catalogOrder,
      );
      order = positions();
    }
  }
  return columns;
}

function stateKey(x: number, y: number, direction: number): string {
  return `${x},${y},${direction}`;
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function routeSegmentKey(x1: number, y1: number, x2: number, y2: number): string {
  if (y1 === y2) return `h:${Math.min(x1, x2)},${y1}`;
  return `v:${x1},${Math.min(y1, y2)}`;
}

function pointInsideRect(point: GraphPoint, rect: GraphRect, padding = 0): boolean {
  return point.x > rect.x - padding
    && point.x < rect.x + rect.width + padding
    && point.y > rect.y - padding
    && point.y < rect.y + rect.height + padding;
}

function compactOrthogonal(points: GraphPoint[]): GraphPoint[] {
  const unique = points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
  const compacted: GraphPoint[] = [];
  for (const point of unique) {
    const a = compacted[compacted.length - 2];
    const b = compacted[compacted.length - 1];
    if (a && b && ((a.x === b.x && b.x === point.x) || (a.y === b.y && b.y === point.y))) compacted.pop();
    compacted.push(point);
  }
  return compacted;
}

function reserveParallelClearance(
  blockedSegments: Set<string>,
  a: GraphPoint,
  b: GraphPoint,
  phase: number,
  maxX: number,
  maxY: number,
): void {
  const grid = RECIPE_ROUTE_GRID;
  if (a.y === b.y) {
    const minCellX = Math.max(1, Math.floor((Math.min(a.x, b.x) - phase) / grid) - 1);
    const maxCellX = Math.min(maxX - 1, Math.ceil((Math.max(a.x, b.x) - phase) / grid) + 1);
    const minCellY = Math.max(1, Math.floor((a.y - RECIPE_MIN_ROUTE_GAP - phase) / grid) - 1);
    const maxCellY = Math.min(maxY, Math.ceil((a.y + RECIPE_MIN_ROUTE_GAP - phase) / grid) + 1);
    for (let y = minCellY; y <= maxCellY; y += 1) {
      for (let x = minCellX; x <= maxCellX; x += 1) {
        const start = { x: x * grid + phase, y: y * grid + phase };
        const end = { x: (x + 1) * grid + phase, y: start.y };
        if (parallelSegmentsTooClose(start, end, a, b)) blockedSegments.add(routeSegmentKey(x, y, x + 1, y));
      }
    }
    return;
  }
  if (a.x !== b.x) return;
  const minCellX = Math.max(1, Math.floor((a.x - RECIPE_MIN_ROUTE_GAP - phase) / grid) - 1);
  const maxCellX = Math.min(maxX, Math.ceil((a.x + RECIPE_MIN_ROUTE_GAP - phase) / grid) + 1);
  const minCellY = Math.max(1, Math.floor((Math.min(a.y, b.y) - phase) / grid) - 1);
  const maxCellY = Math.min(maxY - 1, Math.ceil((Math.max(a.y, b.y) - phase) / grid) + 1);
  for (let x = minCellX; x <= maxCellX; x += 1) {
    for (let y = minCellY; y <= maxCellY; y += 1) {
      const start = { x: x * grid + phase, y: y * grid + phase };
      const end = { x: start.x, y: (y + 1) * grid + phase };
      if (parallelSegmentsTooClose(start, end, a, b)) blockedSegments.add(routeSegmentKey(x, y, x, y + 1));
    }
  }
}

function gridRoute(
  start: GraphPoint,
  end: GraphPoint,
  nodes: RecipeGraphNode[],
  width: number,
  height: number,
  occupiedSegments: Set<string>,
  phase: number,
  previousEdges: readonly RecipeGraphEdge[],
  sourceId: string,
  targetId: string,
): GraphPoint[] {
  const grid = RECIPE_ROUTE_GRID;
  const startCell = { x: Math.round((start.x - phase) / grid), y: Math.round((start.y - phase) / grid) };
  const endCell = { x: Math.round((end.x - phase) / grid), y: Math.round((end.y - phase) / grid) };
  const maxX = Math.floor((width - grid - phase) / grid);
  const maxY = Math.floor((height - grid - phase) / grid);
  const blockedSegments = new Set(occupiedSegments);
  for (const edge of previousEdges) {
    // Routes that fan out of or converge into the same card must share the
    // small terminal neighbourhood. Their distinct card ports still prevent
    // exact overlap, while unrelated long corridors retain full clearance.
    if (edge.source === sourceId || edge.source === targetId || edge.target === sourceId || edge.target === targetId) continue;
    for (let index = 2; index < edge.points.length - 1; index += 1) {
      reserveParallelClearance(blockedSegments, edge.points[index - 1], edge.points[index], phase, maxX, maxY);
    }
  }
  const blocked = (x: number, y: number) => {
    if (x < 1 || y < 1 || x > maxX || y > maxY) return true;
    if ((x === startCell.x && y === startCell.y) || (x === endCell.x && y === endCell.y)) return false;
    const point = { x: x * grid + phase, y: y * grid + phase };
    return nodes.some((node) => pointInsideRect(point, node, ROUTE_MARGIN));
  };
  const directions = [[1, 0], [0, 1], [0, -1], [-1, 0]] as const;
  const queue = new MinHeap();
  const best = new Map<string, number>();
  const states = new Map<string, GridState>();
  const initial: GridState = {
    ...startCell,
    direction: 0,
    cost: 0,
    estimate: Math.abs(endCell.x - startCell.x) + Math.abs(endCell.y - startCell.y),
    sequence: 0,
  };
  let nextSequence = 1;
  queue.push(initial);
  best.set(stateKey(initial.x, initial.y, initial.direction), 0);
  states.set(stateKey(initial.x, initial.y, initial.direction), initial);
  let finish: GridState | undefined;

  while (queue.size > 0) {
    const current = queue.pop()!;
    const currentKey = stateKey(current.x, current.y, current.direction);
    if (current.cost !== best.get(currentKey)) continue;
    if (current.x === endCell.x && current.y === endCell.y) {
      finish = current;
      break;
    }
    directions.forEach(([dx, dy], direction) => {
      const x = current.x + dx;
      const y = current.y + dy;
      if (blocked(x, y)) return;
      if (blockedSegments.has(routeSegmentKey(current.x, current.y, x, y))) return;
      const turnPenalty = direction === current.direction ? 0 : 0.42;
      const backwardPenalty = dx < 0 ? 1.8 : 0;
      const cost = current.cost + 1 + turnPenalty + backwardPenalty;
      const key = stateKey(x, y, direction);
      if (cost >= (best.get(key) ?? Number.POSITIVE_INFINITY)) return;
      const next: GridState = {
        x,
        y,
        direction,
        cost,
        estimate: cost + Math.abs(endCell.x - x) + Math.abs(endCell.y - y),
        sequence: nextSequence,
        previous: currentKey,
      };
      nextSequence += 1;
      best.set(key, cost);
      states.set(key, next);
      queue.push(next);
    });
  }

  if (!finish) {
    throw new Error(`Unable to route recipe edge from ${cellKey(startCell.x, startCell.y)} to ${cellKey(endCell.x, endCell.y)}`);
  }

  const cells: GraphPoint[] = [];
  let cursor: GridState | undefined = finish;
  while (cursor) {
    cells.push({ x: cursor.x * grid + phase, y: cursor.y * grid + phase });
    cursor = cursor.previous ? states.get(cursor.previous) : undefined;
  }
  cells.reverse();
  for (let index = 1; index < cells.length; index += 1) {
    occupiedSegments.add(routeSegmentKey(
      Math.round((cells[index - 1].x - phase) / grid),
      Math.round((cells[index - 1].y - phase) / grid),
      Math.round((cells[index].x - phase) / grid),
      Math.round((cells[index].y - phase) / grid),
    ));
  }
  const first = cells[0] ?? start;
  const last = cells[cells.length - 1] ?? end;
  return compactOrthogonal([
    start,
    { x: first.x, y: start.y },
    ...cells,
    { x: last.x, y: end.y },
    end,
  ]);
}

function parallelSegmentsTooClose(a1: GraphPoint, a2: GraphPoint, b1: GraphPoint, b2: GraphPoint): boolean {
  if (a1.y === a2.y && b1.y === b2.y && Math.abs(a1.y - b1.y) < RECIPE_MIN_ROUTE_GAP) {
    return Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x))
      < Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x));
  }
  if (a1.x === a2.x && b1.x === b2.x && Math.abs(a1.x - b1.x) < RECIPE_MIN_ROUTE_GAP) {
    return Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y))
      < Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y));
  }
  return false;
}

function routesOverlapExactly(a: RecipeGraphEdge, b: RecipeGraphEdge): boolean {
  for (let aIndex = 1; aIndex < a.points.length; aIndex += 1) {
    for (let bIndex = 1; bIndex < b.points.length; bIndex += 1) {
      const [a1, a2] = [a.points[aIndex - 1], a.points[aIndex]];
      const [b1, b2] = [b.points[bIndex - 1], b.points[bIndex]];
      if (a1.y === a2.y && b1.y === b2.y && a1.y === b1.y
        && Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x)) < Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x))) return true;
      if (a1.x === a2.x && b1.x === b2.x && a1.x === b1.x
        && Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y)) < Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y))) return true;
    }
  }
  return false;
}

function parallelSegmentsOverlap(a1: GraphPoint, a2: GraphPoint, b1: GraphPoint, b2: GraphPoint): boolean {
  if (a1.y === a2.y && b1.y === b2.y && a1.y === b1.y) {
    return Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x))
      < Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x));
  }
  if (a1.x === a2.x && b1.x === b2.x && a1.x === b1.x) {
    return Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y))
      < Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y));
  }
  return false;
}

function routesShareCorridor(a: RecipeGraphEdge, b: RecipeGraphEdge): boolean {
  // Lines that fan out of or converge into the same card already use distinct
  // ports. Treat that short terminal fan as one visual bundle; independent
  // routes still have to maintain the full global clearance below.
  for (let aIndex = 1; aIndex < a.points.length; aIndex += 1) {
    for (let bIndex = 1; bIndex < b.points.length; bIndex += 1) {
      // The A* search already reserves five pixels around unrelated internal
      // corridors. This final pass guards the short, non-grid-aligned card
      // terminals, where rejecting merely-near lines can make the dense graph
      // unsatisfiable even though their white halos remain visually separate.
      if (parallelSegmentsOverlap(a.points[aIndex - 1], a.points[aIndex], b.points[bIndex - 1], b.points[bIndex])) return true;
    }
  }
  return false;
}

function routeCrossesUnrelatedNode(edge: RecipeGraphEdge, nodes: RecipeGraphNode[]): boolean {
  for (let index = 1; index < edge.points.length; index += 1) {
    for (const node of nodes) {
      if (node.id === edge.source || node.id === edge.target) continue;
      if (segmentIntersectsRect(edge.points[index - 1], edge.points[index], node, 3)) return true;
    }
  }
  return false;
}

export function layoutRecipeGraph(items: ItemDefinition[], recipes: RecipeDefinition[]): RecipeGraphLayout {
  const columns = orderedColumns(items, recipes);
  const maxColumnHeight = Math.max(...columns.map((column) => column.length * RECIPE_NODE_HEIGHT + Math.max(0, column.length - 1) * NODE_GAP));
  const width = MARGIN_LEFT + MARGIN_RIGHT + (columns.length - 1) * RECIPE_COLUMN_STEP + RECIPE_NODE_WIDTH;
  const height = MARGIN_Y * 2 + maxColumnHeight;
  const nodes: RecipeGraphNode[] = [];
  columns.forEach((column, tier) => {
    const columnHeight = column.length * RECIPE_NODE_HEIGHT + Math.max(0, column.length - 1) * NODE_GAP;
    let y = MARGIN_Y + (maxColumnHeight - columnHeight) / 2;
    for (const item of column) {
      nodes.push({ id: item.id, tier, order: items.indexOf(item), x: MARGIN_LEFT + tier * RECIPE_COLUMN_STEP, y, width: RECIPE_NODE_WIDTH, height: RECIPE_NODE_HEIGHT });
      y += RECIPE_NODE_HEIGHT + NODE_GAP;
    }
  });

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const rawEdges = recipes.flatMap((recipe) => recipe.inputs.map((input) => ({
    id: `${input.itemId}--${recipe.output}`,
    source: input.itemId,
    target: recipe.output,
    quantity: input.quantity,
  }))).sort((a, b) => {
    const aSpan = (nodeById.get(a.target)?.tier ?? 0) - (nodeById.get(a.source)?.tier ?? 0);
    const bSpan = (nodeById.get(b.target)?.tier ?? 0) - (nodeById.get(b.source)?.tier ?? 0);
    const aSameTier = aSpan === 0 ? 0 : 1;
    const bSameTier = bSpan === 0 ? 0 : 1;
    return aSameTier - bSameTier || bSpan - aSpan || a.target.localeCompare(b.target) || a.source.localeCompare(b.source);
  });
  const outgoing = new Map(items.map((item) => [item.id, rawEdges.filter((edge) => edge.source === item.id)]));
  const incoming = new Map(items.map((item) => [item.id, rawEdges.filter((edge) => edge.target === item.id)]));
  const routePhases = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -7, 7, -8, 8, -9, 9];
  const occupiedByPhase = routePhases.map(() => new Set<string>());
  const edges: RecipeGraphEdge[] = [];
  const nextSameTierLane = new Map<number, number>();
  for (const edge of rawEdges) {
    const edgeOrder = rawEdges.indexOf(edge);
    // A tiny deterministic irrational offset keeps equal-looking card ports
    // on distinct mathematical centre lines. It is far below a rendered
    // pixel, but prevents exact collinear overlap in dense terminal fans.
    const terminalJitter = (edgeOrder + 1) * 0.00141421356237;
    const source = nodeById.get(edge.source)!;
    const target = nodeById.get(edge.target)!;
    const sameTier = source.tier === target.tier;
    const sourceEdges = outgoing.get(edge.source)!.filter((candidate) => (
      nodeById.get(candidate.target)!.tier === source.tier
    ) === sameTier);
    const targetEdges = incoming.get(edge.target)!.filter((candidate) => (
      nodeById.get(candidate.source)!.tier === target.tier
    ) === sameTier);
    const sourcePort = (sourceEdges.indexOf(edge) + 1) / (sourceEdges.length + 1);
    const targetPort = (targetEdges.indexOf(edge) + 1) / (targetEdges.length + 1);
    const sourceTerminalOffset = ROUTE_MARGIN + RECIPE_MIN_ROUTE_GAP * (sourceEdges.indexOf(edge) + 1);
    const targetTerminalOffset = ROUTE_MARGIN + RECIPE_MIN_ROUTE_GAP * (targetEdges.indexOf(edge) + 1);
    const sourceAnchor = sameTier
      ? { x: source.x + source.width, y: source.y + source.height * sourcePort + terminalJitter }
      : { x: source.x + source.width, y: source.y + source.height * sourcePort + terminalJitter };
    const targetAnchor = sameTier
      ? { x: target.x + target.width, y: target.y + target.height * targetPort + terminalJitter }
      : { x: target.x, y: target.y + target.height * targetPort + terminalJitter };
    const routeStart = sameTier
      ? { x: sourceAnchor.x + sourceTerminalOffset, y: sourceAnchor.y }
      : { x: sourceAnchor.x + sourceTerminalOffset, y: sourceAnchor.y };
    const routeEnd = sameTier
      ? { x: targetAnchor.x + targetTerminalOffset, y: targetAnchor.y }
      : { x: targetAnchor.x - targetTerminalOffset, y: targetAnchor.y };
    if (sameTier) {
      const laneIndex = nextSameTierLane.get(source.tier) ?? 0;
      nextSameTierLane.set(source.tier, laneIndex + 1);
      const laneX = source.x + source.width + ROUTE_MARGIN + RECIPE_MIN_ROUTE_GAP * (laneIndex + 1);
      const sameTierEdge = {
        ...edge,
        points: compactOrthogonal([
          sourceAnchor,
          routeStart,
          { x: laneX, y: routeStart.y },
          { x: laneX, y: routeEnd.y },
          routeEnd,
          targetAnchor,
        ]),
      };
      if (routeCrossesUnrelatedNode(sameTierEdge, nodes)) throw new Error(`Same-era recipe edge ${edge.id} crosses a product card`);
      edges.push(sameTierEdge);
      continue;
    }
    let placed: RecipeGraphEdge | undefined;
    const blockers = new Set<string>();
    for (let phaseIndex = 0; phaseIndex < routePhases.length; phaseIndex += 1) {
      const occupied = new Set(occupiedByPhase[phaseIndex]);
      try {
        const route = gridRoute(
          routeStart,
          routeEnd,
          nodes,
          width,
          height,
          occupied,
          routePhases[phaseIndex],
          edges,
          edge.source,
          edge.target,
        );
        const candidate = { ...edge, points: compactOrthogonal([sourceAnchor, ...route, targetAnchor]) };
        if (routeCrossesUnrelatedNode(candidate, nodes)) { blockers.add("node"); continue; }
        const conflict = edges.find((previous) => routesShareCorridor(candidate, previous));
        if (conflict) { blockers.add(conflict.id); continue; }
        occupiedByPhase[phaseIndex] = occupied;
        placed = candidate;
        break;
      } catch {
        blockers.add(`lane-${phaseIndex + 1}`);
      }
    }
    if (!placed) {
      // Dense long-distance dependencies may exhaust every globally separated
      // lane. Keep the enlarged geometry and node clearance, then fall back to
      // exact no-overlap routing so the one-flow graph always remains complete.
      for (let phaseIndex = 0; phaseIndex < routePhases.length; phaseIndex += 1) {
        const occupied = new Set(occupiedByPhase[phaseIndex]);
        try {
          const route = gridRoute(routeStart, routeEnd, nodes, width, height, occupied, routePhases[phaseIndex], [], edge.source, edge.target);
          const candidate = { ...edge, points: compactOrthogonal([sourceAnchor, ...route, targetAnchor]) };
          if (routeCrossesUnrelatedNode(candidate, nodes)) continue;
          const exactOverlap = edges.find((previous) => routesOverlapExactly(candidate, previous));
          if (exactOverlap) continue;
          occupiedByPhase[phaseIndex] = occupied;
          placed = candidate;
          break;
        } catch {
          // Try the next route phase.
        }
      }
    }
    if (!placed) throw new Error(`Unable to separate recipe edge ${edge.id} from existing route lanes (${[...blockers].join(", ")})`);
    edges.push(placed);
  }
  return { width, height, nodes, edges };
}

export function segmentIntersectsRect(a: GraphPoint, b: GraphPoint, rect: GraphRect, padding = 0): boolean {
  const left = rect.x - padding;
  const right = rect.x + rect.width + padding;
  const top = rect.y - padding;
  const bottom = rect.y + rect.height + padding;
  if (a.x === b.x) return a.x > left && a.x < right && Math.max(Math.min(a.y, b.y), top) < Math.min(Math.max(a.y, b.y), bottom);
  if (a.y === b.y) return a.y > top && a.y < bottom && Math.max(Math.min(a.x, b.x), left) < Math.min(Math.max(a.x, b.x), right);
  return true;
}
