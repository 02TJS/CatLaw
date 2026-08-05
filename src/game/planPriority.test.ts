import { describe, expect, it } from "vitest";
import { RECIPE_BY_OUTPUT } from "./catalog";
import { effectiveRecipeInputs } from "./difficulty";
import { createInitialState, decideIdleCats, itemPrice } from "./engine";
import { ensureDirectCraftPlan } from "./market";
import type { ProcurementPlan } from "./types";

function blockedToolsPlan(catId: string): ProcurementPlan {
  return {
    id: "plan-single",
    catId,
    outputItemId: "tools",
    recipeId: RECIPE_BY_OUTPUT.get("tools")!.id,
    terminalOrderId: null,
    expectedRevenueCents: 10_000,
    bountyCents: 0,
    createdAt: 0,
    createdByBehaviorLawId: "starter-law-foundation-cycle",
    status: "active",
    reason: "bounty",
    phase: "funded",
    terminalRevenueCents: 10_000,
    alternativeGainCents: 0,
    bundleCostCents: 0,
    financingReserveCents: 0,
    expectedProfitCents: 10_000,
    budgetSlackCents: 10_000,
    bundleOrderIds: [],
    blockedReason: "等待整包原料合同送达",
    quoteRevision: 0,
  };
}

describe("single-plan priority law", () => {
  it("keeps one plan, works a spare-stock side job while blocked, then returns to the ready plan", () => {
    const state = createInitialState({ worldSeed: 321 });
    const cat = state.cats[0];
    state.cats = [cat];
    state.nextCatIndex = 1;
    cat.position = { x: 0, y: 0 };
    cat.action = null;
    cat.inventory = {};
    state.resourceNodes = [{ id: "resource-side-work", itemId: "wood", position: { x: 1, y: 0 } }];
    state.unlockedRecipes = [RECIPE_BY_OUTPUT.get("wood")!.id, RECIPE_BY_OUTPUT.get("tools")!.id];
    state.procurementPlans = [blockedToolsPlan(cat.id)];

    expect(ensureDirectCraftPlan(
      state,
      cat,
      RECIPE_BY_OUTPUT.get("wood")!.id,
      (itemId) => itemPrice(state, itemId, cat),
      "test-side-work",
    )).toBe(true);
    expect(state.procurementPlans.filter((plan) => plan.status === "active")).toHaveLength(1);

    decideIdleCats(state);
    expect(cat.action).toMatchObject({ type: "craft", recipeId: RECIPE_BY_OUTPUT.get("wood")!.id });
    expect((cat.action as { decisionReason?: string } | null)?.decisionReason).toContain("副业");
    expect(state.procurementPlans.filter((plan) => plan.status === "active")).toHaveLength(1);

    cat.action = null;
    const tools = RECIPE_BY_OUTPUT.get("tools")!;
    for (const input of effectiveRecipeInputs(tools, state.difficulty)) cat.inventory[input.itemId] = input.quantity;
    decideIdleCats(state);

    expect(cat.action).toMatchObject({ type: "craft", recipeId: tools.id });
    expect((cat.action as { decisionReason?: string } | null)?.decisionReason).toContain("唯一生产计划");
    expect(state.procurementPlans.filter((plan) => plan.status === "active")).toHaveLength(1);
  });
});
