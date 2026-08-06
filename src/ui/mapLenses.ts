import { ITEM_BY_ID, ITEMS, RECIPE_BY_ID, RECIPE_BY_OUTPUT, RECIPES } from "../game/catalog";
import { difficultySiteRequirements } from "../game/difficulty";
import { catWealthScoreCents, formatMoney } from "../game/engine";
import { LANDMARK_BY_ID } from "../game/landmarks";
import type { CatState, GameState, ItemId, Position } from "../game/types";
import { resourceNodesAtPosition } from "../game/world";
import { itemQualityLevel, itemQualityPalette } from "./itemQuality";

export type MapLensId = "none" | "inventory" | "orders" | "bottlenecks" | "environment" | "wealth" | "activity" | "law" | "stability" | "coordinates";
export type WealthLensMode = "total" | "change";

export interface MapLensOptions {
  wealthMode?: WealthLensMode;
  wealthWindowMs?: number;
}

export interface LensColor {
  id: string;
  label: string;
  top: string;
  sideRight: string;
  sideLeft: string;
  border: string;
}

export interface MapLensEdge {
  id: string;
  sourceCatId: string;
  targetCatId: string;
  color: string;
  count?: number;
  itemId?: ItemId;
  kind?: "input" | "output" | "order" | "contract";
}

export interface MapLensArea {
  id: string;
  kind: "resource" | "building" | "landmark";
  position: Position;
  radius: number;
  color: string;
  itemId?: ItemId;
}

export interface MapLensOrderFloor {
  catId: string;
  demandItemIds: ItemId[];
  demandTargets: Array<{ itemId: ItemId; targetItemIds: ItemId[] }>;
  supplyItemIds: ItemId[];
  carrier: boolean;
}

export interface MapLensSnapshot {
  lensId: MapLensId;
  itemId: ItemId | null;
  catColors: Map<string, LensColor>;
  edges: MapLensEdge[];
  areas: MapLensArea[];
  orderFloors: Map<string, MapLensOrderFloor>;
  legend: LensColor[];
  metric: null | {
    unit: "cents" | "milliseconds";
    mode?: WealthLensMode;
    windowMs?: number;
    baselineAt?: number;
    min: number;
    median: number;
    max: number;
    values: Map<string, number>;
    normalized: Map<string, number>;
  };
}

export const MAP_LENS_OPTIONS: ReadonlyArray<{ id: Exclude<MapLensId, "none">; label: string }> = [
  { id: "inventory", label: "库存增强" },
  { id: "orders", label: "订单供需" },
  { id: "bottlenecks", label: "生产瓶颈" },
  { id: "environment", label: "生产环境" },
  { id: "wealth", label: "财富信用" },
  { id: "activity", label: "活跃热力" },
  { id: "law", label: "法规影响" },
  { id: "stability", label: "生产稳定" },
  { id: "coordinates", label: "坐标索引" },
];

export const ITEM_SCOPED_LENSES = new Set<MapLensId>(["orders", "bottlenecks", "environment", "stability"]);
export const WEALTH_LENS_WINDOW_OPTIONS_MS = [15_000, 30_000, 60_000, 180_000, 300_000] as const;
export const DEFAULT_WEALTH_LENS_WINDOW_MS = 60_000;

/**
 * Products that the player can meaningfully inspect without leaking locked
 * recipes.  An unlocked blueprint must be selectable before its first craft,
 * and live market/history references remain selectable even after migration.
 */
export function mapLensSelectableItemIds(state: GameState): ItemId[] {
  const visible = new Set<ItemId>(state.discoveredItems);
  for (const recipeId of state.unlockedRecipes) {
    const output = RECIPE_BY_ID.get(recipeId)?.output;
    if (output) visible.add(output);
  }
  for (const cat of state.cats) {
    for (const [itemId, quantity] of Object.entries(cat.inventory)) {
      if (quantity > 0) visible.add(itemId);
    }
    if (cat.action?.itemId) visible.add(cat.action.itemId);
  }
  for (const plan of state.procurementPlans) visible.add(plan.outputItemId);
  for (const order of state.demandOrders) visible.add(order.itemId);
  for (const contract of state.shipmentContracts) visible.add(contract.itemId);
  for (const flow of state.productionHistory.flows) {
    visible.add(flow.itemId);
    visible.add(flow.outputItemId);
  }
  for (const event of state.recentProductionEvents) visible.add(event.itemId);
  for (const [itemId, quantity] of Object.entries(state.playerBuildingInventory)) {
    if (quantity > 0) visible.add(itemId);
  }
  return ITEMS.filter((item) => visible.has(item.id)).map((item) => item.id);
}

const color = (
  id: string,
  label: string,
  top: string,
  sideRight: string,
  sideLeft: string,
  border: string,
): LensColor => ({ id, label, top, sideRight, sideLeft, border });

// Civilization-style discrete map colors: fixed meanings, strong separation,
// and no icon or pattern dependency.
export const LENS_COLORS = {
  neutral: color("neutral", "无相关状态", "#c8c9c4", "#a8aaa6", "#979b97", "#777c78"),
  red: color("red", "严重阻塞", "#e06a62", "#b84f4a", "#a94441", "#8f3534"),
  orange: color("orange", "需要处理", "#e99b58", "#c4793f", "#b66a37", "#99562f"),
  yellow: color("yellow", "等待中", "#dbc565", "#b8a44d", "#a49445", "#837534"),
  lightGreen: color("light-green", "可以运行", "#91c978", "#6fa85b", "#61994f", "#477d3c"),
  darkGreen: color("dark-green", "运行良好", "#4c9b64", "#387c4c", "#316e43", "#235b35"),
  cyan: color("cyan", "正在运输", "#62b5c8", "#438fa4", "#3b8195", "#2d6b7d"),
  blue: color("blue", "合同执行", "#6c91cf", "#506fac", "#46649f", "#385486"),
  purple: color("purple", "多重角色", "#a179c1", "#7f5ca0", "#73518f", "#5d4079"),
} as const;

const LAW_PALETTE = [
  color("law-0", "", "#4f9d69", "#397c4d", "#306f43", "#245b36"),
  color("law-1", "", "#5d91ca", "#4672a7", "#3e6698", "#31527f"),
  color("law-2", "", "#a277c1", "#80599f", "#724e90", "#5c3e78"),
  color("law-3", "", "#d49b55", "#ad773a", "#9c6932", "#825329"),
  color("law-4", "", "#c86667", "#a34c50", "#934247", "#793438"),
  color("law-5", "", "#4fa9a2", "#39847f", "#317771", "#26635e"),
  color("law-6", "", "#bd78a0", "#98577d", "#884d70", "#713e5d"),
  color("law-7", "", "#808f56", "#65713f", "#596438", "#49522d"),
];

function mapCats(state: GameState, resolve: (cat: CatState) => LensColor): Map<string, LensColor> {
  return new Map(state.cats.map((cat) => [cat.id, resolve(cat)]));
}

function parseHex(value: string): [number, number, number] {
  const normalized = value.replace(/^#/, "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function mixHex(from: string, to: string, amount: number): string {
  const left = parseHex(from);
  const right = parseHex(to);
  const t = Math.max(0, Math.min(1, amount));
  return `#${left.map((component, index) => Math.round(component + (right[index] - component) * t)
    .toString(16).padStart(2, "0")).join("")}`;
}

function wealthHeatColor(normalized: number): LensColor {
  const t = Math.max(0, Math.min(1, normalized));
  const local = t <= 0.5 ? t * 2 : (t - 0.5) * 2;
  const top = t <= 0.5 ? mixHex("#dc7069", "#e1c35f", local) : mixHex("#e1c35f", "#4eaa73", local);
  const sideRight = t <= 0.5 ? mixHex("#b45552", "#b79d49", local) : mixHex("#b79d49", "#398657", local);
  const sideLeft = t <= 0.5 ? mixHex("#a54a48", "#a68e41", local) : mixHex("#a68e41", "#31784d", local);
  const border = t <= 0.5 ? mixHex("#8a3938", "#817032", local) : mixHex("#817032", "#23623c", local);
  return color(`wealth-${Math.round(t * 1_000)}`, `${Math.round(t * 100)}%`, top, sideRight, sideLeft, border);
}

const ACTIVITY_STALLED_MS = 60_000;

function activityHeatColor(normalizedInactivity: number): LensColor {
  const t = Math.max(0, Math.min(1, normalizedInactivity));
  const local = t <= 0.5 ? t * 2 : (t - 0.5) * 2;
  const top = t <= 0.5 ? mixHex("#4eaa73", "#e1c35f", local) : mixHex("#e1c35f", "#dc7069", local);
  const sideRight = t <= 0.5 ? mixHex("#398657", "#b79d49", local) : mixHex("#b79d49", "#b45552", local);
  const sideLeft = t <= 0.5 ? mixHex("#31784d", "#a68e41", local) : mixHex("#a68e41", "#a54a48", local);
  const border = t <= 0.5 ? mixHex("#23623c", "#817032", local) : mixHex("#817032", "#8a3938", local);
  return color(`activity-${Math.round(t * 1_000)}`, `${Math.round(t * 100)}%`, top, sideRight, sideLeft, border);
}

function activePlanForCat(state: GameState, catId: string) {
  return state.procurementPlans.find((plan) => plan.catId === catId && plan.status === "active") ?? null;
}

function catTouchesItem(state: GameState, cat: CatState, itemId: ItemId | null): boolean {
  if (!itemId) return true;
  if (cat.action?.itemId === itemId) return true;
  if ((cat.inventory[itemId] ?? 0) > 0) return true;
  if (state.procurementPlans.some((plan) => plan.status === "active" && plan.catId === cat.id && plan.outputItemId === itemId)) return true;
  if (state.demandOrders.some((order) => order.status === "open" && order.itemId === itemId
    && (order.buyerCatId === cat.id || order.destinationCatId === cat.id || order.committedSellerCatId === cat.id))) return true;
  return state.shipmentContracts.some((contract) => contract.status !== "delivered" && contract.itemId === itemId
    && contract.routeCatIds.includes(cat.id));
}

function orderSnapshot(state: GameState, itemId: ItemId | null): Pick<MapLensSnapshot, "catColors" | "edges" | "orderFloors" | "legend"> {
  const roles = new Map<string, Set<"buyer" | "supplier" | "carrier">>();
  const itemRoles = new Map<string, { demand: Set<ItemId>; supply: Set<ItemId> }>();
  const demandTargets = new Map<string, Map<ItemId, Set<ItemId>>>();
  const planById = new Map(state.procurementPlans.map((plan) => [plan.id, plan]));
  const orderById = new Map(state.demandOrders.map((order) => [order.id, order]));
  const addRole = (catId: string | null | undefined, role: "buyer" | "supplier" | "carrier") => {
    if (!catId) return;
    const current = roles.get(catId) ?? new Set();
    current.add(role);
    roles.set(catId, current);
  };
  const addItemRole = (catId: string | null | undefined, role: "demand" | "supply", roleItemId: ItemId) => {
    if (!catId) return;
    const current = itemRoles.get(catId) ?? { demand: new Set<ItemId>(), supply: new Set<ItemId>() };
    current[role].add(roleItemId);
    itemRoles.set(catId, current);
  };
  const addDemandTarget = (catId: string | null | undefined, demandItemId: ItemId, planId: string | null | undefined) => {
    if (!catId || !planId) return;
    const targetItemId = planById.get(planId)?.outputItemId;
    if (!targetItemId) return;
    const byItem = demandTargets.get(catId) ?? new Map<ItemId, Set<ItemId>>();
    const targets = byItem.get(demandItemId) ?? new Set<ItemId>();
    targets.add(targetItemId);
    byItem.set(demandItemId, targets);
    demandTargets.set(catId, byItem);
  };
  const edges: MapLensEdge[] = [];
  for (const order of state.demandOrders) {
    if (order.status !== "open" || (itemId && order.itemId !== itemId)) continue;
    addRole(order.destinationCatId, "buyer");
    addItemRole(order.destinationCatId, "demand", order.itemId);
    addDemandTarget(order.destinationCatId, order.itemId, order.planId);
    addRole(order.committedSellerCatId, "supplier");
    addItemRole(order.committedSellerCatId, "supply", order.itemId);
    if (order.committedSellerCatId) {
      edges.push({
        id: order.id,
        sourceCatId: order.committedSellerCatId,
        targetCatId: order.destinationCatId,
        color: LENS_COLORS.orange.top,
      });
    }
  }
  for (const contract of state.shipmentContracts) {
    if (contract.status === "delivered" || (itemId && contract.itemId !== itemId)) continue;
    addRole(contract.destinationCatId, "buyer");
    addItemRole(contract.destinationCatId, "demand", contract.itemId);
    addDemandTarget(contract.destinationCatId, contract.itemId, orderById.get(contract.orderId)?.planId);
    addRole(contract.sellerCatId, "supplier");
    addItemRole(contract.sellerCatId, "supply", contract.itemId);
    for (const catId of contract.routeCatIds.slice(1, -1)) addRole(catId, "carrier");
    addRole(contract.custodianCatId, "carrier");
    edges.push({
      id: contract.id,
      sourceCatId: contract.sellerCatId,
      targetCatId: contract.destinationCatId,
      color: contract.status === "awaiting-pickup" ? LENS_COLORS.darkGreen.top : LENS_COLORS.blue.top,
    });
  }
  const catColors = mapCats(state, (cat) => {
    const catRoles = roles.get(cat.id);
    if (!catRoles?.size) return LENS_COLORS.neutral;
    const roleItems = itemRoles.get(cat.id);
    if (roleItems?.demand.size && roleItems.supply.size) return LENS_COLORS.purple;
    if (catRoles.has("buyer")) return LENS_COLORS.red;
    if (catRoles.has("supplier")) return LENS_COLORS.darkGreen;
    return LENS_COLORS.blue;
  });
  const createdIndexByCatId = new Map(state.cats.map((cat) => [cat.id, cat.createdIndex]));
  const orderFloorEntries = [...roles.entries()]
    .map(([catId, catRoles]) => {
      const roleItems = itemRoles.get(catId) ?? { demand: new Set<ItemId>(), supply: new Set<ItemId>() };
      return {
        catId,
        demandItemIds: [...roleItems.demand].sort(),
        demandTargets: [...(demandTargets.get(catId)?.entries() ?? [])]
          .map(([demandItemId, targetItemIds]) => ({ itemId: demandItemId, targetItemIds: [...targetItemIds].sort() }))
          .sort((left, right) => left.itemId.localeCompare(right.itemId)),
        supplyItemIds: [...roleItems.supply].sort(),
        carrier: catRoles.has("carrier"),
      };
    })
    .sort((left, right) => (createdIndexByCatId.get(left.catId) ?? Number.MAX_SAFE_INTEGER)
      - (createdIndexByCatId.get(right.catId) ?? Number.MAX_SAFE_INTEGER)
      || left.catId.localeCompare(right.catId));
  const orderFloors = new Map(orderFloorEntries.map((entry) => [entry.catId, entry] as const));
  return {
    catColors,
    edges,
    orderFloors,
    legend: [
      { ...LENS_COLORS.red, label: "需求方" },
      { ...LENS_COLORS.darkGreen, label: "供应方" },
      { ...LENS_COLORS.blue, label: "承运方" },
      { ...LENS_COLORS.purple, label: "左红需求 · 右绿供应" },
      { ...LENS_COLORS.orange, label: "开放报价" },
    ],
  };
}

function bottleneckSnapshot(state: GameState, itemId: ItemId | null): Pick<MapLensSnapshot, "catColors" | "legend"> {
  const catColors = mapCats(state, (cat) => {
    if (!catTouchesItem(state, cat, itemId)) return LENS_COLORS.neutral;
    if (cat.action?.type === "craft") return LENS_COLORS.darkGreen;
    if (cat.action?.type === "pass") return LENS_COLORS.blue;
    const plan = activePlanForCat(state, cat.id);
    if (!plan) return LENS_COLORS.neutral;
    if (!plan.blockedReason && (plan.phase === "ready" || plan.phase === "procuring" || plan.phase === "funded")) return LENS_COLORS.lightGreen;
    const reason = plan.blockedReason ?? cat.lastDecision;
    if (/信用|资金|预算|保证金|支付|贷款/.test(reason)) return LENS_COLORS.red;
    if (/建筑|范围|路线|运输|不可达|断链/.test(reason)) return LENS_COLORS.orange;
    return LENS_COLORS.yellow;
  });
  return {
    catColors,
    legend: [
      { ...LENS_COLORS.darkGreen, label: "制作中" },
      { ...LENS_COLORS.blue, label: "运输中" },
      { ...LENS_COLORS.lightGreen, label: "计划可执行" },
      { ...LENS_COLORS.yellow, label: "等待供给" },
      { ...LENS_COLORS.orange, label: "空间或运输阻塞" },
      { ...LENS_COLORS.red, label: "资金或信用阻塞" },
    ],
  };
}

function coordinateSnapshot(state: GameState): Pick<MapLensSnapshot, "catColors" | "legend"> {
  return {
    catColors: mapCats(state, () => LENS_COLORS.neutral),
    legend: [
      { ...LENS_COLORS.blue, label: "X 横轴（y=0）" },
      { ...LENS_COLORS.orange, label: "Y 纵轴（x=0）" },
      { ...LENS_COLORS.neutral, label: "猫序号与坐标" },
    ],
  };
}

function buildingRadius(itemId: ItemId, difficulty: GameState["difficulty"]): number {
  return RECIPES.flatMap((recipe) => difficultySiteRequirements(recipe, difficulty))
    .filter((requirement) => requirement.buildingItemId === itemId)
    .reduce((largest, requirement) => Math.max(largest, requirement.maxManhattanDistance), 0);
}

function environmentSnapshot(state: GameState, itemId: ItemId | null): Pick<MapLensSnapshot, "catColors" | "areas" | "legend"> {
  const recipe = itemId ? RECIPE_BY_OUTPUT.get(itemId) : null;
  const requirements = recipe ? difficultySiteRequirements(recipe, state.difficulty) : [];
  const isHarvestTarget = Boolean(recipe && recipe.inputs.length === 0);
  const visibleResourceIds = isHarvestTarget && itemId ? new Set([itemId]) : null;
  const visibleBuildingIds = requirements.length > 0 ? new Set(requirements.map((entry) => entry.buildingItemId)) : null;
  const areas: MapLensArea[] = [];
  for (const node of state.resourceNodes) {
    if (visibleResourceIds && !visibleResourceIds.has(node.itemId)) continue;
    areas.push({ id: node.id, kind: "resource", position: node.position, radius: 1, color: resourceColor(node.itemId), itemId: node.itemId });
  }
  for (const building of state.buildings) {
    if (visibleBuildingIds && !visibleBuildingIds.has(building.itemId)) continue;
    const radius = buildingRadius(building.itemId, state.difficulty);
    if (radius > 0) areas.push({ id: building.id, kind: "building", position: building.position, radius, color: buildingColor(building.itemId), itemId: building.itemId });
  }
  for (const landmark of state.landmarks) {
    if (!landmark.landmarkId) continue;
    if (visibleBuildingIds) continue;
    areas.push({
      id: landmark.id,
      kind: "landmark",
      position: landmark.position,
      radius: LANDMARK_BY_ID.get(landmark.landmarkId)?.radius ?? 2,
      color: "#7768b5",
    });
  }

  const catColors = mapCats(state, (cat) => {
    const resources = resourceNodesAtPosition(state.resourceNodes, cat.position)
      .filter((node) => !visibleResourceIds || visibleResourceIds.has(node.itemId));
    const coveredRequirements = requirements.filter((requirement) => state.buildings.some((building) => (
      building.itemId === requirement.buildingItemId
      && Math.abs(building.position.x - cat.position.x) + Math.abs(building.position.y - cat.position.y) <= requirement.maxManhattanDistance
    )));
    const hasAnyBuilding = state.buildings.some((building) => {
      if (visibleBuildingIds && !visibleBuildingIds.has(building.itemId)) return false;
      const radius = buildingRadius(building.itemId, state.difficulty);
      return radius > 0 && Math.abs(building.position.x - cat.position.x) + Math.abs(building.position.y - cat.position.y) <= radius;
    }) || (!visibleBuildingIds && state.landmarks.some((landmark) => landmark.landmarkId && (
      Math.abs(landmark.position.x - cat.position.x) + Math.abs(landmark.position.y - cat.position.y)
        <= (LANDMARK_BY_ID.get(landmark.landmarkId)?.radius ?? 0)
    )));

    if (itemId) {
      if (isHarvestTarget) return resources.length > 0 ? LENS_COLORS.darkGreen : LENS_COLORS.red;
      if (requirements.length === 0) return LENS_COLORS.lightGreen;
      if (coveredRequirements.length === requirements.length) return LENS_COLORS.darkGreen;
      if (coveredRequirements.length > 0) return LENS_COLORS.yellow;
      return LENS_COLORS.red;
    }
    if (resources.length > 0 && hasAnyBuilding) return LENS_COLORS.purple;
    if (resources.length > 0) return LENS_COLORS.darkGreen;
    if (hasAnyBuilding) return LENS_COLORS.blue;
    return LENS_COLORS.neutral;
  });
  return {
    catColors,
    areas,
    legend: itemId
      ? [
          { ...LENS_COLORS.darkGreen, label: "完全满足环境" },
          { ...LENS_COLORS.lightGreen, label: "无需空间条件" },
          { ...LENS_COLORS.yellow, label: "部分满足" },
          { ...LENS_COLORS.red, label: "环境不满足" },
        ]
      : [
          { ...LENS_COLORS.darkGreen, label: "资源覆盖" },
          { ...LENS_COLORS.blue, label: "建筑覆盖" },
          { ...LENS_COLORS.purple, label: "资源与建筑叠加" },
          { ...LENS_COLORS.neutral, label: "无覆盖" },
        ],
  };
}

function wealthWindowLabel(windowMs: number): string {
  return windowMs < 60_000 ? `${windowMs / 1_000}秒` : `${windowMs / 60_000}分钟`;
}

function signedMoney(cents: number): string {
  return `${cents > 0 ? "+" : ""}${formatMoney(cents)}`;
}

function wealthSnapshot(
  state: GameState,
  mode: WealthLensMode = "total",
  requestedWindowMs = DEFAULT_WEALTH_LENS_WINDOW_MS,
): Pick<MapLensSnapshot, "catColors" | "legend" | "metric"> {
  const windowMs = WEALTH_LENS_WINDOW_OPTIONS_MS.reduce((best, candidate) => (
    Math.abs(candidate - requestedWindowMs) < Math.abs(best - requestedWindowMs) ? candidate : best
  ), DEFAULT_WEALTH_LENS_WINDOW_MS);
  const currentValues = new Map(state.cats.map((cat) => [cat.id, catWealthScoreCents(state, cat)] as const));
  const cutoff = state.simTime - windowMs;
  const baseline = [...state.wealthHistory].reverse().find((sample) => sample.at <= cutoff)
    ?? state.wealthHistory[0]
    ?? { at: state.simTime, values: Object.fromEntries(currentValues) };
  const values = mode === "change"
    ? new Map([...currentValues].map(([catId, value]) => [catId, value - (baseline.values[catId] ?? value)]))
    : currentValues;
  const ordered = [...values.values()].sort((left, right) => left - right);
  const min = ordered[0] ?? 0;
  const max = ordered.at(-1) ?? min;
  const median = ordered.length === 0 ? 0 : ordered[Math.floor((ordered.length - 1) / 2)];
  const spread = max - min;
  const absoluteBound = Math.max(Math.abs(min), Math.abs(max));
  const normalized = new Map([...values].map(([catId, value]) => [
    catId,
    spread === 0 ? 0.5 : mode === "change" ? (value + absoluteBound) / (absoluteBound * 2) : (value - min) / spread,
  ]));
  const catColors = new Map(state.cats.map((cat) => [
    cat.id,
    spread === 0 ? LENS_COLORS.neutral : wealthHeatColor(normalized.get(cat.id) ?? 0.5),
  ]));
  const legend = spread === 0
    ? [{ ...LENS_COLORS.neutral, label: mode === "change"
      ? `${wealthWindowLabel(windowMs)}内全部持平 · ${signedMoney(min)}`
      : `全部相同 · ${formatMoney(min)}` }]
    : mode === "change"
      ? [
          { ...wealthHeatColor((max + absoluteBound) / (absoluteBound * 2)), label: `${max >= 0 ? "最高增长" : "最少减少"} · ${signedMoney(max)}` },
          { ...wealthHeatColor(0.5), label: "持平 · 0.00" },
          { ...wealthHeatColor((min + absoluteBound) / (absoluteBound * 2)), label: `${min < 0 ? "最大减少" : "最低增长"} · ${signedMoney(min)}` },
        ]
      : [
          { ...wealthHeatColor(1), label: `最高 · ${formatMoney(max)}` },
          { ...wealthHeatColor(0.5), label: `中位 · ${formatMoney(median)}` },
          { ...wealthHeatColor(0), label: `最低 · ${formatMoney(min)}` },
        ];
  return {
    catColors,
    legend,
    metric: { unit: "cents", mode, windowMs, baselineAt: baseline.at, min, median, max, values, normalized },
  };
}

function activitySnapshot(state: GameState): Pick<MapLensSnapshot, "catColors" | "legend" | "metric"> {
  const lastEffectiveActionAt = new Map<string, number>();
  for (const entry of state.commandAudit) {
    if (entry.origin !== "simulation" || entry.kind !== "action-start" || !entry.ok) continue;
    if (!entry.detail?.startsWith("craft:") && !entry.detail?.startsWith("pass:")) continue;
    lastEffectiveActionAt.set(entry.target, Math.max(lastEffectiveActionAt.get(entry.target) ?? 0, entry.atMs));
  }

  const values = new Map(state.cats.map((cat) => {
    const working = cat.action?.type === "craft" || cat.action?.type === "pass";
    const lastAt = lastEffectiveActionAt.get(cat.id);
    const inactiveMs = working ? 0 : lastAt === undefined
      ? ACTIVITY_STALLED_MS
      : Math.max(0, state.simTime - lastAt);
    return [cat.id, inactiveMs] as const;
  }));
  const normalized = new Map([...values].map(([catId, inactiveMs]) => [
    catId,
    Math.min(1, inactiveMs / ACTIVITY_STALLED_MS),
  ]));
  const ordered = [...values.values()].sort((left, right) => left - right);
  const min = ordered[0] ?? 0;
  const max = ordered.at(-1) ?? min;
  const median = ordered.length === 0 ? 0 : ordered[Math.floor((ordered.length - 1) / 2)];
  return {
    catColors: new Map(state.cats.map((cat) => [
      cat.id,
      activityHeatColor(normalized.get(cat.id) ?? 1),
    ])),
    legend: [
      { ...activityHeatColor(0), label: "正在制作或运输" },
      { ...activityHeatColor(0.5), label: "约 30 秒未行动" },
      { ...activityHeatColor(1), label: "60 秒以上未行动" },
    ],
    metric: { unit: "milliseconds", min, median, max, values, normalized },
  };
}

function lawSnapshot(state: GameState): Pick<MapLensSnapshot, "catColors" | "legend"> {
  const activeLaws = state.laws.filter((law) => law.status === "active");
  const lawColors = new Map(activeLaws.map((law, index) => {
    const base = LAW_PALETTE[index % LAW_PALETTE.length];
    return [law.id, { ...base, id: `law-${law.id}`, label: law.title }] as const;
  }));
  return {
    catColors: mapCats(state, (cat) => lawColors.get(cat.action?.lawId ?? "") ?? LENS_COLORS.neutral),
    legend: [...lawColors.values(), { ...LENS_COLORS.neutral, label: "当前无主导法规" }],
  };
}

function inventoryLensColor(itemId: ItemId): LensColor {
  const palette = itemQualityPalette(itemId);
  return color(
    `inventory-${palette.id}`,
    palette.label,
    palette.topStops[1],
    palette.sideRight,
    palette.sideLeft,
    palette.accent,
  );
}

function inventorySnapshot(state: GameState): Pick<MapLensSnapshot, "catColors" | "legend"> {
  const catColors = mapCats(state, (cat) => {
    const highest = Object.entries(cat.inventory)
      .filter(([itemId, quantity]) => quantity > 0 && ITEM_BY_ID.has(itemId))
      .sort(([leftId], [rightId]) => itemQualityLevel(rightId) - itemQualityLevel(leftId)
        || leftId.localeCompare(rightId))[0]?.[0];
    return highest ? inventoryLensColor(highest) : LENS_COLORS.neutral;
  });
  const representativeIds: ItemId[] = ["wood", "fire", "metal", "lamp", "chip", "computer", "rocket", "stargate"];
  return {
    catColors,
    legend: representativeIds.map((itemId) => {
      const item = ITEM_BY_ID.get(itemId)!;
      return { ...inventoryLensColor(itemId), label: `${item.emoji} ${item.name}档` };
    }).concat([{ ...LENS_COLORS.neutral, label: "没有库存" }]),
  };
}

function stabilitySnapshot(state: GameState, itemId: ItemId | null): Pick<MapLensSnapshot, "catColors" | "edges" | "orderFloors" | "legend"> {
  const target = itemId ?? state.discoveredItems[0] ?? null;
  const windowStart = state.simTime - 60_000;
  const relevantFlows = target ? state.productionHistory.flows.filter((flow) => flow.outputItemId === target) : [];
  const demandByCat = new Map<string, Set<ItemId>>();
  const supplyByCat = new Map<string, Set<ItemId>>();
  const targetByDemand = new Map<string, Map<ItemId, Set<ItemId>>>();
  const addRoleItem = (map: Map<string, Set<ItemId>>, catId: string, roleItemId: ItemId) => {
    const items = map.get(catId) ?? new Set<ItemId>();
    items.add(roleItemId);
    map.set(catId, items);
  };
  const addDemandTarget = (catId: string, demandItemId: ItemId, targetItemId: ItemId) => {
    const byItem = targetByDemand.get(catId) ?? new Map<ItemId, Set<ItemId>>();
    const targets = byItem.get(demandItemId) ?? new Set<ItemId>();
    targets.add(targetItemId);
    byItem.set(demandItemId, targets);
    targetByDemand.set(catId, byItem);
  };
  if (target) {
    for (const cat of state.cats) {
      const counter = state.productionHistory.byCat[cat.id]?.[target];
      if ((counter?.plannedCount ?? 0) > 0 || (counter?.craftedCount ?? 0) > 0) addRoleItem(supplyByCat, cat.id, target);
    }
    for (const flow of relevantFlows) {
      addRoleItem(supplyByCat, flow.sourceCatId, flow.itemId);
      addRoleItem(demandByCat, flow.targetCatId, flow.itemId);
      addDemandTarget(flow.targetCatId, flow.itemId, target);
    }
  }
  const catColors = mapCats(state, (cat) => {
    const counter = target ? state.productionHistory.byCat[cat.id]?.[target] : undefined;
    const events = state.recentProductionEvents.filter((event) => event.catId === cat.id
      && (!target || event.itemId === target) && event.at >= windowStart && event.at <= state.simTime);
    const craftedCount = Math.max(counter?.craftedCount ?? 0, events.length);
    if ((counter?.plannedCount ?? 0) === 0 && craftedCount === 0
      && !demandByCat.has(cat.id) && !supplyByCat.has(cat.id)) return LENS_COLORS.neutral;
    if (craftedCount === 0) {
      if (demandByCat.has(cat.id) && supplyByCat.has(cat.id)) return LENS_COLORS.purple;
      return demandByCat.has(cat.id) ? LENS_COLORS.red : LENS_COLORS.yellow;
    }
    if (craftedCount < 3) return LENS_COLORS.red;
    if (events.length === 0) return LENS_COLORS.orange;
    const windows = new Set(events.map((event) => Math.max(0, Math.min(2, Math.floor((event.at - windowStart) / 20_000)))));
    if (windows.size >= 2 && windows.has(2)) return LENS_COLORS.darkGreen;
    if (windows.size >= 2) return LENS_COLORS.orange;
    return LENS_COLORS.yellow;
  });
  const participatingCatIds = new Set([...demandByCat.keys(), ...supplyByCat.keys()]);
  const orderFloors = new Map([...participatingCatIds].map((catId) => [catId, {
    catId,
    demandItemIds: [...(demandByCat.get(catId) ?? [])].sort(),
    demandTargets: [...(targetByDemand.get(catId)?.entries() ?? [])]
      .map(([demandItemId, targets]) => ({ itemId: demandItemId, targetItemIds: [...targets].sort() }))
      .sort((left, right) => left.itemId.localeCompare(right.itemId)),
    supplyItemIds: [...(supplyByCat.get(catId) ?? [])].sort(),
    carrier: false,
  }] as const));
  const edges: MapLensEdge[] = relevantFlows.map((flow) => ({
    id: `stability-${flow.id}`,
    sourceCatId: flow.sourceCatId,
    targetCatId: flow.targetCatId,
    color: flow.kind === "input" ? LENS_COLORS.orange.top : LENS_COLORS.blue.top,
    count: flow.count,
    itemId: flow.itemId,
    kind: flow.kind,
  }));
  return {
    catColors,
    edges,
    orderFloors,
    legend: [
      { ...LENS_COLORS.darkGreen, label: "重复且最近仍生产" },
      { ...LENS_COLORS.yellow, label: "有计划或产出集中" },
      { ...LENS_COLORS.orange, label: "历史重复、最近停产" },
      { ...LENS_COLORS.red, label: "需求方或仅偶产" },
      { ...LENS_COLORS.blue, label: "成品去向（线宽=次数）" },
      { ...LENS_COLORS.neutral, label: "从未参与所选商品" },
    ],
  };
}

export function buildMapLensSnapshot(
  state: GameState,
  lensId: MapLensId,
  itemId: ItemId | null,
  options: MapLensOptions = {},
): MapLensSnapshot {
  const empty: MapLensSnapshot = { lensId, itemId, catColors: new Map(), edges: [], areas: [], orderFloors: new Map(), legend: [], metric: null };
  if (lensId === "none") return empty;
  if (lensId === "inventory") return { ...empty, ...inventorySnapshot(state) };
  if (lensId === "orders") return { ...empty, ...orderSnapshot(state, itemId) };
  if (lensId === "bottlenecks") return { ...empty, ...bottleneckSnapshot(state, itemId) };
  if (lensId === "environment") return { ...empty, ...environmentSnapshot(state, itemId) };
  if (lensId === "wealth") return { ...empty, ...wealthSnapshot(state, options.wealthMode, options.wealthWindowMs) };
  if (lensId === "activity") return { ...empty, ...activitySnapshot(state) };
  if (lensId === "law") return { ...empty, ...lawSnapshot(state) };
  if (lensId === "coordinates") return { ...empty, ...coordinateSnapshot(state) };
  return { ...empty, ...stabilitySnapshot(state, itemId) };
}

export function mapLensTitle(lensId: MapLensId, itemId: ItemId | null, options: MapLensOptions = {}): string {
  const lens = MAP_LENS_OPTIONS.find((entry) => entry.id === lensId)?.label ?? "普通地图";
  if (lensId === "wealth") {
    const mode = options.wealthMode ?? "total";
    const windowMs = options.wealthWindowMs ?? DEFAULT_WEALTH_LENS_WINDOW_MS;
    return mode === "change" ? `${lens} · 近${wealthWindowLabel(windowMs)}增量` : `${lens} · 当前总量`;
  }
  const item = ITEM_SCOPED_LENSES.has(lensId) && itemId ? ITEM_BY_ID.get(itemId) : null;
  return item ? `${lens} · ${item.emoji} ${item.name}` : lens;
}

export function resourceColor(itemId: ItemId): string {
  return ({ wood: "#8f6b43", stone: "#758391", sand: "#d1a94c", water: "#4b99d2", fiber: "#4f9d65", ore: "#846bab" } as Record<string, string>)[itemId] ?? "#6c7e70";
}

export function buildingColor(itemId: ItemId): string {
  return ({ factory: "#4d9a63", machine_tool: "#4d83bd", antenna: "#8b65af", lab: "#c2934f", reactor: "#bd5d63" } as Record<string, string>)[itemId] ?? "#687c9a";
}
