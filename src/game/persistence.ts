import { deleteDB, openDB } from "idb";
import { CATALOG_VERSION, INTRO_RECIPE_IDS, ITEMS, RECIPE_BY_ID } from "./catalog";
import { createInitialState } from "./engine";
import { LEGACY_SAVE_DIFFICULTY, normalizeDifficulty } from "./difficulty";
import { validateLawSource } from "./lawInterpreter";
import { ensureMarketBroadcasts } from "./market";
import { createStarterScenario } from "./starterScenario";
import type { GameState, ItemStats, Position, ResourceNode } from "./types";
import { generateParcelResourceNodes, normalizeWorldSeed, parcelBounds, parcelForPosition, parcelKey, positionKey } from "./world";

const DB_NAME = "cat-law-workshop";
const STORE_NAME = "saves";
const SAVE_KEY = "autosave";

async function database() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    },
  });
}

export async function saveGame(state: GameState): Promise<void> {
  const db = await database();
  const snapshot = structuredClone(state);
  snapshot.floatingEvents = [];
  await db.put(STORE_NAME, snapshot, SAVE_KEY);
  db.close();
}

export async function loadGame(fallbackSeed?: number): Promise<GameState> {
  const db = await database();
  const raw = await db.get(STORE_NAME, SAVE_KEY) as any;
  db.close();
  return migrateSaveSnapshot(raw, fallbackSeed);
  /* Previous inline migration retained in source history for compatibility review.
  if (!raw || ![1, 2].includes(raw.schemaVersion ?? 0) || !Array.isArray(raw.cats)) return createInitialState({ worldSeed: fallbackSeed });
  const legacy = raw.schemaVersion === 1;
  const worldSeed = normalizeWorldSeed(raw.worldSeed ?? (legacy ? legacySeed(raw) : fallbackSeed ?? 0));
  const fallback = createInitialState({ worldSeed });
  const state = { ...fallback, ...raw } as GameState;
  state.schemaVersion = 2;
  state.worldSeed = worldSeed;
  state.paused = false;
  state.catalogVersion = CATALOG_VERSION;
  state.simulationSpeed = 1;
  state.floatingEvents = [];
  state.dirtyDecisions = true;
  state.treasuryCoins = Number.isFinite(state.treasuryCoins) ? state.treasuryCoins : 0;
  state.cats = state.cats.map((cat, index) => ({
    ...cat,
    id: cat.id || `cat-${index}`,
    createdIndex: Number.isFinite(cat.createdIndex) ? cat.createdIndex : index,
    coins: Number.isFinite(cat.coins) ? cat.coins : 0,
    inventory: cat.inventory ?? {},
    action: cat.action ?? null,
    decisionTrace: cat.decisionTrace ?? [],
  }));
  if (legacy) migrateLegacyWorld(state);
  else normalizeWorld(state, fallback);
  const emptyItemStats = Object.fromEntries(ITEMS.map((entry) => [entry.id, { crafted: 0, passed: 0, sold: 0, revenue: 0 }])) as Record<string, ItemStats>;
  state.itemStats = { ...emptyItemStats, ...(state.itemStats ?? {}) };
  state.discoveredItems = (state.discoveredItems ?? []).filter((id) => ITEMS.some((entry) => entry.id === id));
  state.unlockedRecipes = [...new Set([
    ...INTRO_RECIPE_IDS,
    ...(state.unlockedRecipes ?? []).filter((id) => RECIPE_BY_ID.has(id)),
  ])];
  const starterLaws = new Map(createStarterScenario(state.worldSeed).laws.map((law) => [law.id, law]));
  state.laws = (state.laws ?? []).map((law) => {
    const replacement = starterLaws.get(law.id);
    if (replacement) {
      return {
        ...structuredClone(replacement),
        hitCount: law.hitCount ?? 0,
        invalidCount: law.invalidCount ?? 0,
        status: law.status,
      };
    }
    const checked = validateLawSource(law.sourceCode);
    return {
      ...law,
      category: law.category ?? "behavior",
      taxRate: law.taxRate ?? null,
      priceItemId: law.priceItemId ?? null,
      priceMultiplier: law.priceMultiplier ?? null,
      status: checked.ok && checked.hash === law.astHash ? law.status : "quarantined",
      consecutiveFaults: 0,
    };
  });
  return state;
  */
}

export function migrateSaveSnapshot(raw: any, fallbackSeed?: number): GameState {
  if (!raw || ![1, 2, 3, 4, 5, 6, 7].includes(raw.schemaVersion ?? 0) || !Array.isArray(raw.cats)) return createInitialState({ worldSeed: fallbackSeed });
  const legacy = raw.schemaVersion === 1;
  const needsResourceRegionMigration = raw.schemaVersion < 3;
  const needsMarketMigration = raw.schemaVersion < 4;
  const needsBuildingMarketMigration = raw.schemaVersion < 5;
  const needsDifficultyMigration = raw.schemaVersion < 6;
  const worldSeed = normalizeWorldSeed(raw.worldSeed ?? (legacy ? legacySeed(raw) : fallbackSeed ?? 0));
  const fallback = createInitialState({ worldSeed, difficulty: needsDifficultyMigration ? LEGACY_SAVE_DIFFICULTY : normalizeDifficulty(raw.difficulty) });
  const state = { ...fallback, ...structuredClone(raw) } as GameState;
  state.schemaVersion = 7;
  state.difficulty = needsDifficultyMigration
    ? LEGACY_SAVE_DIFFICULTY
    : normalizeDifficulty(raw.difficulty, fallback.difficulty);
  state.worldSeed = worldSeed;
  state.paused = false;
  state.catalogVersion = CATALOG_VERSION;
  state.simulationSpeed = 1;
  state.floatingEvents = [];
  state.dirtyDecisions = true;
  state.treasuryCoins = Number.isFinite(state.treasuryCoins) ? state.treasuryCoins * (needsMarketMigration ? 100 : 1) : 0;
  state.totalSales = Number.isFinite(state.totalSales) ? state.totalSales * (needsMarketMigration ? 100 : 1) : 0;
  state.cats = state.cats.map((cat, index) => ({
    ...cat,
    id: cat.id || `cat-${index}`,
    createdIndex: Number.isFinite(cat.createdIndex) ? cat.createdIndex : index,
    coins: Number.isFinite(cat.coins) ? cat.coins * (needsMarketMigration ? 100 : 1) : 0,
    debtCents: Number.isFinite(cat.debtCents) ? cat.debtCents : 0,
    escrowReservedCents: Number.isFinite(cat.escrowReservedCents) ? cat.escrowReservedCents : 0,
    inventory: cat.inventory ?? {},
    action: cat.action ?? null,
    decisionTrace: cat.decisionTrace ?? [],
  }));
  if (legacy) migrateLegacyWorld(state);
  else normalizeWorld(state, fallback);
  normalizeResourceRegions(state, needsResourceRegionMigration);
  const emptyItemStats = Object.fromEntries(ITEMS.map((entry) => [entry.id, { crafted: 0, passed: 0, sold: 0, revenue: 0 }])) as Record<string, ItemStats>;
  state.itemStats = { ...emptyItemStats, ...(state.itemStats ?? {}) };
  if (needsMarketMigration) {
    for (const stats of Object.values(state.itemStats)) stats.revenue *= 100;
    for (const cat of state.cats) {
      if (cat.action?.type !== "pass") continue;
      for (const [itemId, quantity] of Object.entries(cat.action.reserved ?? {})) {
        cat.inventory[itemId] = (cat.inventory[itemId] ?? 0) + quantity;
      }
      cat.action = null;
      cat.lastDecision = "旧版无偿传递已取消，物品退回库存";
    }
    state.buildingOrders = [];
    state.procurementPlans = [];
    state.demandOrders = [];
    state.orderSignals = [];
    state.shipmentContracts = [];
    state.marketEvents = [];
    state.nextProcurementPlanIndex = 0;
    state.nextDemandOrderIndex = 0;
    state.nextContractIndex = 0;
    state.nextMarketEventIndex = 0;
    state.nextMarketTickAt = Math.floor(state.simTime / 1_000) * 1_000 + 1_000;
    state.discoveryBounties = fallback.discoveryBounties.map((bounty) => ({
      ...bounty,
      paid: state.discoveredItems?.includes(bounty.itemId) ?? false,
    }));
  } else {
    state.procurementPlans = Array.isArray(state.procurementPlans) ? state.procurementPlans : [];
    state.demandOrders = Array.isArray(state.demandOrders) ? state.demandOrders : [];
    state.orderSignals = Array.isArray(state.orderSignals) ? state.orderSignals : [];
    state.shipmentContracts = Array.isArray(state.shipmentContracts) ? state.shipmentContracts : [];
    state.discoveryBounties = Array.isArray(state.discoveryBounties) ? state.discoveryBounties : fallback.discoveryBounties;
    state.marketEvents = Array.isArray(state.marketEvents) ? state.marketEvents.slice(-64) : [];
    state.nextMarketTickAt = Number.isFinite(state.nextMarketTickAt) && state.nextMarketTickAt > state.simTime
      ? state.nextMarketTickAt
      : Math.floor(state.simTime / 1_000) * 1_000 + 1_000;
  }
  state.nextProcurementPlanIndex = Number.isInteger(state.nextProcurementPlanIndex) ? state.nextProcurementPlanIndex : state.procurementPlans.length;
  state.nextDemandOrderIndex = Number.isInteger(state.nextDemandOrderIndex) ? state.nextDemandOrderIndex : state.demandOrders.length;
  if (Array.isArray(state.marketBroadcasts)) {
    const seenSubjects = new Set<string>();
    state.marketBroadcasts = [...state.marketBroadcasts].reverse().filter((broadcast) => {
      if (seenSubjects.has(broadcast.subjectId)) return false;
      seenSubjects.add(broadcast.subjectId);
      return true;
    }).reverse();
  } else {
    state.marketBroadcasts = [];
  }
  const inferredBroadcastIndex = state.marketBroadcasts.reduce((next, broadcast) => {
    const parsed = Number(broadcast.id.slice(broadcast.id.lastIndexOf("-") + 1));
    return Number.isFinite(parsed) ? Math.max(next, parsed + 1) : next;
  }, 0);
  state.nextMarketBroadcastIndex = Math.max(
    Number.isInteger(state.nextMarketBroadcastIndex) ? state.nextMarketBroadcastIndex : 0,
    inferredBroadcastIndex,
  );
  state.nextContractIndex = Number.isInteger(state.nextContractIndex) ? state.nextContractIndex : state.shipmentContracts.length;
  state.nextMarketEventIndex = Number.isInteger(state.nextMarketEventIndex) ? state.nextMarketEventIndex : state.marketEvents.length;
  state.discoveredItems = (state.discoveredItems ?? []).filter((id) => ITEMS.some((entry) => entry.id === id));
  state.landmarks = Array.isArray(state.landmarks) ? state.landmarks : [];
  state.unlockedLandmarkIds = Array.isArray(state.unlockedLandmarkIds) ? state.unlockedLandmarkIds : [];
  state.nextLandmarkIndex = Number.isInteger(state.nextLandmarkIndex) ? state.nextLandmarkIndex : state.landmarks.length;
  if (needsBuildingMarketMigration) migrateBuildingMarket(state);
  else {
    state.buildingOffers = Array.isArray(state.buildingOffers) ? state.buildingOffers : [];
    state.playerBuildingInventory = state.playerBuildingInventory ?? {};
    state.nextBuildingOfferIndex = Number.isInteger(state.nextBuildingOfferIndex)
      ? state.nextBuildingOfferIndex
      : state.buildingOffers.length;
  }
  const existingBounties = new Map((state.discoveryBounties ?? []).map((bounty) => [bounty.itemId, bounty]));
  state.discoveryBounties = fallback.discoveryBounties.map((fresh) => {
    const existing = existingBounties.get(fresh.itemId);
    return {
      ...fresh,
      claimedByCatId: existing?.claimedByCatId ?? null,
      paid: Boolean(existing?.paid || state.discoveredItems.includes(fresh.itemId)),
    };
  });
  state.unlockedRecipes = [...new Set([
    ...INTRO_RECIPE_IDS,
    ...(state.unlockedRecipes ?? []).filter((id) => RECIPE_BY_ID.has(id)),
  ])];
  ensureMarketBroadcasts(state);
  const starterLaws = new Map(createStarterScenario(state.worldSeed).laws.map((law) => [law.id, law]));
  state.laws = (state.laws ?? []).map((law) => {
    const replacement = starterLaws.get(law.id);
    if (replacement) {
      return { ...structuredClone(replacement), hitCount: law.hitCount ?? 0, invalidCount: law.invalidCount ?? 0, status: law.status };
    }
    const checked = validateLawSource(law.sourceCode);
    return {
      ...law,
      category: law.category ?? "behavior",
      locked: law.locked ?? false,
      taxRate: law.taxRate ?? null,
      priceItemId: law.priceItemId ?? null,
      priceMultiplier: law.priceMultiplier ?? null,
      status: checked.ok && checked.hash === law.astHash ? law.status : "quarantined",
      consecutiveFaults: 0,
    };
  });
  const requiredSystemLaws = createStarterScenario(state.worldSeed).laws.filter((law) => law.category === "system");
  let systemInsertionIndex = state.laws.reduce((last, law, index) => law.category === "behavior" ? index + 1 : last, 0);
  for (const required of requiredSystemLaws) {
    if (state.laws.some((law) => law.id === required.id)) continue;
    state.laws.splice(systemInsertionIndex, 0, structuredClone(required));
    systemInsertionIndex += 1;
  }
  state.lawHistory = Array.isArray(state.lawHistory) ? state.lawHistory : [];
  for (const required of requiredSystemLaws) {
    if (!state.lawHistory.some((law) => law.id === required.id)) state.lawHistory.push(structuredClone(required));
  }
  return state;
}

function migrateBuildingMarket(state: GameState): void {
  state.playerBuildingInventory = {};
  for (const building of state.buildings ?? []) {
    state.playerBuildingInventory[building.itemId] = (state.playerBuildingInventory[building.itemId] ?? 0) + 1;
  }
  state.buildings = [];
  const retainedOrders = [] as GameState["buildingOrders"];
  for (const order of state.buildingOrders ?? []) {
    const demand = order.demandOrderId ? state.demandOrders.find((entry) => entry.id === order.demandOrderId) : undefined;
    if (demand?.status === "contracted") {
      retainedOrders.push(order);
      continue;
    }
    if (demand?.status === "open") {
      state.treasuryCoins += demand.reservedCents;
      demand.status = "cancelled";
      demand.closedAt = state.simTime;
      demand.closeReason = "0.8.0 取消旧式自动部署订单";
      state.orderSignals = state.orderSignals.filter((signal) => signal.orderId !== demand.id);
    }
  }
  state.buildingOrders = retainedOrders;
  state.buildingOffers = [];
  state.nextBuildingOfferIndex = 0;
}

function legacySeed(raw: Partial<GameState>): number {
  let hash = 2166136261;
  const text = `${raw.simTime ?? 0}|${(raw.cats ?? []).map((cat) => `${cat.position?.x ?? 0},${cat.position?.y ?? 0}`).join(";")}`;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function migrateLegacyWorld(state: GameState): void {
  const parcels = new Map<string, Position>([["0,0", { x: 0, y: 0 }]]);
  for (const cat of state.cats) {
    const parcel = parcelForPosition(cat.position);
    parcels.set(parcelKey(parcel), parcel);
  }
  state.unlockedParcels = [...parcels.values()];
  state.resourceNodes = [];
  state.buildings = [];
  state.buildingOrders = [];
  state.nextBuildingIndex = 0;
  state.nextBuildingOrderIndex = 0;
  state.logisticsStatus = [];
}

function normalizeResourceRegions(state: GameState, regenerate: boolean): void {
  const source = regenerate
    ? state.unlockedParcels.flatMap((parcel) => generateParcelResourceNodes(state.worldSeed, parcel))
    : state.resourceNodes;
  const catPositions = new Set(state.cats.map((cat) => positionKey(cat.position)));
  const placed: ResourceNode[] = [];
  for (const node of source) {
    const overlapsPlaced = (position: Position) => placed.some((entry) => Math.max(
      Math.abs(entry.position.x - position.x),
      Math.abs(entry.position.y - position.y),
    ) < 3);
    if (!catPositions.has(positionKey(node.position)) && !overlapsPlaced(node.position)) {
      placed.push(structuredClone(node));
      continue;
    }
    const bounds = parcelBounds(parcelForPosition(node.position));
    const candidates: Position[] = [];
    for (let y = bounds.minY + 1; y <= bounds.maxY - 1; y += 1) {
      for (let x = bounds.minX + 1; x <= bounds.maxX - 1; x += 1) {
        const position = { x, y };
        if (!catPositions.has(positionKey(position)) && !placed.some((entry) => positionKey(entry.position) === positionKey(position))) {
          candidates.push(position);
        }
      }
    }
    candidates.sort((left, right) => Number(overlapsPlaced(left)) - Number(overlapsPlaced(right))
      || Math.abs(left.x - node.position.x) + Math.abs(left.y - node.position.y)
        - Math.abs(right.x - node.position.x) - Math.abs(right.y - node.position.y)
      || left.y - right.y || left.x - right.x);
    placed.push({ ...node, position: candidates[0] ?? { ...node.position } });
  }
  state.resourceNodes = placed;
}

function normalizeWorld(state: GameState, fallback: GameState): void {
  const parcels = new Map<string, Position>();
  for (const parcel of state.unlockedParcels ?? fallback.unlockedParcels) {
    if (Number.isInteger(parcel.x) && Number.isInteger(parcel.y)) parcels.set(parcelKey(parcel), { ...parcel });
  }
  parcels.set("0,0", { x: 0, y: 0 });
  for (const cat of state.cats) {
    const parcel = parcelForPosition(cat.position);
    parcels.set(parcelKey(parcel), parcel);
  }
  state.unlockedParcels = [...parcels.values()];
  state.resourceNodes = Array.isArray(state.resourceNodes) && state.resourceNodes.length ? state.resourceNodes : fallback.resourceNodes;
  state.buildings = Array.isArray(state.buildings) ? state.buildings : [];
  state.buildingOrders = Array.isArray(state.buildingOrders) ? state.buildingOrders : [];
  state.nextBuildingIndex = Number.isInteger(state.nextBuildingIndex) ? state.nextBuildingIndex : state.buildings.length;
  state.nextBuildingOrderIndex = Number.isInteger(state.nextBuildingOrderIndex) ? state.nextBuildingOrderIndex : state.buildingOrders.length;
  state.logisticsStatus = [];
}

export async function clearSave(): Promise<void> {
  await deleteDB(DB_NAME);
}
