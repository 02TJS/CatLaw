import { describe, expect, it } from "vitest";
import { DEPLOYABLE_BUILDING_IDS, ITEMS, RECIPE_BY_OUTPUT } from "./catalog";
import {
  advanceGame,
  buildingPlacementFailure,
  createInitialState,
  decideIdleCats,
  dismantleBuilding,
  itemPrice,
  placeOwnedBuilding,
  queueBuildingOrder,
  recipeSiteFailure,
} from "./engine";
import { acceptProfitableOrders, openDemandOrder, propagateOrderSignals } from "./market";
import type { CatState } from "./types";
import { resourceHarvestTiles } from "./world";

function testCat(id: number, x: number, y: number): CatState {
  return { id: `cat-${id}`, createdIndex: id, position: { x, y }, inventory: {}, coins: 0, debtCents: 0, escrowReservedCents: 0, action: null, lastDecision: "", decisionTrace: [] };
}

describe("spatial logistics and buildings", () => {
  it("uses a paid single-item order to move wood through a two-hop cat chain", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 1 });
    state.cats = [testCat(0, 0, 0), testCat(1, 1, 0), testCat(2, 2, 0)];
    state.nextCatIndex = 3;
    state.resourceNodes = [];
    state.discoveredItems = ITEMS.slice(0, 15).map((item) => item.id);
    state.discoveryBounties.forEach((bounty) => { bounty.paid = true; });
    const allLaws = createInitialState({ worldSeed: 1 }).laws.map((law) => structuredClone(law));
    state.laws = allLaws.filter((law) => law.locked);
    decideIdleCats(state);
    state.cats.forEach((entry) => { entry.action = null; });
    state.laws = allLaws;
    state.cats[0].inventory.wood = 1;
    const order = openDemandOrder(state, {
      buyerKind: "cat", buyerCatId: "cat-2", destinationCatId: "cat-2", itemId: "wood",
      maxDeliveredCents: 300, reservedCents: 300, planId: null,
    }, (itemId) => itemPrice(state, itemId))!;
    propagateOrderSignals(state);
    propagateOrderSignals(state);
    acceptProfitableOrders(state, (itemId) => itemPrice(state, itemId));
    expect(order.status).toBe("contracted");
    state.cats[0].decisionSerial = 2;
    state.floatingEvents = [];
    decideIdleCats(state);
    expect(state.cats[0].action).toMatchObject({ type: "pass", itemId: "wood", direction: "east" });
    const speech = state.floatingEvents.find((event) => event.kind === "speech" && event.catId === "cat-0");
    expect(speech?.text).toContain("把🪵木材运到东边的2号猫");
    expect(speech?.text).toContain("2.01金币");
    expect(speech?.text).toContain("履行有偿运输合同");
    expect(speech?.text).toContain("喵");
    advanceGame(state, 5_000);
    expect(state.itemStats.wood.passed).toBe(1);
    expect(state.cats[1].action).toMatchObject({ type: "pass", itemId: "wood", direction: "east" });
    advanceGame(state, 5_000);
    expect(state.itemStats.wood.passed).toBe(2);
    expect(state.shipmentContracts[0].status).toBe("delivered");
    expect((state.cats[2].inventory.wood ?? 0) + (state.cats[2].action?.reserved.wood ?? 0)).toBe(1);
  });

  it("allows base crafting only on the matching resource node", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 2 });
    const cat = state.cats[0];
    state.resourceNodes = [{ id: "stone", itemId: "stone", position: { x: cat.position.x, y: cat.position.y - 1 } }];
    expect(recipeSiteFailure(state, cat, RECIPE_BY_OUTPUT.get("wood")!)).toContain("木材");
    expect(recipeSiteFailure(state, cat, RECIPE_BY_OUTPUT.get("stone")!)).toBeNull();
  });

  it("allows collection from all eight surrounding cells but not the resource center", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 2 });
    state.resourceNodes = [{ id: "stone", itemId: "stone", position: { x: 0, y: 0 } }];
    for (let y = -1; y <= 1; y += 1) {
      for (let x = -1; x <= 1; x += 1) {
        const worker = testCat(100 + (y + 1) * 3 + x + 1, x, y);
        if (x === 0 && y === 0) expect(recipeSiteFailure(state, worker, RECIPE_BY_OUTPUT.get("stone")!)).toContain("石料");
        else expect(recipeSiteFailure(state, worker, RECIPE_BY_OUTPUT.get("stone")!)).toBeNull();
      }
    }
  });

  it("enforces inclusive Manhattan building ranges", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 3 });
    const factoryRecipe = RECIPE_BY_OUTPUT.get("chip")!;
    const labRecipe = RECIPE_BY_OUTPUT.get("atom_core")!;
    const reactorRecipe = RECIPE_BY_OUTPUT.get("rocket")!;
    state.buildings = [
      { id: "f", itemId: "factory", hostCatId: "cat-0", position: { x: 0, y: 0 }, deployedAt: 0 },
      { id: "l", itemId: "lab", hostCatId: "cat-0", position: { x: 10, y: 10 }, deployedAt: 0 },
      { id: "r", itemId: "reactor", hostCatId: "cat-0", position: { x: -10, y: -10 }, deployedAt: 0 },
    ];
    expect(recipeSiteFailure(state, testCat(10, 2, 0), factoryRecipe)).toBeNull();
    expect(recipeSiteFailure(state, testCat(11, 3, 0), factoryRecipe)).toContain("工厂2格内");
    expect(recipeSiteFailure(state, testCat(12, 11, 11), labRecipe)).toBeNull();
    expect(recipeSiteFailure(state, testCat(13, 12, 11), labRecipe)).toContain("实验室2格内");
    expect(recipeSiteFailure(state, testCat(14, -7, -10), reactorRecipe)).toBeNull();
    expect(recipeSiteFailure(state, testCat(15, -6, -10), reactorRecipe)).toContain("反应堆3格内");
  });

  it("combines resource collection with every overlapping building requirement", () => {
    const state = createInitialState({ withStarter: false, difficulty: 3, worldSeed: 31 });
    state.resourceNodes = [{ id: "wood", itemId: "wood", position: { x: 0, y: 0 } }];
    state.buildings = [
      { id: "factory", itemId: "factory", position: { x: 1, y: 0 }, deployedAt: 0 },
      { id: "machine", itemId: "machine_tool", position: { x: 0, y: 1 }, deployedAt: 0 },
    ];
    const overlapWorker = testCat(16, 1, 1);
    expect(recipeSiteFailure(state, overlapWorker, RECIPE_BY_OUTPUT.get("wood")!)).toBeNull();
    expect(recipeSiteFailure(state, overlapWorker, RECIPE_BY_OUTPUT.get("vehicle")!)).toBeNull();
    state.buildings = state.buildings.filter((building) => building.itemId !== "machine_tool");
    expect(recipeSiteFailure(state, overlapWorker, RECIPE_BY_OUTPUT.get("vehicle")!)).toContain("机床2格内");
  });

  it("places an owned ground building, then dismantles it back into the player inventory", () => {
    const state = createInitialState({ withStarter: false, worldSeed: 44 });
    state.resourceNodes = [];
    state.playerBuildingInventory.factory = 1;
    expect(placeOwnedBuilding(state, "factory", { x: 2, y: 0 })).toMatchObject({ ok: true });
    expect(state.playerBuildingInventory.factory).toBeUndefined();
    expect(state.buildings).toHaveLength(1);
    const building = state.buildings[0];
    expect(dismantleBuilding(state, building.id)).toEqual({ ok: true });
    expect(state.buildings).toHaveLength(0);
    expect(state.playerBuildingInventory.factory).toBe(1);
  });

  it("lets every industrial building use resource-adjacent cells but rejects centers and unknown goods", () => {
    const state = createInitialState({ worldSeed: 45 });
    const node = state.resourceNodes[0];
    expect(buildingPlacementFailure(state, "factory", node.position)).toContain("资源");
    const harvestTile = resourceHarvestTiles(node).find((position) => !state.cats.some((cat) => cat.position.x === position.x && cat.position.y === position.y))!;
    expect(buildingPlacementFailure(state, "factory", harvestTile)).toBeNull();
    expect(buildingPlacementFailure(state, "machine_tool", harvestTile)).toBeNull();
    expect(buildingPlacementFailure(state, "antenna", harvestTile)).toBeNull();
    expect(buildingPlacementFailure(state, "lab", harvestTile)).toBeNull();
    expect(buildingPlacementFailure(state, "reactor", harvestTile)).toBeNull();
    expect(buildingPlacementFailure(state, "wood", { x: 4, y: 4 })).toContain("不能放置");
  });
});
