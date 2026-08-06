import { describe, expect, it } from "vitest";
import { advanceGame, createInitialState } from "./engine";
import { hashSource } from "./lawInterpreter";
import { migrateSaveSnapshot } from "./persistence";
import { BASE_RESOURCE_ITEM_IDS, parcelForPosition } from "./world";

describe("schema 10 unified-law and recent-production migration", () => {
  it("removes every active and historical tax law when schema 14 is loaded", () => {
    const raw: any = structuredClone(createInitialState({ worldSeed: 15 }));
    raw.schemaVersion = 14;
    const taxSource = "function decide(ctx) { setTax(0.8); return null; }";
    const mixedSource = "function decide(ctx) { setPrice('wood', 2); setTax(0.2); return null; }";
    const base = structuredClone(raw.laws[0]);
    raw.laws.unshift(
      { ...base, id: "player-tax", sourceCode: taxSource, astHash: hashSource(taxSource), locked: false },
      { ...base, id: "player-mixed-tax", sourceCode: mixedSource, astHash: hashSource(mixedSource), locked: false },
      { ...base, id: "starter-law-sales-tax", sourceCode: taxSource, astHash: hashSource(taxSource) },
    );
    raw.lawHistory = structuredClone(raw.laws);

    const migrated = migrateSaveSnapshot(raw);
    expect(migrated.schemaVersion).toBe(17);
    expect(migrated.laws.some((law) => law.id.includes("tax") || law.sourceCode.includes("setTax"))).toBe(false);
    expect(migrated.lawHistory.some((law) => law.id.includes("tax") || law.sourceCode.includes("setTax"))).toBe(false);
  });

  it("preserves stored production value and accepts legacy valueless events", () => {
    const raw: any = structuredClone(createInitialState({ worldSeed: 1 }));
    raw.simTime = 10_000;
    raw.recentProductionEvents = [
      { itemId: "wood", at: 9_000, catId: "cat-0", valueCents: 321 },
      { itemId: "stone", at: 9_500, catId: "cat-1" },
    ];
    const migrated = migrateSaveSnapshot(raw);
    expect(migrated.recentProductionEvents).toEqual([
      { itemId: "wood", at: 9_000, catId: "cat-0", valueCents: 321 },
      { itemId: "stone", at: 9_500, catId: "cat-1", valueCents: undefined },
    ]);
  });

  it("defaults legacy speech frequency to 70 and clamps saved values", () => {
    const legacy: any = structuredClone(createInitialState({ worldSeed: 1 }));
    delete legacy.speechFrequency;
    expect(migrateSaveSnapshot(legacy).speechFrequency).toBe(70);
    legacy.speechFrequency = 140;
    expect(migrateSaveSnapshot(legacy).speechFrequency).toBe(100);
    legacy.speechFrequency = -5;
    expect(migrateSaveSnapshot(legacy).speechFrequency).toBe(0);
  });

  it("atomically replaces incomplete schema 11 starter laws with the six-law no-tax baseline", () => {
    const raw: any = structuredClone(createInitialState({ worldSeed: 1 }));
    raw.schemaVersion = 11;
    const playerSource = "function decide(ctx) { setPrice('glass', 1.2); return null; }";
    const playerLaw = {
      ...structuredClone(raw.laws[0]),
      id: "player-glass-law",
      title: "玩家玻璃法",
      sourceCode: playerSource,
      astHash: hashSource(playerSource),
      locked: false,
    };
    const obsoleteSource = "function decide(ctx) { adjust('craft', 'wood', 1, 1); return null; }";
    const obsoleteLaw = {
      ...structuredClone(raw.laws[1]),
      id: "starter-law-resource-stock",
      title: "旧资源法",
      sourceCode: obsoleteSource,
      astHash: hashSource(obsoleteSource),
    };
    raw.laws = [
      raw.laws[0],
      obsoleteLaw,
      raw.laws.find((law: any) => law.id === "starter-law-private-credit"),
      raw.laws.find((law: any) => law.id === "starter-law-discovery-bounty"),
      playerLaw,
    ];
    raw.lawHistory = structuredClone(raw.laws);

    const migrated = migrateSaveSnapshot(raw);
    const expectedStarterIds = createInitialState({ worldSeed: 1 }).laws.map((law) => law.id);
    expect(migrated.schemaVersion).toBe(17);
    expect(migrated.laws.every((law) => law.speechTemplates?.length === 5)).toBe(true);
    expect(migrated.laws[0]).toMatchObject({ id: "player-glass-law", sourceCode: playerSource });
    expect(migrated.laws.filter((law) => law.id.startsWith("starter-law-")).map((law) => law.id)).toEqual(expectedStarterIds);
    expect(migrated.laws).toHaveLength(7);
    expect(migrated.laws.some((law) => law.id === "starter-law-resource-stock")).toBe(false);
    expect(migrated.lawHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "starter-law-resource-stock", sourceCode: obsoleteSource }),
      expect.objectContaining({ id: "starter-law-resource-supply" }),
      expect.objectContaining({ id: "player-glass-law", sourceCode: playerSource }),
    ]));
  });

  it("upgrades an existing schema 8 workshop to the free tenth recipe and resumes asset-greedy production", () => {
    const raw: any = structuredClone(createInitialState({ worldSeed: 1 }));
    raw.unlockedRecipes = raw.unlockedRecipes.filter((recipeId: string) => recipeId !== "make_thread");
    raw.discoveredItems = [];

    const migrated = migrateSaveSnapshot(raw);
    expect(migrated.unlockedRecipes).toContain("make_thread");

    advanceGame(migrated, 180_000);
    expect(migrated.discoveredItems).toContain("thread");
    expect(migrated.discoveredItems).not.toContain("paper");
  });

  it("preserves state while cancelling and refunding legacy cat sale actions", () => {
    const original = createInitialState({ worldSeed: 12 });
    original.cats[0].position = { x: 15, y: -5 };
    original.cats[0].inventory.gear = 3;
    (original.cats[0] as any).action = {
      type: "sell", itemId: "gear", startedAt: 100, endsAt: 5_100, reserved: { gear: 1 }, lawId: "coin-goal",
    };
    original.treasuryCoins = 321;
    original.unlockedRecipes.push("make_thread");
    const legacy: any = structuredClone(original);
    legacy.schemaVersion = 1;
    delete legacy.worldSeed;
    delete legacy.unlockedParcels;
    delete legacy.resourceNodes;
    delete legacy.buildings;
    delete legacy.buildingOrders;
    delete legacy.nextBuildingIndex;
    delete legacy.nextBuildingOrderIndex;
    delete legacy.logisticsStatus;

    const migrated = migrateSaveSnapshot(legacy, 999);
    expect(migrated.schemaVersion).toBe(17);
    expect(migrated.difficulty).toBe(2);
    expect(migrated.treasuryCoins).toBe(32_100);
    expect(migrated.cats).toHaveLength(original.cats.length);
    expect(migrated.cats[0].position).toEqual({ x: 15, y: -5 });
    expect(migrated.cats[0].inventory.gear).toBe(4);
    expect(migrated.cats[0].action?.type).toBe("wait");
    expect(migrated.unlockedRecipes).toContain("make_thread");
    expect(migrated.laws.map((law) => law.id)).toEqual(original.laws.map((law) => law.id));
    expect(migrated.unlockedParcels).toContainEqual(parcelForPosition({ x: 15, y: -5 }));
    expect(BASE_RESOURCE_ITEM_IDS.every((itemId) => migrated.resourceNodes.some((node) => node.itemId === itemId))).toBe(true);
    expect(migrated.resourceNodes.every((node) => !migrated.cats.some((cat) => node.position.x === cat.position.x
      && node.position.y === cat.position.y))).toBe(true);
    expect(migrated.buildings).toEqual([]);
    expect(migrated.buildingOrders).toEqual([]);
  });

  it("derives a stable seed from the same legacy snapshot", () => {
    const legacy: any = structuredClone(createInitialState({ worldSeed: 22 }));
    legacy.schemaVersion = 1;
    delete legacy.worldSeed;
    expect(migrateSaveSnapshot(legacy, 1).worldSeed).toBe(migrateSaveSnapshot(legacy, 2).worldSeed);
  });

  it("upgrades schema 2 resource-under-cat saves into non-occupied resource regions", () => {
    const schema2: any = structuredClone(createInitialState({ worldSeed: 77 }));
    schema2.schemaVersion = 2;
    schema2.resourceNodes = schema2.cats.slice(0, 6).map((cat: any, index: number) => ({
      id: `old-${index}`,
      itemId: BASE_RESOURCE_ITEM_IDS[index],
      position: { ...cat.position },
    }));
    const migrated = migrateSaveSnapshot(schema2);
    expect(migrated.schemaVersion).toBe(17);
    expect(migrated.cats.map((cat) => cat.position)).toEqual(schema2.cats.map((cat: any) => cat.position));
    expect(migrated.resourceNodes.every((node) => !migrated.cats.some((cat) => node.position.x === cat.position.x
      && node.position.y === cat.position.y))).toBe(true);
  });

  it("cancels legacy free transfers, returns reservations, and installs locked economy laws", () => {
    const schema3: any = structuredClone(createInitialState({ worldSeed: 88 }));
    schema3.schemaVersion = 3;
    schema3.laws = schema3.laws.filter((law: any) => !law.locked);
    schema3.cats[0].action = {
      type: "pass", itemId: "wood", direction: "east", startedAt: 0, endsAt: 5_000,
      reserved: { wood: 1 }, lawId: "legacy-free-pass",
    };
    const migrated = migrateSaveSnapshot(schema3);
    expect(migrated.cats[0].action?.type).toBe("wait");
    expect(migrated.cats[0].inventory.wood).toBe(1);
    expect(migrated.laws.filter((law) => law.locked).map((law) => law.title)).toEqual([
      "猫咪信用法", "全品类首次发现悬赏法",
    ]);
    expect(migrated.laws.filter((law) => law.locked).every((law) => law.status === "active")).toBe(true);
  });

  it("rebuilds missing global broadcasts from a schema 5 ledger and never persists test speed", () => {
    const raw: any = structuredClone(createInitialState({ worldSeed: 99, simulationSpeed: 5_000 }));
    raw.demandOrders.push({
      id: "order-legacy-broadcast",
      buyerKind: "cat",
      buyerCatId: "cat-0",
      destinationCatId: "cat-0",
      itemId: "wood",
      maxDeliveredCents: 200,
      reservedCents: 200,
      planId: null,
      createdAt: 0,
      status: "open",
      closedAt: null,
      closeReason: null,
    });
    raw.orderSignals = [{
      orderId: "order-legacy-broadcast",
      catId: "*",
      routeCatIds: ["cat-0"],
      hops: 0,
      estimatedFreightCents: 0,
      effectiveBidCents: 200,
      receivedAt: 0,
    }];
    delete raw.marketBroadcasts;
    delete raw.nextMarketBroadcastIndex;

    const migrated = migrateSaveSnapshot(raw);
    expect(migrated.simulationSpeed).toBe(1);
    expect(migrated.marketBroadcasts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "demand-open", subjectId: "order-legacy-broadcast", sourceCatId: "cat-0" }),
      expect.objectContaining({ kind: "bounty-open", sourceCatId: "cat-0" }),
    ]));
  });

  it("migrates schema 16 landmarks to stable unique names and resource edit counters", () => {
    const raw: any = structuredClone(createInitialState({ worldSeed: 101 }));
    raw.schemaVersion = 16;
    raw.landmarks = [
      { id: "landmark-8", landmarkId: "founders_plaza", position: { x: 3, y: 3 }, deployedAt: 1 },
      { id: "landmark-9", landmarkId: "founders_plaza", name: "创业广场", position: { x: 4, y: 3 }, deployedAt: 2 },
    ];
    delete raw.nextPlayerResourceIndex;
    raw.resourceNodes.push({ id: "resource-player-12", itemId: "wood", position: { x: 4, y: 4 } });

    const migrated = migrateSaveSnapshot(raw);
    expect(migrated.schemaVersion).toBe(17);
    expect(migrated.landmarks.map((landmark) => landmark.name)).toEqual(["创业广场", "创业广场 2"]);
    expect(migrated.nextPlayerResourceIndex).toBe(13);
  });
});
