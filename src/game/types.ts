export type ItemId = string;
export type DifficultyLevel = 1 | 2 | 3 | 4 | 5;
export type Direction = "north" | "east" | "south" | "west";
export type LandmarkId = "founders_plaza" | "craft_academy" | "logistics_hub" | "market_center" | "energy_spire" | "quantum_beacon";

export interface Position {
  x: number;
  y: number;
}

export interface NeighborObservation {
  position: Position;
  inventory: Readonly<Record<ItemId, number>>;
}

export interface NearbyObservation extends NeighborObservation {
  distance: number;
  resourceItemId: ItemId | null;
  resourceItemIds?: ReadonlyArray<ItemId>;
  buildingItemId: ItemId | null;
}

export interface CatObservation {
  position: Position;
  inventory: Readonly<Record<ItemId, number>>;
  neighbors: Record<Direction, NeighborObservation | null>;
  nearby?: ReadonlyArray<NearbyObservation>;
  site?: { resourceItemId: ItemId | null; resourceItemIds?: ReadonlyArray<ItemId>; buildingItemId: ItemId | null };
  wallet?: {
    cashCents: number;
    debtCents: number;
    netWorthCents: number;
    creditAvailableCents: number;
  };
  heardOrders?: ReadonlyArray<{
    id: string;
    itemId: ItemId;
    effectiveBidCents: number;
    sourceCatId: string;
  }>;
  heardBounties?: ReadonlyArray<{
    itemId: ItemId;
    amountCents: number;
    sourceCatId: string;
  }>;
  heardBuildingOffers?: ReadonlyArray<{
    offerId: string;
    itemId: ItemId;
    askCents: number;
    sourceCatId: string;
  }>;
  broadcasts?: ReadonlyArray<MarketBroadcast>;
  carrying?: { contractId: string; itemId: ItemId; nextDirection: Direction } | null;
  ownPlan?: {
    outputItemId: ItemId;
    reason: "bounty" | "order" | "external-sale";
    expectedRevenueCents: number;
  } | null;
  discoveryBounties?: ReadonlyArray<{
    itemId: ItemId;
    amountCents: number;
    claimedBySelf: boolean;
  }>;
  landmarkEffects?: LandmarkEffects;
}

export type CatAction =
  | { type: "craft"; recipeId: string }
  | { type: "pass"; direction: Direction; itemId: ItemId }
  | { type: "sell"; itemId: ItemId }
  | null;

export interface LawExample {
  input: CatObservation;
  expected: CatAction;
}

export interface LawVersion {
  id: string;
  title: string;
  playerText: string;
  summary: string;
  sourceCode: string;
  astHash: string;
  examples: LawExample[];
  warnings: string[];
  enactedAt: number;
  category: "behavior" | "price" | "tax" | "system";
  locked?: boolean;
  taxRate: number | null;
  priceItemId: ItemId | "*" | null;
  priceMultiplier: number | null;
  hitCount: number;
  invalidCount: number;
  consecutiveFaults: number;
  status: "active" | "quarantined" | "repealed";
}

export interface ItemDefinition {
  id: ItemId;
  emoji: string;
  name: string;
  tier: number;
}

export interface Ingredient {
  itemId: ItemId;
  quantity: number;
}

export interface RecipeDefinition {
  id: string;
  output: ItemId;
  inputs: Ingredient[];
  siteRequirements: SiteRequirement[];
}

export interface SiteRequirement {
  buildingItemId: ItemId;
  maxManhattanDistance: number;
  minDifficulty?: DifficultyLevel;
}

export interface ActionCommand {
  type: "craft" | "pass" | "sell";
  recipeId?: string;
  itemId: ItemId;
  direction?: Direction;
  startedAt: number;
  endsAt: number;
  reserved: Record<ItemId, number>;
  lawId: string;
  contractId?: string;
  expectedGainCents?: number;
  /** External-sale gross locked when the action starts, after price law and landmark bonus. */
  saleGrossCents?: number;
  salePriceLawId?: string;
  /** Landmark speed reduction locked when the action starts. */
  speedReduction?: number;
}

export interface CatState {
  id: string;
  createdIndex: number;
  position: Position;
  inventory: Record<ItemId, number>;
  /** Schema 4: despite the legacy field name, all monetary values are integer cents. */
  coins: number;
  debtCents: number;
  escrowReservedCents: number;
  action: ActionCommand | null;
  lastDecision: string;
  decisionTrace: string[];
}

export interface ResourceNode {
  id: string;
  itemId: ItemId;
  position: Position;
}

export interface DeployedBuilding {
  id: string;
  itemId: ItemId;
  /** Legacy saves may still carry the former workstation owner until migration. */
  hostCatId?: string;
  position: Position;
  deployedAt: number;
}

export interface LandmarkDefinition {
  id: LandmarkId;
  emoji: string;
  name: string;
  radius: number;
  blueprintPriceCents: number;
  materials: Ingredient[];
  description: string;
  effects: Partial<Pick<LandmarkEffects,
    "actionSpeedReduction" | "craftSpeedReduction" | "passSpeedReduction" |
    "saleValueBonus" | "creditBonusCents" | "carrierFeeBonus" | "visionRadiusBonus">>;
}

export interface DeployedLandmark {
  id: string;
  landmarkId: LandmarkId;
  position: Position;
  deployedAt: number;
}

export interface LandmarkEffects {
  effectiveVisionRadius: number;
  actionSpeedReduction: number;
  craftSpeedReduction: number;
  passSpeedReduction: number;
  saleValueBonus: number;
  creditBonusCents: number;
  carrierFeeBonus: number;
  visionRadiusBonus: number;
  stacks: Record<LandmarkId, number>;
}

export type BuildingOfferStatus = "open" | "purchased" | "cancelled";

export interface BuildingOffer {
  id: string;
  sellerCatId: string;
  itemId: ItemId;
  askCents: number;
  createdAt: number;
  status: BuildingOfferStatus;
  closedAt: number | null;
  closeReason: string | null;
}

export interface BuildingOrder {
  id: string;
  itemId: ItemId;
  targetCatId: string;
  createdAt: number;
  demandOrderId?: string;
  budgetCents?: number;
  contractId?: string;
}

export type ProcurementPlanStatus = "active" | "completed" | "cancelled";

export interface ProcurementPlan {
  id: string;
  catId: string;
  outputItemId: ItemId;
  recipeId: string;
  terminalOrderId: string | null;
  expectedRevenueCents: number;
  createdAt: number;
  status: ProcurementPlanStatus;
  reason: "bounty" | "order" | "external-sale";
}

export type DemandOrderStatus = "open" | "contracted" | "cancelled";

export interface DemandOrder {
  id: string;
  buyerKind: "cat" | "treasury";
  buyerCatId: string | null;
  destinationCatId: string;
  itemId: ItemId;
  maxDeliveredCents: number;
  reservedCents: number;
  planId: string | null;
  createdAt: number;
  status: DemandOrderStatus;
  closedAt: number | null;
  closeReason: string | null;
}

export interface OrderSignal {
  orderId: string;
  catId: string;
  routeCatIds: string[];
  hops: number;
  estimatedFreightCents: number;
  effectiveBidCents: number;
  receivedAt: number;
}

export type MarketBroadcastKind =
  | "demand-open"
  | "demand-contracted"
  | "demand-cancelled"
  | "bounty-open"
  | "bounty-closed"
  | "building-offer-open"
  | "building-offer-closed";

export interface MarketBroadcast {
  id: string;
  kind: MarketBroadcastKind;
  subjectId: string;
  itemId: ItemId;
  sourceCatId: string;
  amountCents: number;
  publishedAt: number;
  reason: string | null;
}

export type ShipmentContractStatus = "awaiting-pickup" | "in-transit" | "delivered";

export interface ShipmentContract {
  id: string;
  orderId: string;
  itemId: ItemId;
  sellerCatId: string;
  buyerKind: "cat" | "treasury";
  buyerCatId: string | null;
  destinationCatId: string;
  routeCatIds: string[];
  currentLeg: number;
  custodianCatId: string;
  sellerPriceCents: number;
  feesByCatId: Record<string, number>;
  escrowCents: number;
  acceptedAt: number;
  deliveredAt: number | null;
  status: ShipmentContractStatus;
}

export interface DiscoveryBounty {
  itemId: ItemId;
  amountCents: number;
  claimedByCatId: string | null;
  paid: boolean;
}

export interface MarketLifecycleEvent {
  id: string;
  orderId: string;
  kind: "contracted" | "cancelled";
  createdAt: number;
  reason: string;
}

export interface LogisticsStatus {
  componentId: string;
  catIds: string[];
  kind: "building" | "tutorial" | "profit" | "idle";
  targetItemId: ItemId | null;
  blockedReason: string | null;
}

export interface ItemStats {
  crafted: number;
  passed: number;
  sold: number;
  revenue: number;
}

export interface FloatingEvent {
  id: string;
  catId: string;
  text: string;
  createdAt: number;
  duration: number;
  kind: "gain" | "sale" | "milestone";
}

export interface GameState {
  schemaVersion: 8;
  difficulty: DifficultyLevel;
  catalogVersion: string;
  worldSeed: number;
  simTime: number;
  paused: boolean;
  cats: CatState[];
  nextCatIndex: number;
  unlockedParcels: Position[];
  resourceNodes: ResourceNode[];
  buildings: DeployedBuilding[];
  landmarks: DeployedLandmark[];
  unlockedLandmarkIds: LandmarkId[];
  nextLandmarkIndex: number;
  buildingOffers: BuildingOffer[];
  /** Legacy field name retained for save compatibility; stores every item in the player's warehouse. */
  playerBuildingInventory: Record<ItemId, number>;
  /** Item kinds protected from bulk warehouse sales and buy-then-resell operations. */
  lockedWarehouseItemIds: ItemId[];
  nextBuildingOfferIndex: number;
  buildingOrders: BuildingOrder[];
  nextBuildingIndex: number;
  nextBuildingOrderIndex: number;
  logisticsStatus: LogisticsStatus[];
  procurementPlans: ProcurementPlan[];
  demandOrders: DemandOrder[];
  orderSignals: OrderSignal[];
  marketBroadcasts: MarketBroadcast[];
  shipmentContracts: ShipmentContract[];
  discoveryBounties: DiscoveryBounty[];
  marketEvents: MarketLifecycleEvent[];
  nextProcurementPlanIndex: number;
  nextDemandOrderIndex: number;
  nextMarketBroadcastIndex: number;
  nextContractIndex: number;
  nextMarketEventIndex: number;
  nextMarketTickAt: number;
  simulationSpeed: number;
  laws: LawVersion[];
  lawHistory: LawVersion[];
  enactmentCount: number;
  treasuryCoins: number;
  totalSales: number;
  discoveredItems: ItemId[];
  unlockedRecipes: string[];
  itemStats: Record<ItemId, ItemStats>;
  floatingEvents: FloatingEvent[];
  stargatesBuilt: number;
  milestoneAt: number | null;
  dirtyDecisions: boolean;
}

export interface LawDraft {
  title: string;
  playerText: string;
  summary: string;
  sourceCode: string;
  astHash: string;
  examples: LawExample[];
  warnings: string[];
  category: "behavior" | "price" | "tax";
  taxRate: number | null;
  priceItemId: ItemId | "*" | null;
  priceMultiplier: number | null;
  validation: {
    syntax: boolean;
    safety: boolean;
    examplesPassed: number;
    examplesTotal: number;
    messages: string[];
  };
}

export interface DecisionResult {
  action: CatAction;
  error?: string;
  steps: number;
}

declare global {
  interface Window {
    advanceTime: (ms: number) => void;
    render_game_to_text: () => string;
    __CAT_WORKSHOP__?: {
      reset: (difficulty?: DifficultyLevel) => Promise<void>;
      state: () => GameState;
      setSpeed: (multiplier: number) => void;
      removeCat: (catId: string) => { ok: boolean; error?: string; settledCents?: number; debtRepaidCents?: number; treasuryDeltaCents?: number };
      buyCatItem: (catId: string, itemId: ItemId) => { ok: boolean; error?: string; cost?: number; sellerCatId?: string };
      buyAllCatStock: () => { ok: boolean; error?: string; costCents?: number; quantity?: number };
      buyAllCatStockAndSell: () => { ok: boolean; error?: string; costCents?: number; revenueCents?: number; netCents?: number; quantity?: number };
      sellWarehouseItem: (itemId: ItemId, quantity?: number) => { ok: boolean; error?: string; revenueCents?: number; quantity?: number };
      sellAllUnlockedWarehouseItems: () => { ok: boolean; error?: string; revenueCents?: number; quantity?: number };
      toggleWarehouseItemLock: (itemId: ItemId) => { ok: boolean; error?: string; locked?: boolean };
    };
  }
}
