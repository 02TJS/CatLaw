import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import { migrateSaveSnapshot } from "./persistence";
import { BASE_RESOURCE_ITEM_IDS, parcelForPosition } from "./world";

describe("schema 5 building-market migration", () => {
  it("preserves cats, money, inventory, laws, recipes, and active actions", () => {
    const original = createInitialState({ worldSeed: 12 });
    original.cats[0].position = { x: 15, y: -5 };
    original.cats[0].inventory.gear = 3;
    original.cats[0].action = {
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
    expect(migrated.schemaVersion).toBe(7);
    expect(migrated.difficulty).toBe(2);
    expect(migrated.treasuryCoins).toBe(32_100);
    expect(migrated.cats).toHaveLength(original.cats.length);
    expect(migrated.cats[0].position).toEqual({ x: 15, y: -5 });
    expect(migrated.cats[0].inventory.gear).toBe(3);
    expect(migrated.cats[0].action).toEqual(original.cats[0].action);
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
    expect(migrated.schemaVersion).toBe(7);
    expect(migrated.cats.map((cat) => cat.position)).toEqual(schema2.cats.map((cat: any) => cat.position));
    expect(migrated.resourceNodes.every((node) => !migrated.cats.some((cat) => node.position.x === cat.position.x
      && node.position.y === cat.position.y))).toBe(true);
  });

  it("cancels legacy free transfers, returns reservations, and installs locked economy laws", () => {
    const schema3: any = structuredClone(createInitialState({ worldSeed: 88 }));
    schema3.schemaVersion = 3;
    schema3.laws = schema3.laws.filter((law: any) => law.category !== "system");
    schema3.cats[0].action = {
      type: "pass", itemId: "wood", direction: "east", startedAt: 0, endsAt: 5_000,
      reserved: { wood: 1 }, lawId: "legacy-free-pass",
    };
    const migrated = migrateSaveSnapshot(schema3);
    expect(migrated.cats[0].action).toBeNull();
    expect(migrated.cats[0].inventory.wood).toBe(1);
    expect(migrated.laws.filter((law) => law.category === "system").map((law) => law.title)).toEqual([
      "分币结算法", "猫咪信用法", "全品类首次发现悬赏法",
    ]);
    expect(migrated.laws.filter((law) => law.category === "system").every((law) => law.locked)).toBe(true);
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
    raw.orderSignals.push({
      orderId: "order-legacy-broadcast",
      catId: "*",
      routeCatIds: ["cat-0"],
      hops: 0,
      estimatedFreightCents: 0,
      effectiveBidCents: 200,
      receivedAt: 0,
    });
    delete raw.marketBroadcasts;
    delete raw.nextMarketBroadcastIndex;

    const migrated = migrateSaveSnapshot(raw);
    expect(migrated.simulationSpeed).toBe(1);
    expect(migrated.marketBroadcasts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "demand-open", subjectId: "order-legacy-broadcast", sourceCatId: "cat-0" }),
      expect.objectContaining({ kind: "bounty-open", sourceCatId: "cat-0" }),
    ]));
  });
});
