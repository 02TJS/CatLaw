import type { SaveSchemaVersion } from "./saveSchema.js";
import type { Cents, InternalSimulationRate } from "./domainUnits.js";

export type { Cents, InternalSimulationRate, RuntimeSpeedMultiplier } from "./domainUnits.js";

export type ItemId = string;
export type PlayerWarehouseInventory = Record<ItemId, number>;
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

export interface NamedLandmarkObservation {
  id: string;
  name: string;
  position: Position;
  distance: number;
  kind: "marker" | "engineered";
  landmarkId: LandmarkId | null;
}

export interface CatObservation {
  position: Position;
  inventory: Readonly<Record<ItemId, number>>;
  neighbors: Record<Direction, NeighborObservation | null>;
  nearby?: ReadonlyArray<NearbyObservation>;
  site?: { resourceItemId: ItemId | null; resourceItemIds?: ReadonlyArray<ItemId>; buildingItemId: ItemId | null };
  wallet?: {
    cashCents: Cents;
    debtCents: Cents;
    netWorthCents: Cents;
    creditAvailableCents: Cents;
  };
  heardOrders?: ReadonlyArray<{
    id: string;
    itemId: ItemId;
    effectiveBidCents: Cents;
    sourceCatId: string;
    /** Number of open orders represented by this per-item market summary. */
    count?: number;
  }>;
  heardBounties?: ReadonlyArray<{
    itemId: ItemId;
    amountCents: Cents;
    sourceCatId: string;
  }>;
  heardBuildingOffers?: ReadonlyArray<{
    offerId: string;
    itemId: ItemId;
    askCents: Cents;
    sourceCatId: string;
  }>;
  broadcasts?: ReadonlyArray<MarketBroadcast>;
  carrying?: { contractId: string; itemId: ItemId; nextDirection: Direction } | null;
  ownPlan?: {
    outputItemId: ItemId;
    reason: "bounty" | "order" | "external-sale";
    expectedRevenueCents: Cents;
  } | null;
  discoveryBounties?: ReadonlyArray<{
    itemId: ItemId;
    amountCents: number;
    claimedBySelf: boolean;
  }>;
  /** Named player landmarks, nearest first. Names are unique world references. */
  landmarks?: ReadonlyArray<NamedLandmarkObservation>;
  landmarkEffects?: LandmarkEffects;
}

export type CatAction =
  | { type: "craft"; recipeId: string }
  | { type: "pass"; direction: Direction; itemId: ItemId }
  | null;

export interface LawExample {
  input: CatObservation;
  expected: CatAction;
}

/** Source code is the only executable law representation. */
export interface LawProgram {
  version: 2;
}

export type LawSpeechTemplates = [string, string, string, string, string];

export interface LawRuntimePolicy {
  priceMultipliers: Record<ItemId | "*", number>;
  /** Temporary flat price adjustments, in cents, evaluated for one cat snapshot. */
  priceAdditionsCents: Record<ItemId | "*", Cents>;
  creditBaseCents: Cents;
  creditNetWorthFactor: number;
  bountyMultiplier: number;
  /** False means no active law has supplied a bounty override. */
  bountyMultiplierSet?: boolean;
}

export interface LawVersion {
  id: string;
  title: string;
  playerText: string;
  summary: string;
  /** Full plain-language explanation generated from the validated immutable source. */
  explanation?: string;
  sourceCode: string;
  astHash: string;
  examples: LawExample[];
  warnings: string[];
  speechTemplates?: LawSpeechTemplates;
  enactedAt: number;
  program: LawProgram;
  locked?: boolean;
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
  type: "craft" | "pass" | "wait";
  recipeId?: string;
  itemId: ItemId;
  direction?: Direction;
  startedAt: number;
  endsAt: number;
  reserved: Record<ItemId, number>;
  lawId: string;
  contractId?: string;
  expectedGainCents?: Cents;
  /** Value captured when this action started; law overlays never rewrite it. */
  outputValueCents?: Cents;
  /** Human-readable explanation captured from the winning local candidate. */
  decisionReason?: string;
  /** Landmark speed reduction locked when the action starts. */
  speedReduction?: number;
}

export interface CatState {
  id: string;
  createdIndex: number;
  position: Position;
  inventory: Record<ItemId, number>;
  /** Schema 4: despite the legacy field name, all monetary values are integer cents. */
  coins: Cents;
  debtCents: Cents;
  escrowReservedCents: Cents;
  action: ActionCommand | null;
  lastDecision: string;
  decisionTrace: string[];
  /** Increments once for every valid non-wait action, including silent decisions. */
  decisionSerial?: number;
  /** Simulation/UI time of the last emitted speech bubble. */
  lastSpeechAt?: number | null;
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
  blueprintPriceCents: Cents;
  materials: Ingredient[];
  description: string;
  effects: Partial<Pick<LandmarkEffects,
    "actionSpeedReduction" | "craftSpeedReduction" | "passSpeedReduction" |
    "saleValueBonus" | "creditBonusCents" | "carrierFeeBonus" | "visionRadiusBonus">>;
}

export interface DeployedLandmark {
  id: string;
  /** null identifies a one-wood named map marker with no automatic bonus. */
  landmarkId: LandmarkId | null;
  /** Unique player-facing name used by law helpers such as nearLandmark(). */
  name?: string;
  position: Position;
  deployedAt: number;
}

export interface LandmarkEffects {
  effectiveVisionRadius: number;
  actionSpeedReduction: number;
  craftSpeedReduction: number;
  passSpeedReduction: number;
  saleValueBonus: number;
  creditBonusCents: Cents;
  carrierFeeBonus: number;
  visionRadiusBonus: number;
  stacks: Record<LandmarkId, number>;
}

export type BuildingOfferStatus = "open" | "purchased" | "cancelled";

export interface BuildingOffer {
  id: string;
  sellerCatId: string;
  itemId: ItemId;
  askCents: Cents;
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
  budgetCents?: Cents;
  contractId?: string;
}

export type ProcurementPlanStatus = "active" | "completed" | "cancelled";

export interface ProcurementPlan {
  id: string;
  catId: string;
  outputItemId: ItemId;
  recipeId: string;
  terminalOrderId: string | null;
  expectedRevenueCents: Cents;
  /** Discovery reward locked when this plan claimed the bounty. */
  bountyCents?: Cents;
  createdAt: number;
  /** The one shared behavior law that authorized creation of this plan. */
  createdByBehaviorLawId?: string;
  status: ProcurementPlanStatus;
  reason: "bounty" | "order" | "external-sale";
  /** Market funding state. A plan may act only after its complete input bundle is funded. */
  phase?: "quoting" | "funded" | "procuring" | "ready";
  terminalRevenueCents?: Cents;
  alternativeGainCents?: Cents;
  bundleCostCents?: Cents;
  financingReserveCents?: Cents;
  expectedProfitCents?: Cents;
  budgetSlackCents?: Cents;
  bundleOrderIds?: string[];
  blockedReason?: string | null;
  quoteRevision?: number;
}

export type DemandOrderStatus = "open" | "contracted" | "cancelled";

export interface DemandOrder {
  id: string;
  buyerKind: "cat" | "treasury";
  buyerCatId: string | null;
  destinationCatId: string;
  itemId: ItemId;
  maxDeliveredCents: Cents;
  reservedCents: Cents;
  planId: string | null;
  createdAt: number;
  status: DemandOrderStatus;
  closedAt: number | null;
  closeReason: string | null;
  /** A firm quote names its supplier and locks the route and settlement amounts. */
  committedSellerCatId?: string | null;
  quotedSellerCents?: Cents;
  quotedRouteCatIds?: string[];
  quotedFeesByCatId?: Record<string, Cents>;
  /** Worst-case loan fee reserved together with this order's delivered quote. */
  quoteFinancingReserveCents?: Cents;
  quoteRevision?: number;
}

export interface OrderSignal {
  orderId: string;
  catId: string;
  routeCatIds: string[];
  hops: number;
  estimatedFreightCents: Cents;
  effectiveBidCents: Cents;
  receivedAt: number;
}

export type MarketBroadcastKind =
  | "demand-open"
  | "demand-contracted"
  | "demand-cancelled"
  | "bounty-open"
  | "bounty-closed"
  | "building-offer-open"
  | "building-offer-closed"
  | "production-event"
  | "production-total"
  | "warehouse-stock";

export interface MarketBroadcast {
  id: string;
  kind: MarketBroadcastKind;
  subjectId: string;
  itemId: ItemId;
  sourceCatId: string;
  amountCents: Cents;
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
  sellerPriceCents: Cents;
  feesByCatId: Record<string, Cents>;
  escrowCents: Cents;
  acceptedAt: number;
  deliveredAt: number | null;
  status: ShipmentContractStatus;
}

export interface DiscoveryBounty {
  itemId: ItemId;
  amountCents: Cents;
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
  kind: "building" | "bounty" | "profit" | "idle";
  targetItemId: ItemId | null;
  blockedReason: string | null;
}

export interface ItemStats {
  crafted: number;
  passed: number;
  sold: number;
  /** Legacy key; value has used integer cents since schema 4. */
  revenue: Cents;
}

export type AchievementKind = "first-craft" | "production-rate" | "total-production";

export interface AchievementEvent {
  id: string;
  kind: AchievementKind;
  itemId: ItemId | null;
  thresholdCents: Cents | null;
  unlockedAt: number;
  acknowledgedAt: number | null;
}

export interface ProductionHistoryCounter {
  plannedCount: number;
  craftedCount: number;
  firstPlannedAt: number | null;
  lastPlannedAt: number | null;
  firstCraftedAt: number | null;
  lastCraftedAt: number | null;
}

export interface ProductionHistoryFlow {
  id: string;
  /** The finished good selected in the production-stability lens. */
  outputItemId: ItemId;
  /** Input flows point supplier -> producer; output flows point producer -> destination. */
  kind: "input" | "output";
  /** Input commodity, or the finished commodity for an output flow. */
  itemId: ItemId;
  sourceCatId: string;
  targetCatId: string;
  count: number;
  firstAt: number;
  lastAt: number;
}

export interface ProductionHistory {
  byCat: Record<string, Partial<Record<ItemId, ProductionHistoryCounter>>>;
  flows: ProductionHistoryFlow[];
}

export interface WealthHistorySample {
  /** Deterministic simulation timestamp; no wall-clock or offline time. */
  at: number;
  /** Wealth-plus-available-credit score captured for every cat alive at `at`. */
  values: Record<string, Cents>;
}

export interface FloatingEvent {
  id: string;
  catId: string;
  text: string;
  createdAt: number;
  duration: number;
  kind: "gain" | "sale" | "milestone" | "speech";
  lawId?: string;
  reason?: string;
  itemId?: ItemId;
  gainCents?: Cents;
  direction?: Direction;
  destinationCatId?: string;
  scheduledDelayMs?: number;
}

export interface GameState {
  schemaVersion: SaveSchemaVersion;
  difficulty: DifficultyLevel;
  catalogVersion: string;
  worldSeed: number;
  simTime: number;
  paused: boolean;
  /** Percentage of valid craft/pass starts that may schedule a decision bubble. */
  speechFrequency: number;
  cats: CatState[];
  nextCatIndex: number;
  unlockedParcels: Position[];
  resourceNodes: ResourceNode[];
  nextPlayerResourceIndex: number;
  buildings: DeployedBuilding[];
  landmarks: DeployedLandmark[];
  unlockedLandmarkIds: LandmarkId[];
  nextLandmarkIndex: number;
  buildingOffers: BuildingOffer[];
  /** Legacy field name retained for save compatibility; stores every item in the player's warehouse. */
  playerBuildingInventory: PlayerWarehouseInventory;
  /** Purchased warehouse stock, kept separate from cat-made/delivered stock for provenance audits. */
  playerWarehousePurchases: Record<ItemId, number>;
  /** Item kinds protected from bulk warehouse sales and buy-then-resell operations. */
  lockedWarehouseItemIds: ItemId[];
  nextBuildingOfferIndex: number;
  buildingOrders: BuildingOrder[];
  nextBuildingIndex: number;
  nextBuildingOrderIndex: number;
  logisticsStatus: LogisticsStatus[];
  procurementPlans: ProcurementPlan[];
  demandOrders: DemandOrder[];
  marketBroadcasts: MarketBroadcast[];
  shipmentContracts: ShipmentContract[];
  discoveryBounties: DiscoveryBounty[];
  marketEvents: MarketLifecycleEvent[];
  nextProcurementPlanIndex: number;
  nextDemandOrderIndex: number;
  nextMarketBroadcastIndex: number;
  nextContractIndex: number;
  nextMarketEventIndex: number;
  /** Legacy save key for the engine-only test rate; unrelated to runtime playback speed. */
  simulationSpeed: InternalSimulationRate;
  laws: LawVersion[];
  lawHistory: LawVersion[];
  enactmentCount: number;
  treasuryCoins: Cents;
  totalSales: Cents;
  discoveredItems: ItemId[];
  unlockedRecipes: string[];
  itemStats: Record<ItemId, ItemStats>;
  /** Gross value captured at craft completion; later price laws never rewrite history. */
  totalProductionValueCents: Cents;
  /** Persistent, deterministic achievement queue. */
  achievements: AchievementEvent[];
  /** Compact lifetime production-plan graph used by the persistent stability lens. */
  productionHistory: ProductionHistory;
  /** Five-second snapshots retained for adjustable recent-wealth map lenses. */
  wealthHistory: WealthHistorySample[];
  /** Craft completions retained for the public rolling 60-second law input. */
  recentProductionEvents: Array<{ itemId: ItemId; at: number; catId: string; valueCents?: Cents }>;
  floatingEvents: FloatingEvent[];
  stargatesBuilt: number;
  milestoneAt: number | null;
  dirtyDecisions: boolean;
  /** Monotonic lawbook revision. It invalidates quotes but never wakes cats. */
  lawbookRevision: number;
  /** Bounded audit used by black-box acceptance; game logic never reads it. */
  commandAudit: CommandAuditEntry[];
}

export type PlayerCommandKind =
  | "buy-recipe" | "buy-cat-stock" | "buy-building" | "place-building"
  | "sell-warehouse" | "compile-law" | "enact-law" | "reorder-law" | "repeal-law"
  | "advance-time" | "place-cat" | "remove-cat" | "expand-parcel"
  | "queue-building" | "cancel-building" | "dismantle-building"
  | "toggle-warehouse-lock" | "buy-landmark-blueprint" | "place-landmark" | "rename-landmark" | "dismantle-landmark"
  | "create-resource" | "remove-resource"
  | "set-paused" | "set-speech-frequency" | "ack-achievement" | "forbidden-debug";

export interface CommandAuditEntry {
  sequence: number;
  atMs: number;
  origin: "player-ui" | "simulation";
  kind: PlayerCommandKind | "action-start" | "action-complete";
  target: string;
  ok: boolean;
  detail?: string;
}

export interface LawDraft {
  title: string;
  playerText: string;
  summary: string;
  /** Full plain-language explanation generated in a dedicated model call. */
  explanation?: string;
  sourceCode: string;
  astHash: string;
  examples: LawExample[];
  warnings: string[];
  speechTemplates?: LawSpeechTemplates;
  program: LawProgram;
  compileAudit?: {
    requestId: string;
    model: string;
    attempts: number;
    callCount?: number;
    startedAt: string;
    durationMs: number;
    promptSha256: string;
    responseSha256: string;
    usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    sharedBehaviorHash: string;
    calls?: Array<{
      stage: "program" | "speech" | "explanation";
      startedAt: string;
      durationMs: number;
      promptSha256: string;
      responseSha256: string;
      usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    }>;
  };
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
