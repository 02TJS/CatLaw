import { deleteDB, openDB } from "idb";
import { CATALOG_VERSION, INTRO_RECIPE_IDS, ITEMS, RECIPE_BY_ID } from "./catalog";
import { compactGameStateHistory, createInitialState, scheduleInternalWait } from "./engine";
import { LEGACY_SAVE_DIFFICULTY, normalizeDifficulty } from "./difficulty";
import { validateLawSource } from "./lawInterpreter";
import { appendLegacyEffects, normalizeProgram } from "./lawProgram";
import { ensureMarketBroadcasts, repairBrokenMarketReferences } from "./market";
import { normalizeSpeechFrequency, safeSpeechTemplates } from "./speech";
import { createStarterScenario } from "./starterScenario";
import type { GameState, ItemStats, LawProgram, LawVersion, Position, ResourceNode } from "./types";
import { generateParcelResourceNodes, normalizeWorldSeed, parcelBounds, parcelForPosition, parcelKey, positionKey } from "./world";
import { normalizeAchievementState } from "./achievements";
import { normalizeProductionHistory } from "./productionHistory";

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

/**
 * Create the only shape that may cross the persistence boundary.
 *
 * Law source and history are durable rules, but every evaluated law effect is
 * process-local. The explicit deletion also cleans up saves made by versions
 * that accidentally attached a legacy `lawPolicy` property to a cat.
 */
export function serializeGameState(state: GameState): GameState {
  const snapshot = structuredClone(state) as GameState & {
    cats: Array<GameState["cats"][number] & { lawPolicy?: unknown }>;
  };
  snapshot.cats = snapshot.cats.map((cat) => {
    const persistedCat = { ...cat } as typeof cat & { lawPolicy?: unknown };
    delete persistedCat.lawPolicy;
    return persistedCat;
  });
  snapshot.floatingEvents = [];
  compactGameStateHistory(snapshot);
  return snapshot;
}

export async function saveGame(state: GameState): Promise<void> {
  const snapshot = serializeGameState(state);
  const db = await database();
  try {
    await db.put(STORE_NAME, snapshot, SAVE_KEY);
  } finally {
    db.close();
  }
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
      program: normalizeProgram(law.program, law.sourceCode),
      status: checked.ok && checked.hash === law.astHash ? law.status : "quarantined",
      consecutiveFaults: 0,
    };
  });
  return state;
  */
}

export function migrateSaveSnapshot(raw: any, fallbackSeed?: number): GameState {
  if (!raw || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].includes(raw.schemaVersion ?? 0) || !Array.isArray(raw.cats)) return createInitialState({ worldSeed: fallbackSeed });
  const legacy = raw.schemaVersion === 1;
  const needsResourceRegionMigration = raw.schemaVersion < 3;
  const needsMarketMigration = raw.schemaVersion < 4;
  const needsBuildingMarketMigration = raw.schemaVersion < 5;
  const needsDifficultyMigration = raw.schemaVersion < 6;
  const needsStarterLawMigration = raw.schemaVersion < 12;
  const needsReliableMarketMigration = raw.schemaVersion < 14;
  const worldSeed = normalizeWorldSeed(raw.worldSeed ?? (legacy ? legacySeed(raw) : fallbackSeed ?? 0));
  const fallback = createInitialState({ worldSeed, difficulty: needsDifficultyMigration ? LEGACY_SAVE_DIFFICULTY : normalizeDifficulty(raw.difficulty) });
  const state = { ...fallback, ...structuredClone(raw) } as GameState;
  state.schemaVersion = 15;
  state.difficulty = needsDifficultyMigration
    ? LEGACY_SAVE_DIFFICULTY
    : normalizeDifficulty(raw.difficulty, fallback.difficulty);
  state.worldSeed = worldSeed;
  state.paused = false;
  state.catalogVersion = CATALOG_VERSION;
  state.simulationSpeed = 1;
  state.speechFrequency = normalizeSpeechFrequency(raw.speechFrequency);
  state.floatingEvents = [];
  state.dirtyDecisions = false;
  state.lawbookRevision = Number.isInteger(raw.lawbookRevision) ? raw.lawbookRevision : 0;
  state.commandAudit = Array.isArray(raw.commandAudit) ? raw.commandAudit.slice(-2_000) : [];
  state.treasuryCoins = Number.isFinite(state.treasuryCoins) ? state.treasuryCoins * (needsMarketMigration ? 100 : 1) : 0;
  state.totalSales = Number.isFinite(state.totalSales) ? state.totalSales * (needsMarketMigration ? 100 : 1) : 0;
  state.cats = state.cats.map((cat, index) => {
    const { lawPolicy: _legacyEphemeralPolicy, ...persistedCat } = cat as typeof cat & { lawPolicy?: unknown };
    return {
      ...persistedCat,
      id: cat.id || `cat-${index}`,
      createdIndex: Number.isFinite(cat.createdIndex) ? cat.createdIndex : index,
      coins: Number.isFinite(cat.coins) ? cat.coins * (needsMarketMigration ? 100 : 1) : 0,
      debtCents: Number.isFinite(cat.debtCents) ? cat.debtCents : 0,
      escrowReservedCents: Number.isFinite(cat.escrowReservedCents) ? cat.escrowReservedCents : 0,
      inventory: cat.inventory ?? {},
      action: cat.action ?? null,
      decisionTrace: cat.decisionTrace ?? [],
      decisionSerial: Number.isInteger(cat.decisionSerial) && Number(cat.decisionSerial) >= 0 ? Number(cat.decisionSerial) : 0,
      lastSpeechAt: Number.isFinite(cat.lastSpeechAt) ? cat.lastSpeechAt : null,
    };
  });
  for (const cat of state.cats) {
    const legacyAction = cat.action as ({ type?: string; reserved?: Record<string, number> } | null);
    if (legacyAction?.type !== "sell") continue;
    for (const [itemId, quantity] of Object.entries(legacyAction.reserved ?? {})) {
      cat.inventory[itemId] = (cat.inventory[itemId] ?? 0) + quantity;
    }
    cat.action = null;
    cat.lastDecision = "旧版外部出售动作已取消，商品退回猫咪库存，等待玩家收购";
  }
  if (legacy) migrateLegacyWorld(state);
  else normalizeWorld(state, fallback);
  normalizeResourceRegions(state, needsResourceRegionMigration);
  const emptyItemStats = Object.fromEntries(ITEMS.map((entry) => [entry.id, { crafted: 0, passed: 0, sold: 0, revenue: 0 }])) as Record<string, ItemStats>;
  state.itemStats = { ...emptyItemStats, ...(state.itemStats ?? {}) };
  state.recentProductionEvents = Array.isArray(raw.recentProductionEvents)
    ? raw.recentProductionEvents.filter((event: any) => ITEMS.some((item) => item.id === event?.itemId)
      && Number.isFinite(event?.at) && event.at >= state.simTime - 60_000 / state.simulationSpeed)
      .map((event: any) => ({
        itemId: event.itemId,
        at: event.at,
        catId: String(event.catId ?? state.cats[0]?.id ?? "cat-0"),
        valueCents: Number.isFinite(event.valueCents) && event.valueCents >= 0 ? Math.round(event.valueCents) : undefined,
      }))
    : [];
  normalizeAchievementState(state, Array.isArray(raw.achievements), Number.isFinite(raw.totalProductionValueCents));
  normalizeProductionHistory(state, raw.productionHistory);
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
    state.shipmentContracts = [];
    state.marketEvents = [];
    state.nextProcurementPlanIndex = 0;
    state.nextDemandOrderIndex = 0;
    state.nextContractIndex = 0;
    state.nextMarketEventIndex = 0;
    state.discoveryBounties = fallback.discoveryBounties.map((bounty) => ({
      ...bounty,
      paid: state.discoveredItems?.includes(bounty.itemId) ?? false,
    }));
  } else {
    state.procurementPlans = Array.isArray(state.procurementPlans) ? state.procurementPlans : [];
    state.demandOrders = Array.isArray(state.demandOrders) ? state.demandOrders : [];
    state.shipmentContracts = Array.isArray(state.shipmentContracts) ? state.shipmentContracts : [];
    state.discoveryBounties = Array.isArray(state.discoveryBounties) ? state.discoveryBounties : fallback.discoveryBounties;
    state.marketEvents = Array.isArray(state.marketEvents) ? state.marketEvents.slice(-64) : [];
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
  state.lockedWarehouseItemIds = [...new Set(Array.isArray(state.lockedWarehouseItemIds)
    ? state.lockedWarehouseItemIds.filter((itemId: unknown): itemId is string => typeof itemId === "string" && ITEMS.some((item) => item.id === itemId))
    : [])];
  if (needsBuildingMarketMigration) migrateBuildingMarket(state);
  else {
    state.buildingOffers = Array.isArray(state.buildingOffers) ? state.buildingOffers : [];
    state.playerBuildingInventory = state.playerBuildingInventory ?? {};
    state.playerWarehousePurchases = state.playerWarehousePurchases ?? {};
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
  if (needsReliableMarketMigration) migrateReliableMarket(state);
  repairBrokenMarketReferences(state);
  ensureMarketBroadcasts(state);
  const starter = createStarterScenario(state.worldSeed, state.difficulty).laws;
  const starterLaws = new Map(starter.map((law) => [law.id, law]));
  const migrateLaw = (law: any, replaceStarter = true): LawVersion | null => {
    // Integer-cent settlement is an engine invariant in schema 9, not a law.
    if (law?.id === "starter-law-cent-settlement") return null;
    const legacyEffects = Array.isArray(law?.program?.effects) ? law.program.effects : [];
    if (law?.id === "starter-law-sales-tax"
      || /\bsetTax\s*\(/u.test(String(law?.sourceCode ?? ""))
      || legacyEffects.some((effect: any) => effect?.kind === "tax")) return null;
    const replacement = replaceStarter ? starterLaws.get(law?.id) : undefined;
    if (replacement) {
      return {
        ...structuredClone(replacement),
        hitCount: law.hitCount ?? 0,
        invalidCount: law.invalidCount ?? 0,
        status: law.status ?? replacement.status,
      };
    }
    const rawSourceCode = typeof law?.sourceCode === "string" ? law.sourceCode : "function decide(ctx) { return null; }";
    const sourceCode = appendLegacyEffects(rawSourceCode, law?.program);
    const checked = validateLawSource(sourceCode);
    const program: LawProgram = normalizeProgram(law?.program, sourceCode);
    return {
      id: String(law?.id ?? `migrated-law-${state.simTime}`),
      title: String(law?.title ?? "迁移法规"),
      playerText: String(law?.playerText ?? ""),
      summary: String(law?.summary ?? ""),
      explanation: String(law?.explanation ?? law?.summary ?? ""),
      sourceCode,
      astHash: checked.hash,
      program,
      examples: Array.isArray(law?.examples) ? law.examples : [],
      warnings: Array.isArray(law?.warnings) ? law.warnings : [],
      speechTemplates: safeSpeechTemplates(law?.speechTemplates),
      enactedAt: Number.isFinite(law?.enactedAt) ? law.enactedAt : state.simTime,
      locked: Boolean(law?.locked),
      hitCount: Number.isFinite(law?.hitCount) ? law.hitCount : 0,
      invalidCount: Number.isFinite(law?.invalidCount) ? law.invalidCount : 0,
      consecutiveFaults: 0,
      status: checked.ok && (!law?.astHash || checked.hash === law.astHash)
        ? law?.status ?? "active"
        : "quarantined",
    };
  };
  const rawActiveLaws = Array.isArray(state.laws) ? state.laws : [];
  const starterStats = new Map(rawActiveLaws
    .filter((law: any) => starterLaws.has(law?.id))
    .map((law: any) => [law.id, law]));
  const playerLaws = rawActiveLaws
    .filter((law: any) => !String(law?.id ?? "").startsWith("starter-law-"))
    .map((law: any) => migrateLaw(law, false))
    .filter((law): law is LawVersion => Boolean(law));
  const normalizedStarterLaws = starter.map((fresh) => {
    const previous = starterStats.get(fresh.id);
    return {
      ...structuredClone(fresh),
      hitCount: Number.isFinite(previous?.hitCount) ? previous.hitCount : 0,
      invalidCount: Number.isFinite(previous?.invalidCount) ? previous.invalidCount : 0,
      status: needsStarterLawMigration ? "active" : previous?.status ?? fresh.status,
    } as LawVersion;
  });
  // Player-authored laws remain highest priority. Schema 11 and older replace
  // every obsolete starter-* fragment as one atomic upgrade, fixing saves that
  // previously received only the two locked economic laws.
  state.laws = [...playerLaws, ...normalizedStarterLaws];
  state.lawHistory = (Array.isArray(state.lawHistory) ? state.lawHistory : [])
    .map((law) => migrateLaw(law, false)).filter((law): law is LawVersion => Boolean(law));
  for (const required of starter) {
    if (!state.lawHistory.some((law) => law.id === required.id && law.astHash === required.astHash)) {
      state.lawHistory.push(structuredClone(required));
    }
  }
  for (const cat of state.cats) if (!cat.action) scheduleInternalWait(state, cat);
  compactGameStateHistory(state);
  return state;
}

function migrateReliableMarket(state: GameState): void {
  const cancelledOrderIds = new Set<string>();
  for (const order of state.demandOrders) {
    if (order.status !== "open") continue;
    if (order.buyerKind === "treasury") state.treasuryCoins += Math.max(0, order.reservedCents);
    order.status = "cancelled";
    order.closedAt = state.simTime;
    order.closeReason = "schema 14：旧市场报价未通过整包融资校验";
    order.committedSellerCatId = null;
    order.quotedSellerCents = undefined;
    order.quotedRouteCatIds = undefined;
    order.quotedFeesByCatId = undefined;
    order.quoteFinancingReserveCents = undefined;
    order.quoteRevision = undefined;
    cancelledOrderIds.add(order.id);
  }
  // In schema 13 the only live escrow was attached to open orders. Clear it
  // once, rather than trusting possibly inconsistent per-order legacy sums.
  for (const cat of state.cats) cat.escrowReservedCents = 0;
  for (const plan of state.procurementPlans) {
    if (plan.status !== "active") continue;
    plan.status = "cancelled";
    plan.phase = "quoting";
    plan.blockedReason = "schema 14：等待重新取得可靠报价";
    if (plan.reason === "bounty") {
      const bounty = state.discoveryBounties.find((entry) => entry.itemId === plan.outputItemId
        && !entry.paid && entry.claimedByCatId === plan.catId);
      if (bounty) bounty.claimedByCatId = null;
    }
  }
  state.marketBroadcasts = state.marketBroadcasts.filter((broadcast) => !cancelledOrderIds.has(broadcast.subjectId));
  for (const cat of state.cats) {
    if (cat.action?.type !== "pass") continue;
    const liveContract = cat.action.contractId
      ? state.shipmentContracts.find((contract) => contract.id === cat.action?.contractId && contract.status !== "delivered")
      : undefined;
    if (liveContract) continue;
    for (const [itemId, quantity] of Object.entries(cat.action.reserved ?? {})) {
      cat.inventory[itemId] = (cat.inventory[itemId] ?? 0) + quantity;
    }
    cat.action = null;
    cat.lastDecision = "schema 14：无有效合同的旧运输已取消并退回货物";
  }
}

function migrateBuildingMarket(state: GameState): void {
  state.playerBuildingInventory = {};
  state.playerWarehousePurchases = {};
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
