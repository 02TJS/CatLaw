import type { GameState } from "./types";

/**
 * GameState deliberately remains flat for save compatibility. These disjoint
 * key sets make ownership and retention rules explicit without changing a
 * property name, nesting level, or serialized value.
 */
export const GAME_STATE_LIFECYCLE_KEYS = {
  persistent: [
    "schemaVersion", "difficulty", "catalogVersion", "worldSeed", "simTime",
    "cats", "nextCatIndex", "unlockedParcels", "resourceNodes", "nextPlayerResourceIndex",
    "buildings", "landmarks", "unlockedLandmarkIds", "nextLandmarkIndex",
    "buildingOffers", "playerBuildingInventory", "playerWarehousePurchases",
    "lockedWarehouseItemIds", "nextBuildingOfferIndex", "buildingOrders",
    "nextBuildingIndex", "nextBuildingOrderIndex", "procurementPlans", "demandOrders",
    "marketBroadcasts", "shipmentContracts", "discoveryBounties",
    "nextProcurementPlanIndex", "nextDemandOrderIndex", "nextMarketBroadcastIndex",
    "nextContractIndex", "nextMarketEventIndex", "laws", "enactmentCount",
    "treasuryCoins", "discoveredItems", "unlockedRecipes", "stargatesBuilt",
    "milestoneAt", "lawbookRevision",
  ],
  runtime: ["logisticsStatus", "recentProductionEvents", "dirtyDecisions"],
  history: [
    "marketEvents", "lawHistory", "totalSales", "itemStats", "totalProductionValueCents",
    "achievements", "productionHistory", "wealthHistory",
  ],
  audit: ["commandAudit"],
  ui: ["paused", "speechFrequency", "simulationSpeed", "floatingEvents"],
} as const satisfies Record<string, readonly (keyof GameState)[]>;

export type GameStateLifecycle = keyof typeof GAME_STATE_LIFECYCLE_KEYS;
type LifecycleKey<T extends GameStateLifecycle> = typeof GAME_STATE_LIFECYCLE_KEYS[T][number];

export type PersistentGameState = Pick<GameState, LifecycleKey<"persistent">>;
export type RuntimeGameState = Pick<GameState, LifecycleKey<"runtime">>;
export type HistoryGameState = Pick<GameState, LifecycleKey<"history">>;
export type AuditGameState = Pick<GameState, LifecycleKey<"audit">>;
export type UiGameState = Pick<GameState, LifecycleKey<"ui">>;

/**
 * Clone the flat state at the persistence boundary and clear the same
 * process-local/UI data that serialization has always excluded.
 */
export function cloneGameStateForPersistence(state: GameState): GameState {
  const snapshot = structuredClone(state) as GameState & {
    cats: Array<GameState["cats"][number] & { lawPolicy?: unknown }>;
  };
  snapshot.cats = snapshot.cats.map((cat) => {
    const persistedCat = { ...cat } as typeof cat & { lawPolicy?: unknown };
    delete persistedCat.lawPolicy;
    return persistedCat;
  });
  snapshot.floatingEvents = [];
  return snapshot;
}
