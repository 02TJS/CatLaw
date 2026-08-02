import { RECIPES, RECIPE_BY_OUTPUT } from "../src/game/catalog";
import { siteFailure } from "../src/game/logistics";
import { playSeed } from "./qa-35.mts";

const seeds = process.argv.slice(2).map(Number).filter(Number.isFinite);
for (const seed of seeds) {
  const result = playSeed(seed, false);
  const state = result.state;
  const missing = RECIPES.slice(0, 35)
    .filter((recipe) => state.itemStats[recipe.output].crafted === 0)
    .map((recipe, index) => ({ itemId: recipe.output, catalogIndex: RECIPES.indexOf(recipe) + 1 + index * 0 }));
  const activePlans = state.procurementPlans.filter((plan) => plan.status === "active").map((plan) => ({
    id: plan.id,
    catId: plan.catId,
    itemId: plan.outputItemId,
    reason: plan.reason,
    terminalOrderId: plan.terminalOrderId,
    inventory: state.cats.find((cat) => cat.id === plan.catId)?.inventory ?? {},
    coins: state.cats.find((cat) => cat.id === plan.catId)?.coins ?? 0,
    debtCents: state.cats.find((cat) => cat.id === plan.catId)?.debtCents ?? 0,
    escrowReservedCents: state.cats.find((cat) => cat.id === plan.catId)?.escrowReservedCents ?? 0,
    decision: state.cats.find((cat) => cat.id === plan.catId)?.lastDecision ?? "",
  }));
  const openOrders = state.demandOrders.filter((order) => order.status === "open").map((order) => ({
    id: order.id,
    itemId: order.itemId,
    buyerCatId: order.buyerCatId,
    destinationCatId: order.destinationCatId,
    planId: order.planId,
    bid: order.maxDeliveredCents,
  }));
  const contracts = state.shipmentContracts.filter((contract) => contract.status !== "delivered").map((contract) => ({
    id: contract.id,
    itemId: contract.itemId,
    status: contract.status,
    currentLeg: contract.currentLeg,
    routeLength: contract.routeCatIds.length,
    custodianCatId: contract.custodianCatId,
  }));
  process.stdout.write(`${JSON.stringify({
    seed,
    passed: result.passed,
    simTime: result.simTime,
    missing,
    activePlans,
    openOrders,
    contracts,
    buildings: state.buildings,
    buildingOffers: state.buildingOffers.filter((offer) => offer.status === "open"),
    inventories: state.cats.filter((cat) => Object.keys(cat.inventory).length > 0).map((cat) => ({
      id: cat.id,
      position: cat.position,
      inventory: cat.inventory,
      decision: cat.lastDecision,
    })),
    validSites: Object.fromEntries(missing.map(({ itemId }) => [itemId, state.cats
      .filter((cat) => siteFailure(state, cat, RECIPE_BY_OUTPUT.get(itemId)!) === null)
      .map((cat) => ({ id: cat.id, position: cat.position, decision: cat.lastDecision }))])),
  })}\n`);
}
