import { mkdir, writeFile } from "node:fs/promises";
import {
  canUnlockRecipe,
  CATALOG_ANALYSIS,
  DEPLOYABLE_BUILDING_IDS,
  ITEMS,
  RECIPES,
  recipeUnlockCost,
} from "../src/game/catalog";
import {
  advanceGame,
  buildingPlacementFailure,
  catStockPurchaseQuote,
  createInitialState,
  itemPrice,
  warehouseSellPrice,
} from "../src/game/engine";
import { effectiveRecipeInputs } from "../src/game/difficulty";
import { creditAvailableCents, productionOrderBudgetCents } from "../src/game/market";
import { createAuditedPlayerFacade } from "../src/game/playerFacade";
import type { GameState, ItemId, Position } from "../src/game/types";

const SIMULATION_SPEED = 5_000;
const STEP_LOGICAL_MS = 60_000;
const CHECKPOINT_LOGICAL_MS = 10 * 60_000;
const hoursArg = process.argv.find((argument) => argument.startsWith("--hours="));
const TEST_LOGICAL_MS = Math.max(10 * 60_000, Number(hoursArg?.slice(8) ?? 0.5) * 60 * 60_000);
const BUILDING_IDS = [...DEPLOYABLE_BUILDING_IDS] as ItemId[];

const originalBasePrices = Object.fromEntries(ITEMS.map((item) => [item.id, CATALOG_ANALYSIS.basePrices[item.id]]));
const originalSellPrices = Object.fromEntries(ITEMS.map((item) => [item.id, CATALOG_ANALYSIS.sellPrices[item.id]]));
for (const item of ITEMS) {
  const multiplier = 10 ** item.tier;
  CATALOG_ANALYSIS.basePrices[item.id] = originalBasePrices[item.id] * multiplier;
  CATALOG_ANALYSIS.sellPrices[item.id] = originalSellPrices[item.id] * multiplier;
}

const logicalNow = (state: GameState) => Math.round(state.simTime * state.simulationSpeed);
const craftedThrough = (state: GameState) => {
  let count = 0;
  for (const recipe of RECIPES) {
    if (state.itemStats[recipe.output].crafted <= 0) break;
    count += 1;
  }
  return count;
};

function tierSnapshot(state: GameState, previous?: Record<string, number>) {
  return Array.from({ length: 9 }, (_, tier) => {
    const tierItems = ITEMS.filter((item) => item.tier === tier);
    const totalCrafted = tierItems.reduce((sum, item) => sum + state.itemStats[item.id].crafted, 0);
    const previousCrafted = tierItems.reduce((sum, item) => sum + (previous?.[item.id] ?? 0), 0);
    return {
      tier,
      multiplier: 10 ** tier,
      distinctCrafted: tierItems.filter((item) => state.itemStats[item.id].crafted > 0).length,
      itemCount: tierItems.length,
      totalCrafted,
      craftedInWindow: totalCrafted - previousCrafted,
    };
  });
}

function stateCheckpoint(state: GameState, previous?: Record<string, number>) {
  const crafted = Object.fromEntries(ITEMS.map((item) => [item.id, state.itemStats[item.id].crafted]));
  return {
    logicalMs: logicalNow(state),
    engineClockMs: state.simTime,
    theoreticalRealtimeAt1xMs: logicalNow(state),
    treasuryCents: state.treasuryCoins,
    craftedThrough: craftedThrough(state),
    distinctCrafted: ITEMS.filter((item) => state.itemStats[item.id].crafted > 0).length,
    unlockedRecipes: state.unlockedRecipes.length,
    activePlans: state.procurementPlans.filter((plan) => plan.status === "active").length,
    openOrders: state.demandOrders.filter((order) => order.status === "open").length,
    activeContracts: state.shipmentContracts.filter((contract) => contract.status !== "delivered").length,
    tiers: tierSnapshot(state, previous),
    crafted,
  };
}

function tradeProfitableOrdinaryStock(
  state: GameState,
  player: ReturnType<typeof createAuditedPlayerFacade>,
  maxUnits = 40,
) {
  const buildings = new Set<string>(DEPLOYABLE_BUILDING_IDS);
  let units = 0;
  let netCents = 0;
  while (units < maxUnits) {
    const line = catStockPurchaseQuote(state).lines
      .filter((entry) => !buildings.has(entry.itemId)
        && warehouseSellPrice(entry.itemId) > entry.unitPriceCents
        && entry.unitPriceCents <= state.treasuryCoins)
      .sort((left, right) => (warehouseSellPrice(right.itemId) - right.unitPriceCents)
        - (warehouseSellPrice(left.itemId) - left.unitPriceCents)
        || left.catId.localeCompare(right.catId)
        || left.itemId.localeCompare(right.itemId))[0];
    if (!line) break;
    const purchase = player.buyCatItem(line.catId, line.itemId);
    if (!purchase.ok) break;
    const sale = player.sellWarehouseItem(line.itemId, 1);
    if (!sale.ok) throw new Error(`测试转售 ${line.itemId} 失败：${sale.error}`);
    units += 1;
    netCents += warehouseSellPrice(line.itemId) - line.unitPriceCents;
  }
  return { units, netCents };
}

function buyAffordableRecipes(state: GameState, player: ReturnType<typeof createAuditedPlayerFacade>) {
  const bought: Array<{ itemId: string; costCents: number; logicalMs: number }> = [];
  let changed = true;
  while (changed) {
    changed = false;
    const craftedItems = ITEMS.filter((item) => state.itemStats[item.id].crafted > 0).map((item) => item.id);
    for (const recipe of RECIPES) {
      if (state.unlockedRecipes.includes(recipe.id)
        || !canUnlockRecipe(recipe.id, state.unlockedRecipes, craftedItems)) continue;
      const cost = recipeUnlockCost(recipe.id);
      if (state.treasuryCoins < cost) continue;
      const result = player.buyRecipe(recipe.id);
      if (!result.ok) continue;
      bought.push({ itemId: recipe.output, costCents: result.cost ?? cost, logicalMs: logicalNow(state) });
      changed = true;
    }
  }
  return bought;
}

function buildingPositions(state: GameState): Record<string, Position> {
  for (const cat of [...state.cats].sort((a, b) => a.createdIndex - b.createdIndex)) {
    const candidates: Position[] = [];
    for (let dy = -3; dy <= 3; dy += 1) for (let dx = -3; dx <= 3; dx += 1) {
      if (Math.abs(dx) + Math.abs(dy) > 3) continue;
      const position = { x: cat.position.x + dx, y: cat.position.y + dy };
      if (!buildingPlacementFailure(state, "factory", position)) candidates.push(position);
    }
    if (candidates.length >= BUILDING_IDS.length) {
      return Object.fromEntries(BUILDING_IDS.map((itemId, index) => [itemId, candidates[index]]));
    }
  }
  return {};
}

function buyAndPlaceAvailableBuildings(
  state: GameState,
  player: ReturnType<typeof createAuditedPlayerFacade>,
  positions: Record<string, Position>,
) {
  const deployed: string[] = [];
  for (const itemId of BUILDING_IDS) {
    if (state.buildings.some((building) => building.itemId === itemId) || !positions[itemId]) continue;
    if ((state.playerBuildingInventory[itemId] ?? 0) < 1) {
      const offer = state.buildingOffers
        .filter((entry) => entry.status === "open" && entry.itemId === itemId && entry.askCents <= state.treasuryCoins)
        .sort((left, right) => left.askCents - right.askCents || left.id.localeCompare(right.id))[0];
      if (offer) player.buyBuilding(offer.id);
    }
    if ((state.playerBuildingInventory[itemId] ?? 0) > 0) {
      const result = player.placeBuilding(itemId, positions[itemId]);
      if (result.ok) deployed.push(itemId);
    }
  }
  return deployed;
}

function blockedEconomy(state: GameState) {
  const priceOf = (itemId: ItemId) => itemPrice(state, itemId);
  return {
    plans: state.procurementPlans.filter((plan) => plan.status === "active").map((plan) => {
      const cat = state.cats.find((entry) => entry.id === plan.catId);
      const recipe = RECIPES.find((entry) => entry.id === plan.recipeId);
      return {
        id: plan.id,
        catId: plan.catId,
        itemId: plan.outputItemId,
        reason: plan.reason,
        ageLogicalMs: logicalNow(state) - Math.round(plan.createdAt * state.simulationSpeed),
        cashCents: cat?.coins ?? 0,
        debtCents: cat?.debtCents ?? 0,
        escrowReservedCents: cat?.escrowReservedCents ?? 0,
        availableCreditCents: cat ? creditAvailableCents(state, cat, priceOf) : 0,
        action: cat?.action ? `${cat.action.type}:${cat.action.itemId}` : null,
        inputs: recipe ? effectiveRecipeInputs(recipe, state.difficulty).map((input) => ({
          itemId: input.itemId,
          required: input.quantity,
          owned: cat?.inventory[input.itemId] ?? 0,
          missing: Math.max(0, input.quantity - (cat?.inventory[input.itemId] ?? 0)),
        })) : [],
      };
    }),
    orders: state.demandOrders.filter((order) => order.status === "open").map((order) => {
      const buyer = order.buyerCatId ? state.cats.find((cat) => cat.id === order.buyerCatId) : undefined;
      const credit = buyer ? creditAvailableCents(state, buyer, priceOf) : state.treasuryCoins;
      return {
        itemId: order.itemId,
        maxDeliveredCents: order.maxDeliveredCents,
        availableCreditCents: credit,
        creditGapCents: Math.max(0, order.maxDeliveredCents - credit),
      };
    }),
  };
}

function runPlayerEconomy() {
  const state = createInitialState({ worldSeed: 1, difficulty: 5, simulationSpeed: SIMULATION_SPEED });
  const player = createAuditedPlayerFacade(state);
  const positions = buildingPositions(state);
  const checkpoints = [stateCheckpoint(state)];
  const firstCraftLogicalMs: Record<string, number> = {};
  const recipePurchases: Array<{ itemId: string; costCents: number; logicalMs: number }> = [];
  const buildingsDeployed: Array<{ itemId: string; logicalMs: number }> = [];
  let tradeUnits = 0;
  let tradeNetCents = 0;
  let previousCrafted = checkpoints[0].crafted;
  const wallStarted = performance.now();
  while (logicalNow(state) < TEST_LOGICAL_MS) {
    const logicalStep = Math.min(STEP_LOGICAL_MS, TEST_LOGICAL_MS - logicalNow(state));
    player.advanceTime(logicalStep / state.simulationSpeed);
    const traded = tradeProfitableOrdinaryStock(state, player);
    tradeUnits += traded.units;
    tradeNetCents += traded.netCents;
    recipePurchases.push(...buyAffordableRecipes(state, player));
    for (const itemId of buyAndPlaceAvailableBuildings(state, player, positions)) {
      buildingsDeployed.push({ itemId, logicalMs: logicalNow(state) });
    }
    recipePurchases.push(...buyAffordableRecipes(state, player));
    for (const item of ITEMS) {
      if (state.itemStats[item.id].crafted > 0 && firstCraftLogicalMs[item.id] === undefined) {
        firstCraftLogicalMs[item.id] = logicalNow(state);
      }
    }
    if (logicalNow(state) % CHECKPOINT_LOGICAL_MS === 0 || logicalNow(state) === TEST_LOGICAL_MS) {
      const checkpoint = stateCheckpoint(state, previousCrafted);
      checkpoints.push(checkpoint);
      previousCrafted = checkpoint.crafted;
    }
  }
  return {
    branch: "player-economy",
    fixtureMutations: ["tier base prices only"],
    wallClockMs: Math.round(performance.now() - wallStarted),
    logicalSimulatedMs: logicalNow(state),
    engineClockAdvancedMs: state.simTime,
    measuredAcceleration: Number((logicalNow(state) / Math.max(1, performance.now() - wallStarted)).toFixed(2)),
    final: stateCheckpoint(state, previousCrafted),
    checkpoints,
    firstCraftLogicalMs,
    recipePurchases,
    buildingsDeployed,
    tradeUnits,
    tradeNetCents,
    commandCounts: Object.fromEntries(Object.entries(state.commandAudit
      .filter((entry) => entry.origin === "player-ui")
      .reduce<Record<string, number>>((counts, entry) => {
        counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
        return counts;
      }, {}))),
    blocked: blockedEconomy(state),
  };
}

function installControlledSites(state: GameState) {
  state.buildings = state.cats.flatMap((cat) => BUILDING_IDS.map((itemId, index) => ({
    id: `controlled-${cat.id}-${itemId}`,
    itemId,
    position: { ...cat.position },
    deployedAt: -index,
  })));
  state.nextBuildingIndex = state.buildings.length;
}

function runControlledProduction() {
  const state = createInitialState({ worldSeed: 1, difficulty: 5, simulationSpeed: SIMULATION_SPEED });
  state.unlockedRecipes = RECIPES.map((recipe) => recipe.id);
  installControlledSites(state);
  state.dirtyDecisions = true;
  const checkpoints = [stateCheckpoint(state)];
  const firstCraftLogicalMs: Record<string, number> = {};
  let previousCrafted = checkpoints[0].crafted;
  const wallStarted = performance.now();
  while (logicalNow(state) < TEST_LOGICAL_MS) {
    const logicalStep = Math.min(STEP_LOGICAL_MS, TEST_LOGICAL_MS - logicalNow(state));
    advanceGame(state, logicalStep / state.simulationSpeed);
    for (const item of ITEMS) {
      if (state.itemStats[item.id].crafted > 0 && firstCraftLogicalMs[item.id] === undefined) {
        firstCraftLogicalMs[item.id] = logicalNow(state);
      }
    }
    if (logicalNow(state) % CHECKPOINT_LOGICAL_MS === 0 || logicalNow(state) === TEST_LOGICAL_MS) {
      const checkpoint = stateCheckpoint(state, previousCrafted);
      checkpoints.push(checkpoint);
      previousCrafted = checkpoint.crafted;
    }
  }
  const wallClockMs = Math.round(performance.now() - wallStarted);
  return {
    branch: "controlled-production",
    fixtureMutations: ["tier base prices", "all recipes unlocked", "all site buildings at every starter cat"],
    wallClockMs,
    logicalSimulatedMs: logicalNow(state),
    engineClockAdvancedMs: state.simTime,
    measuredAcceleration: Number((logicalNow(state) / Math.max(1, wallClockMs)).toFixed(2)),
    final: stateCheckpoint(state, previousCrafted),
    checkpoints,
    firstCraftLogicalMs,
    blocked: blockedEconomy(state),
  };
}

const economicsState = createInitialState({ worldSeed: 1, difficulty: 5, simulationSpeed: SIMULATION_SPEED });
const priceRows = RECIPES.map((recipe, index) => {
  const item = ITEMS[index];
  const priceCents = itemPrice(economicsState, item.id);
  const inputBudgetCents = productionOrderBudgetCents(economicsState, recipe.id, (itemId) => itemPrice(economicsState, itemId));
  return {
    index: index + 1,
    itemId: item.id,
    tier: item.tier,
    tierMultiplier: 10 ** item.tier,
    basePriceCents: CATALOG_ANALYSIS.basePrices[item.id] * 100,
    advertisedPriceCents: priceCents,
    recipeUnlockCostCents: recipeUnlockCost(recipe.id),
    inputOrderBudgetCents: inputBudgetCents,
    inputBudgetToPrice: priceCents > 0 ? Number((inputBudgetCents / priceCents).toFixed(4)) : null,
    exceedsBaseCredit: inputBudgetCents > 5_000,
    safeInteger: [priceCents, inputBudgetCents, recipeUnlockCost(recipe.id)].every(Number.isSafeInteger),
  };
});

const player = runPlayerEconomy();
const controlled = runControlledProduction();
const report = {
  schema: "extreme-tier-prices-v1",
  generatedAt: new Date().toISOString(),
  seed: 1,
  difficulty: 5,
  pricingRule: "tier 0 x1; every later tier multiplies the catalog base price by another 10",
  simulationSpeed: SIMULATION_SPEED,
  logicalTestDurationMs: TEST_LOGICAL_MS,
  timingFormula: {
    engineClockAdvancedMs: "logicalSimulatedMs / 5000",
    theoreticalRealtimeAt1xMs: "logicalSimulatedMs",
    measuredAcceleration: "logicalSimulatedMs / wallClockMs",
  },
  allValuesAreSafeIntegers: priceRows.every((row) => row.safeInteger),
  priceRows,
  player,
  controlled,
};

const escapeHtml = (value: unknown) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const money = (cents: number) => `${(cents / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 金币`;
const duration = (ms: number) => ms < 60_000 ? `${(ms / 1_000).toFixed(2)} 秒` : `${(ms / 60_000).toFixed(2)} 分钟`;
const tierRows = Array.from({ length: 9 }, (_, tier) => {
  const rows = priceRows.filter((row) => row.tier === tier);
  const creditBlocked = rows.filter((row) => row.exceedsBaseCredit).length;
  return `<tr><td>${tier}</td><td>×${(10 ** tier).toLocaleString("zh-CN")}</td><td>${money(Math.min(...rows.map((row) => row.basePriceCents)))}</td><td>${money(Math.max(...rows.map((row) => row.basePriceCents)))}</td><td>${creditBlocked}/${rows.length}</td></tr>`;
}).join("");
const branchRows = [player, controlled].map((branch) => `<tr><td>${escapeHtml(branch.branch)}</td><td>${branch.final.craftedThrough}</td><td>${branch.final.distinctCrafted}/65</td><td>${branch.final.unlockedRecipes}/65</td><td>${money(branch.final.treasuryCents)}</td><td>${branch.final.activePlans}</td><td>${branch.final.openOrders}</td><td>${duration(branch.logicalSimulatedMs)}</td><td>${duration(branch.engineClockAdvancedMs)}</td><td>${duration(branch.wallClockMs)}</td><td>${branch.measuredAcceleration}×</td></tr>`).join("");
const checkpointRows = [player, controlled].flatMap((branch) => branch.checkpoints.slice(1).map((checkpoint) => `<tr><td>${escapeHtml(branch.branch)}</td><td>${duration(checkpoint.logicalMs)}</td><td>${checkpoint.craftedThrough}</td><td>${checkpoint.distinctCrafted}</td><td>${checkpoint.unlockedRecipes}</td>${checkpoint.tiers.map((tier) => `<td>${tier.distinctCrafted}/${tier.itemCount} (${tier.craftedInWindow})</td>`).join("")}</tr>`)).join("");
const stuckRows = [player, controlled].flatMap((branch) => branch.blocked.plans.map((plan) => `<tr><td>${escapeHtml(branch.branch)}</td><td>${escapeHtml(plan.catId)}</td><td>${escapeHtml(plan.itemId)}</td><td>${escapeHtml(plan.reason)}</td><td>${duration(plan.ageLogicalMs)}</td></tr>`)).join("");
const playerMissingFirstTen = RECIPES.slice(0, 10).filter((recipe) => player.final.crafted[recipe.output] === 0).map((recipe) => recipe.output);
const controlledPlanCounts = Object.entries(controlled.blocked.plans.reduce<Record<string, number>>((counts, plan) => {
  counts[plan.itemId] = (counts[plan.itemId] ?? 0) + 1;
  return counts;
}, {})).sort((left, right) => right[1] - left[1]);
const blockedTierTwo = priceRows.filter((row) => row.tier === 2 && row.exceedsBaseCredit).length;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>时代价格每级×10 极端测试</title><style>
:root{font-family:Inter,"Microsoft YaHei",system-ui,sans-serif;color:#172126;background:#edf1ef}*{box-sizing:border-box}body{margin:0}main{max-width:1380px;margin:auto;background:white;min-height:100vh;padding:34px}h1{margin:0 0 8px;font-size:30px;letter-spacing:0}h2{font-size:20px;margin:30px 0 10px;border-bottom:2px solid #dbe3df;padding-bottom:7px}p{line-height:1.65}.hero{border-left:6px solid #b74034;background:#fff2f0;padding:15px 18px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin:16px 0}.metric{border:1px solid #dce4df;background:#f8faf9;padding:11px}.metric b{display:block;font-size:19px}.metric span{font-size:12px;color:#637169}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #dce4df;padding:7px;text-align:left;vertical-align:top}th{background:#edf3ef}.scroll{overflow:auto}.note{background:#fff8dc;border:1px solid #e6d58c;padding:12px}code,pre{font-family:"Cascadia Mono",Consolas,monospace}pre{white-space:pre-wrap;word-break:break-word;max-height:480px;overflow:auto;background:#17211d;color:#e9f0ec;padding:13px}@media(max-width:900px){main{padding:18px}.metrics{grid-template-columns:repeat(2,1fr)}}
</style></head><body><main><h1>时代价格每级 ×10 极端测试</h1><p>seed 1 · 难度5 · 生成时间 ${escapeHtml(report.generatedAt)}</p><div class="hero"><strong>这是诊断实验，不是正式平衡改动。</strong><p>基础采集保持×1，手工作坊×10，机械制造×100，电气工业×1,000，依次增长到星门工程×100,000,000。</p></div>
<div class="metrics"><div class="metric"><b>${player.final.craftedThrough}</b><span>玩家经济连续制作</span></div><div class="metric"><b>${controlled.final.craftedThrough}</b><span>隔离生产连续制作</span></div><div class="metric"><b>${duration(TEST_LOGICAL_MS)}</b><span>每分支逻辑/理论1×</span></div><div class="metric"><b>${report.allValuesAreSafeIntegers ? "是" : "否"}</b><span>价格仍为安全整数</span></div></div>
<h2>价格跨度</h2><div class="scroll"><table id="tier-prices"><thead><tr><th>时代</th><th>倍率</th><th>最低基础价</th><th>最高基础价</th><th>初始信用不足的配方</th></tr></thead><tbody>${tierRows}</tbody></table></div>
<p class="note">难度5基础信用为50金币。“信用不足”只表示猫在零现金、零库存时无法一次冻结全部原料订单；已有库存、个人现金和后续收入仍可能使计划成立。</p>
<h2>两种分支结果</h2><div class="scroll"><table id="branch-results"><thead><tr><th>分支</th><th>连续制作</th><th>不同商品</th><th>图纸</th><th>国库</th><th>活动计划</th><th>开放订单</th><th>逻辑/理论1×</th><th>引擎时钟</th><th>实际墙钟</th><th>实测加速</th></tr></thead><tbody>${branchRows}</tbody></table></div>
<p>玩家经济分支只使用正常收购、仓库出售、购买图纸、购买并放置建筑；除实验价格表外没有注入金币、商品或发现。隔离生产分支预开全部图纸并给每只猫配置全部场地建筑，用来排除国库和场地干扰。</p>
<h2>结论</h2><ul><li>正常玩家分支30分钟后仍缺少前10项中的 <code>${escapeHtml(playerMissingFirstTen.join(", "))}</code>，只形成 ${player.final.distinctCrafted} 种商品；十倍价格没有加快升级，反而破坏了基础链的连续性。</li><li>隔离分支即使预开65张图纸并移除全部场地限制，也只形成 ${controlled.final.distinctCrafted} 种商品；最终最集中的计划是 <code>${escapeHtml(controlledPlanCounts[0]?.[0] ?? "无")}</code>（${controlledPlanCounts[0]?.[1] ?? 0}只猫）。</li><li>时代2已有 ${blockedTierTwo}/7 个配方的完整原料订单预算超过50金币基础信用；时代3至时代8则全部超过。指数价格把“收益信号”同时变成了“巨额托管与信用需求”。</li><li>因此高级品基础价格不足不是当前主要矛盾。跨时代×10会让远期目标过早吸走工位，同时使图纸、订单和信用按数量级膨胀。</li></ul>
<h2>每10分钟进度</h2><div class="scroll"><table id="checkpoints"><thead><tr><th>分支</th><th>逻辑时间</th><th>连续</th><th>不同商品</th><th>图纸</th>${Array.from({ length: 9 }, (_, tier) => `<th>时代${tier}<br>种类（窗口产量）</th>`).join("")}</tr></thead><tbody>${checkpointRows}</tbody></table></div>
<h2>最终停滞计划</h2><table id="stuck-plans"><thead><tr><th>分支</th><th>猫</th><th>目标</th><th>原因</th><th>年龄</th></tr></thead><tbody>${stuckRows || `<tr><td colspan="5">无活动计划</td></tr>`}</tbody></table>
<h2>完整原始数据</h2><details><summary>展开 JSON</summary><pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre></details></main></body></html>`;

await mkdir("output", { recursive: true });
await writeFile("output/extreme-tier-prices.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile("output/Extreme-Tier-Price-Test.html", html, "utf8");
process.stdout.write(`${JSON.stringify({
  output: "output/Extreme-Tier-Price-Test.html",
  player: { craftedThrough: player.final.craftedThrough, distinct: player.final.distinctCrafted, unlocked: player.final.unlockedRecipes, treasuryCents: player.final.treasuryCents, wallClockMs: player.wallClockMs },
  controlled: { craftedThrough: controlled.final.craftedThrough, distinct: controlled.final.distinctCrafted, wallClockMs: controlled.wallClockMs },
  logicalMsPerBranch: TEST_LOGICAL_MS,
  engineClockMsPerBranch: TEST_LOGICAL_MS / SIMULATION_SPEED,
}, null, 2)}\n`);
