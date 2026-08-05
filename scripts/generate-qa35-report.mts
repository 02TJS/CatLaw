import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CATALOG_ANALYSIS, ITEM_BY_ID, ITEMS, RECIPES } from "../src/game/catalog";
import { difficultyProfile, effectiveRecipeInputs, normalizeDifficulty } from "../src/game/difficulty";
import { itemPrice } from "../src/game/engine";
import { productionOrderBudgetCents } from "../src/game/market";
import type { DifficultyLevel, ItemId, MarketBroadcast } from "../src/game/types";
import { playSeed, type Qa35Operation } from "./qa-35.mts";

const seed = Number(process.argv[2] ?? 1);
const outputPath = resolve(process.argv[3] ?? "CatWorkshop-35-Run-Report.html");
const difficulty = normalizeDifficulty(process.argv[4], 3) as DifficultyLevel;
const profile = difficultyProfile(difficulty);
const jsonPath = resolve("output", `qa35-difficulty${difficulty}-seed${seed}-record.json`);
const result = playSeed(seed, false, difficulty === 5 ? 14_400_000 : 7_200_000, 5_000, difficulty);
if (!result.passed) throw new Error(`Seed ${seed} did not pass the 35-item acceptance`);

const state = result.state;
const operations = result.operations;
const first35 = RECIPES.slice(0, 35);
const itemIndex = new Map(RECIPES.map((recipe, index) => [recipe.output, index + 1]));
const item = (id: string) => ITEM_BY_ID.get(id) ?? { id, name: id, emoji: "📦", tier: 0 };
const h = (value: unknown) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");
const money = (cents: number) => `${(cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 金币`;
const signedMoney = (cents: number) => `${cents >= 0 ? "+" : "−"}${money(Math.abs(cents))}`;
const time = (milliseconds: number | undefined | null) => {
  if (milliseconds === undefined || milliseconds === null) return "—";
  const seconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};
const itemLabel = (id: string) => {
  const definition = item(id);
  const index = itemIndex.get(id);
  return `${definition.emoji} ${definition.name}${index ? ` #${index}` : ""} · ${id}`;
};
const formula = (recipe: (typeof RECIPES)[number]) => effectiveRecipeInputs(recipe, difficulty).length === 0
  ? "资源区采集"
  : effectiveRecipeInputs(recipe, difficulty).map((input) => {
    const definition = item(input.itemId);
    return `${definition.emoji}${definition.name}${input.quantity > 1 ? `×${input.quantity}` : ""}`;
  }).join(" + ");

const closureByItem = new Map<string, MarketBroadcast>();
for (const broadcast of state.marketBroadcasts) {
  if (broadcast.kind !== "bounty-closed") continue;
  const previous = closureByItem.get(broadcast.itemId);
  if (!previous || broadcast.publishedAt < previous.publishedAt) closureByItem.set(broadcast.itemId, broadcast);
}

const grossCostCents = operations.reduce((total, operation) => total + operation.costCents, 0);
const netTreasurySpendCents = 1_000_000_000 - state.treasuryCoins;
const operationInflowsCents = grossCostCents - netTreasurySpendCents;
const costs = {
  recipe: operations.filter((entry) => entry.kind === "recipe-unlock").reduce((sum, entry) => sum + entry.costCents, 0),
  enact: operations.filter((entry) => entry.kind === "law-enact").reduce((sum, entry) => sum + entry.costCents, 0),
  repeal: operations.filter((entry) => entry.kind === "law-repeal").reduce((sum, entry) => sum + entry.costCents, 0),
  parcel: operations.filter((entry) => entry.kind === "parcel-expand").reduce((sum, entry) => sum + entry.costCents, 0),
  building: operations.filter((entry) => entry.kind === "building-buy").reduce((sum, entry) => sum + entry.costCents, 0),
};
const kindLabels: Record<Qa35Operation["kind"], string> = {
  "test-budget": "测试预算",
  "recipe-unlock": "购买配方",
  "law-enact": "颁布法规",
  "law-repeal": "废止法规",
  "parcel-expand": "购买土地",
  "cat-place": "放置猫咪",
  "building-buy": "收购建筑",
  "building-place": "放置建筑",
  "time-advance": "推进时间",
  "phase-check": "阶段检查",
};
const stageLabels = { setup: "准备", phase1: "阶段一", phase2: "阶段二", phase3: "阶段三" } as const;
const targetLabel = (operation: Qa35Operation) => itemIndex.has(operation.target)
  ? itemLabel(operation.target)
  : operation.target;

const recipeGroups = [
  { label: "第 11–15 项", at: 0, operations: operations.filter((op) => op.kind === "recipe-unlock" && [11, 12, 13, 14, 15].includes(itemIndex.get(op.target) ?? 0)) },
  { label: "第 16–20 项", at: result.phase1.completeAtMs, operations: operations.filter((op) => op.kind === "recipe-unlock" && [16, 17, 18, 19, 20].includes(itemIndex.get(op.target) ?? 0)) },
  { label: "第 21–27 项", at: result.phase1.completeAtMs + result.phase2.observedForMs, operations: operations.filter((op) => op.kind === "recipe-unlock" && (itemIndex.get(op.target) ?? 0) >= 21 && (itemIndex.get(op.target) ?? 0) <= 27) },
  { label: "第 28–35 项", at: operations.find((op) => op.kind === "building-place")?.atMs ?? 0, operations: operations.filter((op) => op.kind === "recipe-unlock" && (itemIndex.get(op.target) ?? 0) >= 28 && (itemIndex.get(op.target) ?? 0) <= 35) },
];

const qualificationPriceLaws = operations.filter((operation) => operation.kind === "law-enact"
  && operation.target === "factory" && operation.detail.startsWith("工厂 ×2"));
const baseLogisticsLaws = operations.filter((operation) => operation.kind === "law-enact" && operation.detail.startsWith("颁布 22—30"));
const logisticsLaw = state.lawHistory.find((law) => law.id === result.phase3.sharedLawId);
const buildingOffer = state.buildingOffers.find((offer) => offer.status === "purchased" && offer.itemId === "factory");
const industrialBuildingIds = ["factory", "antenna", "machine_tool"];
const industrialBuildings = state.buildings.filter((entry) => industrialBuildingIds.includes(entry.itemId));
const purchasedBuildingOffers = state.buildingOffers.filter((offer) => offer.status === "purchased" && industrialBuildingIds.includes(offer.itemId));
const buildingPositionSummary = industrialBuildings.map((entry) => `${item(entry.itemId).emoji}${item(entry.itemId).name} (${entry.position.x}, ${entry.position.y})`).join("；");
const buildingTimeline = industrialBuildings.map((entry) => {
  const offer = purchasedBuildingOffers.find((candidate) => candidate.itemId === entry.itemId);
  return `<article><time>${h(time(entry.deployedAt * state.simulationSpeed))}</time><h3>收购并放置${h(item(entry.itemId).name)}</h3><p>${h(offer?.sellerCatId ?? "—")} 的固定报价为 ${h(money(offer?.askCents ?? 0))}；部署坐标 (${entry.position.x}, ${entry.position.y})。</p></article>`;
}).join("");
const enactmentCount = operations.filter((entry) => entry.kind === "law-enact").length;
const repealCount = operations.filter((entry) => entry.kind === "law-repeal").length;
const vehicleClosure = closureByItem.get("vehicle");
const lastFirst35ClosureMs = Math.max(...first35.map((recipe) => (closureByItem.get(recipe.output)?.publishedAt ?? 0) * state.simulationSpeed));
const maxRoute = Math.max(0, ...state.shipmentContracts.map((contract) => contract.routeCatIds.length));
const totalPasses = ITEMS.reduce((sum, definition) => sum + state.itemStats[definition.id].passed, 0);
const totalCatCash = state.cats.reduce((sum, cat) => sum + cat.coins, 0);
const totalDebt = state.cats.reduce((sum, cat) => sum + cat.debtCents, 0);
const placedCatCount = operations.filter((operation) => operation.kind === "cat-place").length;
const wheelX2PriceOf = (itemId: ItemId) => itemId === "wheel"
  ? (CATALOG_ANALYSIS.basePrices.wheel ?? 1) * 200
  : itemPrice(state, itemId);
const wheelX10PriceOf = (itemId: ItemId) => itemId === "wheel"
  ? (CATALOG_ANALYSIS.basePrices.wheel ?? 1) * 1_000
  : itemPrice(state, itemId);
const wheelX2JobBudget = productionOrderBudgetCents(state, "make_wheel", wheelX2PriceOf);
const wheelX10JobBudget = productionOrderBudgetCents(state, "make_wheel", wheelX10PriceOf);
const bulkRecipes = first35.filter((recipe) => effectiveRecipeInputs(recipe, difficulty).some((input, index) => (
  input.quantity !== recipe.inputs[index]?.quantity
)));
const difficultyLabel = `难度 ${difficulty} · ${profile.name}`;

const itemRows = first35.map((recipe, index) => {
  const definition = item(recipe.output);
  const stats = state.itemStats[recipe.output];
  const closure = closureByItem.get(recipe.output);
  const observed = result.firstCraftObservedAtMs[recipe.output];
  return `<tr>
    <td class="num">${index + 1}</td>
    <td><span class="emoji">${h(definition.emoji)}</span><strong>${h(definition.name)}</strong><small>${h(definition.id)}</small></td>
    <td>${h(formula(recipe))}</td>
    <td class="mono">≤ ${h(time(observed))}</td>
    <td class="mono">${h(time(closure ? closure.publishedAt * state.simulationSpeed : null))}<small>${h(closure?.sourceCatId ?? "—")}</small></td>
    <td class="num">${stats.crafted.toLocaleString("zh-CN")}</td>
    <td class="num">${stats.passed.toLocaleString("zh-CN")}</td>
    <td class="num">${stats.sold.toLocaleString("zh-CN")}</td>
    <td class="num">${h(money(stats.revenue))}</td>
  </tr>`;
}).join("");

const operationRows = operations.map((operation) => {
  const position = operation.position ? ` · 坐标 (${operation.position.x}, ${operation.position.y})` : "";
  const law = operation.lawId ? ` · ${operation.lawId}` : "";
  return `<tr data-stage="${operation.stage}" data-kind="${operation.kind}">
    <td class="num">${operation.sequence}</td>
    <td class="mono">${h(time(operation.atMs))}</td>
    <td><span class="stage ${operation.stage}">${h(stageLabels[operation.stage])}</span></td>
    <td>${h(kindLabels[operation.kind])}</td>
    <td>${h(targetLabel(operation))}</td>
    <td>${h(operation.detail)}<small>${h(position + law)}</small></td>
    <td class="num">${operation.costCents ? h(money(operation.costCents)) : "—"}</td>
  </tr>`;
}).join("");

const catPlacementRows = operations.filter((operation) => operation.kind === "cat-place").map((operation) => `<tr>
  <td>${h(operation.target)}</td><td class="mono">(${operation.position?.x}, ${operation.position?.y})</td><td>${h(operation.detail)}</td>
</tr>`).join("");

const recipeGroupRows = recipeGroups.map((group) => `<tr>
  <td>${h(group.label)}</td><td class="mono">${h(time(group.at))}</td>
  <td>${group.operations.map((operation) => `<span class="chip">${h(item(operation.target).emoji)} ${h(item(operation.target).name)}</span>`).join(" ")}</td>
  <td class="num">${h(money(group.operations.reduce((sum, operation) => sum + operation.costCents, 0)))}</td>
</tr>`).join("");

const mapSvg = (() => {
  const minX = -4; const maxX = 13; const minY = -4; const maxY = 4; const unit = 42; const pad = 34;
  const width = (maxX - minX + 1) * unit + pad * 2;
  const height = (maxY - minY + 1) * unit + pad * 2;
  const sx = (x: number) => pad + (x - minX) * unit;
  const sy = (y: number) => pad + (y - minY) * unit;
  const grids: string[] = [];
  for (let x = minX; x <= maxX + 1; x += 1) grids.push(`<line x1="${sx(x)}" y1="${sy(minY)}" x2="${sx(x)}" y2="${sy(maxY + 1)}"/>`);
  for (let y = minY; y <= maxY + 1; y += 1) grids.push(`<line x1="${sx(minX)}" y1="${sy(y)}" x2="${sx(maxX + 1)}" y2="${sy(y)}"/>`);
  const resources = state.resourceNodes.map((node) => `<g transform="translate(${sx(node.position.x) + unit / 2} ${sy(node.position.y) + unit / 2})"><circle r="15" class="resource"/><text class="resource-label">${h(item(node.itemId).emoji)}</text></g>`).join("");
  const cats = state.cats.map((cat) => `<g transform="translate(${sx(cat.position.x) + unit / 2} ${sy(cat.position.y) + unit / 2})"><circle r="12" class="cat-dot"/><text class="cat-label">${cat.createdIndex}</text></g>`).join("");
  const buildings = state.buildings.map((entry) => `<g transform="translate(${sx(entry.position.x) + unit / 2} ${sy(entry.position.y) + unit / 2})"><circle r="19" class="building-dot"/><text class="building-label">${h(item(entry.itemId).emoji)}</text></g>`).join("");
  return `<svg class="world-map" viewBox="0 0 ${width} ${height}" role="img" aria-label="种子 ${seed} 的两块地、${state.cats.length} 只猫、资源中心和工业建筑位置">
    <rect x="${sx(-4)}" y="${sy(-4)}" width="${9 * unit}" height="${9 * unit}" class="parcel parcel-a"/>
    <rect x="${sx(5)}" y="${sy(-4)}" width="${9 * unit}" height="${9 * unit}" class="parcel parcel-b"/>
    <g class="grid-lines">${grids.join("")}</g>${resources}${cats}${buildings}
    <text x="${sx(-4) + 8}" y="${sy(-4) - 10}" class="parcel-title">中央地块 (0,0)</text>
    <text x="${sx(5) + 8}" y="${sy(-4) - 10}" class="parcel-title">购买地块 (1,0)</text>
  </svg>`;
})();

const tracePayload = {
  generatedAt: new Date().toISOString(),
  version: "0.12.3",
  seed,
  difficulty,
  difficultyProfile: profile,
  simulationSpeed: state.simulationSpeed,
  result: {
    passed: result.passed,
    simTimeMs: result.simTime,
    phase1: result.phase1,
    phase2: result.phase2,
    phase3: result.phase3,
    vehicle: result.vehicle,
    discovered: result.discovered,
  },
  operations,
  firstCraftObservedAtMs: result.firstCraftObservedAtMs,
  bountyClosures: [...closureByItem.values()].map((broadcast) => ({
    itemId: broadcast.itemId,
    sourceCatId: broadcast.sourceCatId,
    atMs: broadcast.publishedAt * state.simulationSpeed,
  })),
  final: {
    treasuryCents: state.treasuryCoins,
    totalSalesCents: state.totalSales,
    cats: state.cats.map((cat) => ({ id: cat.id, position: cat.position, cashCents: cat.coins, debtCents: cat.debtCents })),
    parcels: state.unlockedParcels,
    buildings: state.buildings,
    itemStats: Object.fromEntries(first35.map((recipe) => [recipe.output, state.itemStats[recipe.output]])),
    market: {
      plans: state.procurementPlans.length,
      orders: state.demandOrders.length,
      contracts: state.shipmentContracts.length,
      deliveredContracts: state.shipmentContracts.filter((contract) => contract.status === "delivered").length,
      maxRouteCats: maxRoute,
      totalPasses,
    },
  },
};

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>猫咪工坊 ${h(difficultyLabel)} · 35 商品具体操作档案</title>
  <style>
    :root{color-scheme:light;--ink:#17221d;--muted:#66736c;--line:#dfe6e1;--paper:#fff;--soft:#f4f7f5;--green:#2e7d50;--gold:#a66b00;--blue:#286ea8;--red:#b1443e;--orange:#c46c1b}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f5f7f5;color:var(--ink);font:15px/1.65 system-ui,"Microsoft YaHei",sans-serif}main{width:min(1180px,calc(100% - 28px));margin:28px auto 80px}header,.section{background:var(--paper);border:1px solid var(--line);border-radius:18px;box-shadow:0 10px 28px rgba(22,36,29,.06)}header{padding:clamp(28px,5vw,58px)}.section{margin-top:18px;padding:clamp(22px,3vw,34px)}h1{max-width:900px;margin:8px 0 14px;font-size:clamp(34px,6vw,62px);line-height:1.08;letter-spacing:-.04em}h2{margin:0 0 18px;font-size:27px;line-height:1.2}h3{margin:25px 0 10px;font-size:19px}.lead{max-width:920px;color:var(--muted);font-size:18px}.badge,.chip,.stage{display:inline-flex;align-items:center;border-radius:999px;white-space:nowrap}.badge{padding:6px 11px;background:#eaf6ee;color:#22633e;font-size:12px;font-weight:800;letter-spacing:.06em}.chip{margin:2px 3px;padding:2px 8px;background:#eef3f0;border:1px solid #dfe7e2;font-size:12px}.toc{display:flex;flex-wrap:wrap;gap:8px;margin-top:24px}.toc a{padding:7px 11px;border:1px solid var(--line);border-radius:8px;color:#305c46;text-decoration:none;background:#fff}.toc a:hover{background:#eff7f2}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-top:24px}.metric{padding:16px;border:1px solid var(--line);border-radius:13px;background:var(--soft)}.metric strong{display:block;font-size:25px;line-height:1.2}.metric span{color:var(--muted);font-size:12px}.callout{padding:16px 18px;border-left:5px solid var(--gold);border-radius:9px;background:#fff8e6}.callout.red{border-left-color:var(--red);background:#fff1ef}.callout.green{border-left-color:var(--green);background:#edf8f1}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.card{padding:17px;border:1px solid var(--line);border-radius:13px;background:var(--soft)}.card strong{display:block;margin-bottom:5px;color:var(--green)}.flow{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.phase-card{position:relative;padding:20px;border:1px solid var(--line);border-radius:14px;background:#fff}.phase-card::after{content:"→";position:absolute;right:-20px;top:45%;z-index:2;color:#98a59d;font-size:22px}.phase-card:last-child::after{display:none}.phase-card .number{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#2e7d50;color:white;font-weight:800}.phase-card h3{margin:10px 0 6px}.phase-card p{margin:5px 0;color:var(--muted)}.timeline{position:relative;margin:8px 0 0 10px;padding-left:28px;border-left:2px solid #cdd8d1}.timeline article{position:relative;padding:2px 0 20px}.timeline article::before{content:"";position:absolute;left:-36px;top:8px;width:14px;height:14px;border:3px solid white;border-radius:50%;background:var(--green);box-shadow:0 0 0 2px var(--green)}.timeline time{font:700 13px ui-monospace,Consolas,monospace;color:var(--green)}.timeline h3{margin:2px 0}.timeline p{margin:2px 0;color:var(--muted)}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px}table{width:100%;border-collapse:collapse;background:white;font-size:13px}th,td{padding:9px 10px;border-bottom:1px solid #e7ece9;text-align:left;vertical-align:top}th{position:sticky;top:0;z-index:1;background:#f0f4f1;color:#315640;white-space:nowrap}tr:last-child td{border-bottom:0}tbody tr:hover{background:#f8fbf9}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.mono,code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.emoji{display:inline-block;min-width:28px;font-size:21px}td strong{display:block}small{display:block;color:var(--muted);font-size:11px}.stage{padding:2px 7px;font-size:11px;font-weight:700}.stage.setup{background:#f2efe8;color:#795b25}.stage.phase1{background:#eaf6ee;color:#236a41}.stage.phase2{background:#fff0e5;color:#9a4f14}.stage.phase3{background:#eaf2fb;color:#225f93}.controls{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}.controls button,.controls input{padding:8px 11px;border:1px solid #cad4ce;border-radius:8px;background:#fff;font:inherit}.controls button.active{color:#fff;background:#2e7d50;border-color:#2e7d50}.controls input{min-width:260px;flex:1}.code{padding:16px;border-radius:11px;background:#17241d;color:#edf6f0;overflow:auto}.world-map{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:13px;background:#fff}.parcel{stroke-width:2}.parcel-a{fill:#f1f3f2;stroke:#98a49d}.parcel-b{fill:#f4f8ef;stroke:#7d9d78}.grid-lines{stroke:#d9e0dc;stroke-width:1}.resource{fill:#fff;stroke:#8da69a;stroke-width:2}.resource-label,.building-label{text-anchor:middle;dominant-baseline:central;font-size:20px}.cat-dot{fill:#df8b39;stroke:#8c4e17;stroke-width:1.5}.cat-label{text-anchor:middle;dominant-baseline:central;fill:#fff;font:700 9px ui-monospace,Consolas,monospace}.building-dot{fill:#fff4d6;stroke:#b77800;stroke-width:3}.parcel-title{fill:#54635b;font:700 12px system-ui}.legend{display:flex;flex-wrap:wrap;gap:16px;margin-top:9px;color:var(--muted);font-size:12px}.dot{display:inline-block;width:12px;height:12px;margin-right:5px;border-radius:50%;vertical-align:-1px}.dot.cat{background:#df8b39}.dot.resource{background:#fff;border:2px solid #8da69a}.dot.building{background:#fff4d6;border:2px solid #b77800}.analysis-table td:first-child{font-weight:800;color:#315640}.checklist{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:9px;padding:0;list-style:none}.checklist li{padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:#f7faf8}.checklist li::before{content:"✓";margin-right:8px;color:var(--green);font-weight:900}details{margin-top:13px}summary{cursor:pointer;font-weight:800;color:#315640}footer{padding:24px 6px;color:var(--muted);text-align:center;font-size:12px}@media(max-width:760px){.flow{grid-template-columns:1fr}.phase-card::after{display:none}main{width:min(100% - 16px,1180px);margin-top:8px}.section,header{border-radius:12px;padding:20px}.controls input{min-width:100%}}@media print{body{background:#fff}main{width:100%;margin:0}.section,header{box-shadow:none;break-inside:avoid}.controls,.toc{display:none}details{display:block}details>summary{display:none}}
    .code{white-space:pre-wrap;overflow-wrap:anywhere}
  </style>
</head>
<body>
<main>
  <header>
    <span class="badge">猫咪工坊 0.12.3 · ${h(difficultyLabel)} · 确定性操作档案</span>
    <h1>${difficulty === 5 ? "最高难度 5" : h(difficultyLabel)}：35 商品具体怎么操作</h1>
    <p class="lead">这份档案由 <code>scripts/qa-35.mts</code> 的真实种子 ${seed}、${h(difficultyLabel)}运行生成。它逐条记录 ${operations.length} 条公开操作、费用、法规、坐标和模拟时间，并把最终订单、合同、运输与 35 项商品统计反向核对。第 16–19 项由净资产收益贪心自然完成，第 20 项工厂用单项 ×2 突破；第 22–26 项仅逐项 ×2 不能全部完成，必须用订单物流法组织留存、补料和逐格运输。</p>
    <div class="metrics">
      <div class="metric"><strong>${h(time(result.simTime))}</strong><span>最终检查时刻（模拟时间）</span></div>
      <div class="metric"><strong>${h(difficultyLabel)}</strong><span>本次真实运行档位</span></div>
      <div class="metric"><strong>${operations.length}</strong><span>完整操作记录</span></div>
      <div class="metric"><strong>${state.cats.length}</strong><span>最终猫咪工位（11 + ${placedCatCount}）</span></div>
      <div class="metric"><strong>${state.shipmentContracts.length}</strong><span>生成的运输合同</span></div>
      <div class="metric"><strong>${totalPasses.toLocaleString("zh-CN")}</strong><span>逐格实物传递次数</span></div>
      <div class="metric"><strong>${h(money(grossCostCents))}</strong><span>玩家操作毛支出</span></div>
    </div>
    <nav class="toc"><a href="#boundary">验收边界</a><a href="#replay">照着界面操作</a><a href="#stages">三阶段</a><a href="#timeline">关键时间线</a><a href="#laws">法规</a><a href="#space">空间建设</a><a href="#economy">经济与物流</a><a href="#items">35 项结果</a><a href="#ledger">完整账本</a></nav>
  </header>

  <section class="section" id="boundary">
    <h2>先说明边界：这是通关逻辑验收，不是正常开局财务挑战</h2>
    <div class="callout red"><strong>唯一的测试豁免：</strong>开局把国库设为 1,000,000,000 分，也就是 10,000,000.00 金币。${h(difficultyLabel)}正常新档只有 ${h(money(profile.initialTreasuryCents))}。这样做是为了隔离“钱够不够”，专门验证法规、订单、逐格物流、建筑市场和空间范围能否把真实物品链推到第 35 项。因此本局证明的是最高难度产业机制可通；正常存档照做时，需要先用高税率与等待销售补足每一步显示的国库费用。</div>
    ${difficulty === 5 ? `<div class="callout"><strong>最高难度差异：</strong>基础信用只有 ${h(money(profile.baseCreditCents))}，并启用复合工区和大宗配料。前 35 项中受大宗规则改变的配方为 ${bulkRecipes.map((recipe) => `<span class="chip">${h(item(recipe.output).emoji)} ${h(item(recipe.output).name)}：${h(formula(recipe))}</span>`).join(" ")}。报告中的配方列已经显示难度 5 的真实数量。</div>` : ""}
    <h3>运行中允许并实际调用的公开操作</h3>
    <ul class="checklist"><li>购买已经满足前置条件的配方</li><li>颁布或废止经过安全校验的法规</li><li>购买相邻 9×9 地块</li><li>在合法空位放置新猫</li><li>按猫咪报价收购工厂、天线和机床</li><li>从玩家建筑库把三栋设施放进同一复合工区</li><li>推进确定性模拟时钟</li></ul>
    <h3>没有做的事</h3>
    <ul class="checklist"><li>没有直接增加猫咪库存</li><li>没有直接标记商品发现</li><li>没有直接注入建筑或修改建筑范围</li><li>没有绕过配方购买与产业认证</li><li>没有让远方猫读取全局库存</li><li>没有取消实物的相邻猫逐跳运输</li></ul>
    <p class="callout"><strong>DeepSeek 说明：</strong>这次确定性回归没有访问真实 DeepSeek 网络接口，以免模型波动、超时或计费破坏可重复性。脚本把与模型合规输出相同的已验证 <code>LawDraft</code> 通过公开 <code>enactLaw()</code> 颁布。物流函数使用白名单中的 <code>orderCount()</code>、<code>bounty()</code>、<code>adjust()</code> 和 <code>choose()</code>；颁布后保持不变，长时间等待只检查合同、信用、路线和工区。换言之，本局验证“法规能否改变游戏”，不验证某次上游模型回答是否稳定。</p>
  </section>

  <section class="section" id="replay">
    <h2>照着游戏界面复现这次最高难度操作</h2>
    <div class="table-wrap"><table><thead><tr><th>顺序</th><th>界面位置</th><th>具体点击或输入</th><th>完成标志</th></tr></thead><tbody>
      <tr><td>1</td><td>顶栏难度</td><td>新档开始前选择“5 · 极限物流”并确认清档。</td><td>顶栏难度为 5；基础信用 50 金币。</td></tr>
      <tr><td>2</td><td>配方图</td><td>第 10 项线已免费解锁；只购买第 11–15 项：纸、工具、玻璃、金属、齿轮。</td><td>${h(time(result.phase1.completeAtMs))} 前 15 项均有制作记录。</td></tr>
      <tr><td>3</td><td>配方图</td><td>购买第 16–20 项，保持法条不变观察 300 模拟秒。</td><td>线缆、电池、化学品、底盘已经制作；工厂仍为 0 且悬赏开放。</td></tr>
      <tr><td>4</td><td>法典</td><td>输入“只把工厂价格提高到基础价的 2 倍”并颁布；工厂完成后，再输入“有开放订单时优先制作订单所需物品并留存关键中间品；磁铁到显示器按机械、电气、电子缺口补料”颁布行为法。</td><td>价格卡只显示工厂 ×2；行为法源码含 <code>orderCount / bounty / adjust / choose</code>。</td></tr>
      <tr><td>5</td><td>开拓</td><td>购买东侧地块 <code>(1,0)</code>，按“空间建设”表中的坐标补 ${placedCatCount} 只猫，保持上下左右连续。</td><td>广播虽全局可听，实物仍可沿相邻猫合同路线送达。</td></tr>
      <tr><td>6</td><td>仓库</td><td>等待并收购工厂、天线、机床报价；分别放到 ${h(buildingPositionSummary)}。</td><td>三栋设施共同覆盖至少一个高级制造工位。</td></tr>
      <tr><td>7</td><td>配方图 / 法典</td><td>工厂落成后购买第 28–35 项；不再给芯片、存储器、显示器逐项加价，让现行物流法按订单补给沙、化学品、线缆、芯片、玻璃和灯。</td><td>第 28–30 项靠工区条件与物流评分进入生产，不靠单品 ×2。</td></tr>
      <tr><td>8</td><td>猫咪 / 市场</td><td>长时间无新发现时不要继续改价或覆盖物流法；检查开放订单是否已成交、运输合同是否在途、目标猫信用是否足够，以及工厂/天线/机床覆盖是否正确。</td><td>本次只颁布两条法且零废止；其余等待都由真实合同与大宗配料生产消化。</td></tr>
      <tr><td>9</td><td>配方图 / 猫咪</td><td>检查车辆难度 5 配料为车轮×4、控制器×1、燃料×2，并确认制造猫同时在工厂和机床半径 2 内。</td><td>${h(time(result.simTime))} 时 35/35，车辆制作数 ${result.vehicle}。</td></tr>
    </tbody></table></div>
    <p class="callout green"><strong>怎样把测试操作换成正常存档：</strong>不要改物品、发现或建筑；只把“充足测试国库”替换成等待税收。每次以游戏按钮显示的当期费用为准，国库够了再执行下一条购买、颁布或废止。下方完整账本保留了本次 ${operations.length} 条操作及每笔费用。</p>
  </section>

  <section class="section" id="stages">
    <h2>三阶段操作与结果</h2>
    <div class="flow">
      <article class="phase-card"><span class="number">1</span><h3>白手起家到 15</h3><p>前 10 项自主生产，只买第 11–15 项五张配方，随后推进时间。</p><p><strong>${h(time(result.phase1.completeAtMs))}</strong> 前 15 项全部实际制造；没有改法、加猫、扩地或建筑。</p></article>
      <article class="phase-card"><span class="number">2</span><h3>自然推进到 19，工厂停滞</h3><p>买第 16–20 项，再原样观察 300 秒。</p><p>线缆、电池、化学品、底盘自然完成；只有工厂产量为 <strong>0</strong>。</p></article>
      <article class="phase-card"><span class="number">3</span><h3>价格突破 + 物流建设到 35</h3><p>工厂单项 ×2 后完成第 20 项；随后颁布订单物流法，购地，加 ${placedCatCount} 猫，收购并共同布置工厂、天线和机床。</p><p>车辆悬赏在 <strong>${h(time(vehicleClosure ? vehicleClosure.publishedAt * state.simulationSpeed : null))}</strong> 结案；全 35 项在 ${h(time(lastFirst35ClosureMs))} 前结案。</p></article>
    </div>
    <h3>配方购买批次</h3>
    <div class="table-wrap"><table><thead><tr><th>批次</th><th>时刻</th><th>商品</th><th>费用</th></tr></thead><tbody>${recipeGroupRows}</tbody></table></div>
  </section>

  <section class="section" id="timeline">
    <h2>关键时间线</h2>
    <div class="timeline">
      <article><time>00:00</time><h3>购买第 11–15 项</h3><p>第 10 项线属于开局免费配方；11 只猫和六个资源区保持原样，只用统一资产收益率、悬赏、局部递归自供给与有偿订单完成基础产业。</p></article>
      <article><time>${h(time(result.phase1.completeAtMs))}</time><h3>前 15 项完成；立即购买第 16–20 项</h3><p>继续保持法规、猫数、土地和建筑不变，开始 300 秒反事实观察。</p></article>
      <article><time>${h(time(result.phase1.completeAtMs + result.phase2.observedForMs))}</time><h3>确认工厂卡点并第一次干预</h3><p>只把工厂价格设为 ×2；工厂完成后颁布订单物流协调法，购买 21–27，再购买东侧地块并铺设相邻工位。</p></article>
      <article><time>${h(time(buildingOffer ? buildingOffer.createdAt * state.simulationSpeed : null))}</time><h3>猫咪首次制造并挂牌工厂</h3><p>${h(buildingOffer?.sellerCatId ?? "—")} 报价 ${h(money(buildingOffer?.askCents ?? 0))}；建筑仍是猫的商品，玩家尚未凭空拥有设施。</p></article>
      ${buildingTimeline}
      <article><time>${h(time(vehicleClosure ? vehicleClosure.publishedAt * state.simulationSpeed : null))}</time><h3>车辆出现</h3><p>${h(vehicleClosure?.sourceCatId ?? "—")} 在工厂与机床共同覆盖的工位完成车辆悬赏。</p></article>
      <article><time>${h(time(lastFirst35ClosureMs))}</time><h3>第 1–35 项悬赏全部结案</h3><p>脚本在下一次 30 秒检查点 ${h(time(result.simTime))} 确认 35/35。</p></article>
    </div>
  </section>

  <section class="section" id="laws">
    <h2>我颁布了哪些法规</h2>
    <div class="grid">
      <div class="card"><strong>${baseLogisticsLaws.length} 条基础物流法</strong>读取开放订单和未结悬赏；有订单时提高制作、降低无关外售，并对第 22–30 项所需机械、电气和电子中间品定向加权。</div>
      <div class="card"><strong>${qualificationPriceLaws.length} 条工厂价格法</strong>只把第 20 项工厂设为 ×2，把大型协作项目的预期盈余传给砖、齿轮、工具和玻璃作业；第 16–19 项无需调价。</div>
      <div class="card"><strong>0 条 22–30 单品价格法</strong>磁铁到显示器没有逐项 ×2，也没有用后续临时价格法疏堵；这些商品全部由订单、留存和补料评分完成。</div>
      <div class="card"><strong>高价会遇到现有信用瓶颈</strong>以车轮为反例：直接设为 ×2 时，配料作业报价合计 ${h(money(wheelX2JobBudget))}；×10 时按竞争强度凸性升至 ${h(money(wheelX10JobBudget))}。高价同步增加订单、保证金和信用占用。这仍不是禁令，有现金、净资产或现货的猫可以继续。</div>
      <div class="card"><strong>${enactmentCount} 次成功立法</strong>前 5 次免费，此后第 n 次为 <code>5×(n−5)</code> 金币；立法毛费用 ${h(money(costs.enact))}，废止次数为 ${repealCount}，废止费用 ${h(money(costs.repeal))}。</div>
    </div>
    <h3>基础物流法实际源码</h3>
    <pre class="code">${h(logisticsLaw?.sourceCode ?? "未找到基础物流法源码")}</pre>
    <p class="callout green"><strong>为什么它有效：</strong>所有已解锁悬赏都进入统一的资产收益率比较。第 22–30 项的价格溢价会按上游岗位竞争强度凸性传入已有配料订单，所以继续抬价也会更快提高保证金和信用占用。物流法把下一份计划转向真实订单和关键中间品；库存或在途货覆盖缺口后会撤销多余订单，因而直接减少待购作业。无合同传递、亏损制作和超额信用仍会被引擎拒绝。</p>
  </section>

  <section class="section" id="space">
    <h2>土地、猫链与复合工区</h2>
    <p>在 08:30 购买东侧相邻地块 <code>(1,0)</code>，费用 ${h(money(costs.parcel))}。随后从现有网络沿北、东、南、西的确定顺序找路到 <code>x≥5</code>，再补充运输链和工厂周边零件工位，共新增 ${placedCatCount} 只猫。下图数字是猫的创建序号；资源 emoji 是不可放猫的资源中心；三栋设施为 ${h(buildingPositionSummary)}。</p>
    ${mapSvg}
    <div class="legend"><span><i class="dot cat"></i>猫咪工位</span><span><i class="dot resource"></i>资源中心</span><span><i class="dot building"></i>玩家部署建筑</span></div>
    <details><summary>展开 ${placedCatCount} 只新增猫的完整坐标</summary><div class="table-wrap"><table><thead><tr><th>猫</th><th>坐标</th><th>目的</th></tr></thead><tbody>${catPlacementRows}</tbody></table></div></details>
    <div class="grid" style="margin-top:16px"><div class="card"><strong>为什么要加猫</strong>广播信息是全局的，但商品不是。每个合同仍锁定一条相邻猫 BFS 路线；多工位既增加生产并行度，也增加可承运段容量。</div><div class="card"><strong>为什么必须买三类设施</strong>第 28–35 项需要工厂半径 2；无线电还需要天线，机器人、制造机和车辆还需要机床。设施都先由猫制造并挂牌，玩家收购后才能转化为地面生产条件。</div><div class="card"><strong>为什么要共同覆盖</strong>放置器先找一只可制造高级商品的猫，再从其两格内选择三个合法普通空地。这样同一工位同时落在工厂、天线与机床范围内；资源中心、采集范围、猫位、未开拓地和已有建筑仍会被拒绝。</div></div>
  </section>

  <section class="section" id="economy">
    <h2>经济与市场结果</h2>
    <div class="metrics">
      <div class="metric"><strong>${h(money(costs.recipe))}</strong><span>第 11–35 项配方</span></div>
      <div class="metric"><strong>${h(money(costs.enact))}</strong><span>${enactmentCount} 次立法</span></div>
      <div class="metric"><strong>${h(money(costs.repeal))}</strong><span>${repealCount} 次废止</span></div>
      <div class="metric"><strong>${h(money(costs.parcel))}</strong><span>东侧土地</span></div>
      <div class="metric"><strong>${h(money(costs.building))}</strong><span>三项建筑收购</span></div>
      <div class="metric"><strong>${h(signedMoney(-netTreasurySpendCents))}</strong><span>税收回流后的国库净变化</span></div>
    </div>
    <p>玩家操作毛支出是 ${h(money(grossCostCents))}；运行期间约 ${h(money(operationInflowsCents))} 回流国库，主要来自现行 50% 外售税，所以最终国库相对测试起点变化 ${h(signedMoney(-netTreasurySpendCents))}。猫咪累计外售 ${h(money(state.totalSales))}，最终私人现金 ${h(money(totalCatCash))}、债务 ${h(money(totalDebt))}。</p>
    <div class="table-wrap"><table class="analysis-table"><thead><tr><th>阻塞</th><th>我观察到的证据</th><th>操作</th><th>因果机制</th></tr></thead><tbody>
      <tr><td>工厂协作收益不足</td><td>300 秒内第 16–19 项已完成，工厂 crafted=0、bountyOpen=true</td><td>只把工厂设为 ×2</td><td>大型项目把更多预期盈余传给四类上游作业，突破第 20 项而不改其他商品价格</td></tr>
      <tr><td>远方原料不能共享</td><td>最终 ${totalPasses.toLocaleString("zh-CN")} 次传递，最长合同路线 ${maxRoute} 只猫</td><td>加 ${placedCatCount} 只相邻猫</td><td>扩大 BFS 可达网络和中转承运容量，物品仍逐格移动</td></tr>
      <tr><td>28–35 缺生产位置</td><td>只有工厂时停在芯片等基础电子商品</td><td>等待三项报价，收购并布置复合工区</td><td>让同一工位同时获得工厂、天线与机床的半径 2 条件</td></tr>
      <tr><td>22–30 关键料分散且岗位竞争</td><td>机械、电气与电子悬赏同时开放；高价溢价按竞争强度凸性传入配料订单</td><td>按订单提高制作，磁铁到显示器分组补料</td><td>现货和在途货覆盖缺口后撤销多余订单；真实运输直接减少缺料作业，避免继续加价扩大保证金和信用占用</td></tr>
      <tr><td>中后期长时间等待</td><td>开放订单、在途合同和大宗配料会跨越多个 30 秒检查点</td><td>检查信用、路线和工区后保持两条法规不变</td><td>让已经成交的逐格合同自然结算，避免反复立法打断稳定的物流优先级</td></tr>
    </tbody></table></div>
    <h3>市场规模</h3>
    <div class="grid"><div class="card"><strong>${state.procurementPlans.length.toLocaleString("zh-CN")} 个生产计划</strong>包括悬赏、订单和外售计划；每只猫同时最多保留一个活动计划。</div><div class="card"><strong>${state.demandOrders.length.toLocaleString("zh-CN")} 张单件订单</strong>信息全局即时广播，但成交仍需检查库存、保证金、路线和运力。</div><div class="card"><strong>${state.shipmentContracts.filter((contract) => contract.status === "delivered").length.toLocaleString("zh-CN")} / ${state.shipmentContracts.length.toLocaleString("zh-CN")} 已送达</strong>验收停止时仍可能有少量无关的在途合同；它们不影响 35/35 条件。</div></div>
  </section>

  <section class="section" id="items">
    <h2>35 项商品逐项结果</h2>
    <p>“首次制作观测”按验收脚本每 30 秒检查一次，所以写作“≤时刻”；“悬赏结案”来自市场广播内部时间，精确到 5 模拟秒，并列出领取悬赏的来源猫。配方列采用${h(difficultyLabel)}的有效数量，而不是较低难度的基础数量。</p>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>商品</th><th>固定配方</th><th>首次制作观测</th><th>悬赏结案 / 猫</th><th>制作</th><th>传递</th><th>外售</th><th>外售收入</th></tr></thead><tbody>${itemRows}</tbody></table></div>
  </section>

  <section class="section" id="ledger">
    <h2>完整操作账本 · ${operations.length} 条</h2>
    <p>这里保留所有公开操作，包括每一次 30 秒确定性时钟推进。可以按阶段筛选或搜索商品、法规 ID、坐标与说明。</p>
    <div class="controls"><button class="active" data-filter="all">全部</button><button data-filter="setup">准备</button><button data-filter="phase1">阶段一</button><button data-filter="phase2">阶段二</button><button data-filter="phase3">阶段三</button><button data-kind="time-advance">只看时间推进</button><button data-kind="law-enact">只看立法</button><input id="ledger-search" type="search" placeholder="搜索商品、法规 ID、坐标或动作"></div>
    <div class="table-wrap"><table id="ledger-table"><thead><tr><th>序号</th><th>模拟时刻</th><th>阶段</th><th>操作</th><th>对象</th><th>细节</th><th>费用</th></tr></thead><tbody>${operationRows}</tbody></table></div>
  </section>

  <section class="section">
    <h2>结论与限制</h2>
    <div class="grid"><div class="card"><strong>通关不是靠全局调度器</strong>猫只读取自身和曼哈顿 2 内工位；全局广播只传需求信息。最终 ${totalPasses.toLocaleString("zh-CN")} 次逐格传递和最长 ${maxRoute} 猫路线证明实物没有瞬移。</div><div class="card"><strong>真正的三个钥匙</strong>工厂 ×2 只突破第 20 项；物流法和猫链组织有偿物理物流；共同覆盖的工厂、天线与机床打开 28–35 的空间制造条件。</div><div class="card"><strong>22–30 的软瓶颈</strong>玩家仍可自由 ×2 或 ×10；但溢价会凸性推高配料作业报价。现金和净资产足够时仍能硬顶，普通猫则需要先用物流减少缺料订单。</div><div class="card"><strong>车辆是复合工区产物</strong>车辆在 ${h(time(vehicleClosure ? vehicleClosure.publishedAt * state.simulationSpeed : null))} 出现；制造工位必须同时处于工厂和机床的曼哈顿半径 2 内。</div></div>
    <p class="callout"><strong>仍需区分：</strong>本页使用充足测试国库与确定性法条夹具。若要评价生产版经济平衡，还应另做“150 金币正常开局、只靠税收积累”的长时测试；若要评价 DeepSeek 可靠性，还应单独统计真实模型生成成功率、语义正确率和重试率。</p>
  </section>

  <footer>数据源：猫咪工坊 0.12.3 · ${h(difficultyLabel)} · scripts/qa-35.mts · worldSeed=${seed} · simulationSpeed=${state.simulationSpeed} · JSON 伴随记录：output/qa35-difficulty${difficulty}-seed${seed}-record.json</footer>
</main>
<script>
  const rows=[...document.querySelectorAll('#ledger-table tbody tr')];
  const stageButtons=[...document.querySelectorAll('[data-filter]')];
  const kindButtons=[...document.querySelectorAll('[data-kind]')];
  const search=document.querySelector('#ledger-search');
  let stage='all',kind='all';
  function refresh(){const query=search.value.trim().toLowerCase();for(const row of rows){const stageOk=stage==='all'||row.dataset.stage===stage;const kindOk=kind==='all'||row.dataset.kind===kind;const textOk=!query||row.textContent.toLowerCase().includes(query);row.hidden=!(stageOk&&kindOk&&textOk)}}
  for(const button of stageButtons)button.addEventListener('click',()=>{stage=button.dataset.filter;kind='all';stageButtons.forEach(b=>b.classList.toggle('active',b===button));kindButtons.forEach(b=>b.classList.remove('active'));refresh()});
  for(const button of kindButtons)button.addEventListener('click',()=>{kind=kind===button.dataset.kind?'all':button.dataset.kind;stage='all';stageButtons.forEach(b=>b.classList.toggle('active',b.dataset.filter==='all'));kindButtons.forEach(b=>b.classList.toggle('active',kind===b.dataset.kind));refresh()});
  search.addEventListener('input',refresh);
</script>
</body>
</html>`;

mkdirSync(resolve("output"), { recursive: true });
writeFileSync(outputPath, html, "utf8");
writeFileSync(jsonPath, `${JSON.stringify(tracePayload, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  outputPath,
  jsonPath,
  seed,
  passed: result.passed,
  simTimeMs: result.simTime,
  operations: operations.length,
  grossCostCents,
  netTreasurySpendCents,
  itemCount: first35.length,
}, null, 2)}\n`);
