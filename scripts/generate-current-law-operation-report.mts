import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInitialState } from "../src/game/engine";
import type { LawDraft } from "../src/game/types";
import { DEEPSEEK_ACCEPTANCE_CASES } from "./deepseek-to-35-cases.mjs";
import { fixtureDrafts } from "./deepseek-to-35-fixtures.mjs";

const root = resolve(process.cwd());
const artifactDirectory = join(root, "artifacts");
const currentArtifactName = "seed7-logistics30-v104-floors-before-rotation.json";
const currentArtifactPath = join(artifactDirectory, currentArtifactName);
const outputPath = join(root, "output", "CatWorkshop-Current-Law-and-Operation-Audit-2026-08-05.html");

type Json = Record<string, any>;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function coins(cents: number | null | undefined): string {
  return typeof cents === "number" ? `${(cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 金币` : "未记录";
}

function logicalTime(ms: number | null | undefined): string {
  if (typeof ms !== "number") return "未记录";
  const minutes = ms / 60_000;
  return minutes >= 60 ? `${(minutes / 60).toFixed(2)} 小时` : `${minutes.toFixed(2)} 分钟`;
}

function compactJson(value: unknown): string {
  return escapeHtml(JSON.stringify(value, null, 2));
}

const current = JSON.parse(readFileSync(currentArtifactPath, "utf8")) as Json;
const currentSeed = current.seedResults[0] as Json;
const currentStage = currentSeed.stages.at(-1) as Json;
const currentStability = currentStage.stability as Json;
const currentDetail = currentStage.detail as Json;
const drafts = fixtureDrafts();
const starterState = createInitialState({ worldSeed: 7, difficulty: 5, simulationSpeed: 5_000 });

const iterationNotes: Record<number, { change: string; outcome: string }> = {
  88: {
    change: "修订稳态轮换法：尝试用 machine_tool 缺口门控释放齿轮，并保持中心 chip/memory 轮换。",
    outcome: "爬坡 wheel=0、machine_tool=0；后查明旧 factory 计划占用 gear，但中心的 machine_tool 实际融资有限，法规顺序仍让 chip 底仓优先。",
  },
  89: {
    change: "把 machine_tool 缺口提升到全局门控，清退资源位上未承诺的 factory/wheel 计划，并把中心 machine_tool 放到 chip 底仓之前。",
    outcome: "wheel=4、machine_tool=29，证明 gear 已释放；memory=0，说明 60 秒二值门控会自我续期并饿死另一目标。",
  },
  90: {
    change: "中心不再使用二值顺序，改为在 machine_tool/chip/memory 中按 marketNeed 全局排名选择。",
    outcome: "23–30 本身达到节拍；完整 1–30 仅 lamp、antenna 各 2 次且只跨不足窗口，lamp 还消耗了历史库存。",
  },
  91: {
    change: "给 fuel 岗和 coolant 岗增加基于 recentCrafted=0 的 antenna/lamp 临时补位。",
    outcome: "补位过强：coolant=0，seed 7 的 fuel 也只产 1；该版本被否决。",
  },
  92: {
    change: "将中心、fuel/antenna、coolant/lamp 三组统一成一条 marketNeed 排名链。",
    outcome: "大部分目标恢复平衡，但 wheel 仅 1；递归融资诊断显示 chassis 无可用报价。",
  },
  93: {
    change: "去掉被怀疑的局部干旱门控，保留统一排名链作对照。",
    outcome: "结果与 v92 相同，证明当时 wheel 的主因不是该门控，而是 chassis 报价为 Infinity。",
  },
  94: {
    change: "物流/流量法新增 chassis 仓库下限，并尝试先公开收购一件 chassis。",
    outcome: "收购时市场还没有未预留 chassis，900,000ms 内无法成交；失败发生在法规冻结前。",
  },
  95: {
    change: "先颁布流量法，等猫新生产 chassis 后公开收购，再进入稳态轮换。",
    outcome: "chassis 与 wheel 均产 2 次，未达每项至少 3 次；plank 产 23/耗 27，库存 8→4，材料守恒失败。",
  },
  96: {
    change: "利用两件已公开收购的 plank 信号，按顺序先维持 plank≥2、再维持 chassis≥1。",
    outcome: "顺序条件形成优先级活锁，chassis 再次无可售现货，公开收购失败。",
  },
  97: {
    change: "把 plank 与 chassis 两个本地底仓条件改成相互独立。",
    outcome: "第一次出现 stableThrough=30，所有 1–30 商品满足次数和跨窗口节拍；但 tools 产14/耗19、lamp 产5/耗9，仍靠历史库存，严格验收不通过。",
  },
  98: {
    change: "为 tools 与 lamp 加入强 111M 级材料守恒修正。",
    outcome: "修正压倒市场：wheel=0，终端爬坡无法完成；未进入正式稳定观察。",
  },
  99: {
    change: "在 v98 上继续提高 wheel 优先级。",
    outcome: "wheel 仍为 0；说明分支捕获/旧门控仍覆盖新评分。",
  },
  100: {
    change: "修正 wheel 分支覆盖，使 wheel 在爬坡期产 8；保留强 tools/lamp 修正。",
    outcome: "正式观察三个窗口几乎全市场零产出；留下 gear/memory/chip/cable 嵌套计划链，fiber 1054/1072 且库存 20→2。",
  },
  101: {
    change: "回到较温和的 tools/lamp 1M 缺口反馈，保留 wheel 分支修正。",
    outcome: "已有嵌套计划相位仍令正式观察零产出；该组合不接受。",
  },
  102: {
    change: "恢复 v97 节奏，只保留温和缺口反馈；当时测试器仍要求爬坡中 23–30 每项至少 2 次。",
    outcome: "wheel=1，因额外爬坡门槛提前失败；该门槛不属于用户的稳定定义。",
  },
  103: {
    change: "删除额外的‘爬坡每项两次’门槛，允许进入正式三窗口观察。",
    outcome: "暴露 floors 颁布过晚：machine_tool 的 gear 订单链在底仓建立前锁死；lamp/wheel/machine_tool/chip/memory/display 未稳定。",
  },
  104: {
    change: "操作顺序改为：先完成公开仓库底仓与流量法，再颁布稳态轮换法；之后冻结操作。",
    outcome: "消除了长期冻结计划、订单、合同和悬赏；仍只有 lamp=1[1,0,0]、wheel=1[1,0,0]。lamp 产1/耗6、库存6→1；最终 lamp 全猫融资报价 Infinity，wheel 仅中心猫报价有限但未被岗位法规选中。",
  },
};

function versionNumber(file: string): number {
  return Number(file.match(/-v(\d+)/)?.[1] ?? 0);
}

const iterationFiles = readdirSync(artifactDirectory)
  .filter((file) => /^seed7-logistics30-v(?:8[8-9]|9\d|10[0-4]).*\.json$/.test(file))
  .sort((left, right) => versionNumber(left) - versionNumber(right));

const iterations = iterationFiles.map((file) => {
  const report = JSON.parse(readFileSync(join(artifactDirectory, file), "utf8")) as Json;
  const seed = report.seedResults?.[0] ?? {};
  const stage = seed.stages?.at(-1) ?? {};
  const stability = stage.stability;
  const version = versionNumber(file);
  const activeFixtureLaws = (seed.final?.laws ?? [])
    .filter((law: Json) => law.status === "active" && String(law.title).startsWith("固定夹具"));
  const unstable = stability?.itemEvidence?.filter((item: Json) => !item.stable) ?? [];
  const materials = stability?.materialCoverage?.filter((item: Json) => !item.passed) ?? [];
  const rampMatch = String(report.fatalError ?? "").match(/targetCraftDelta\":(\{[^}]+\})/);
  let ramp: Json | null = stage.detail?.terminalAutonomousRamp?.targetCraftDelta ?? null;
  if (!ramp && rampMatch) {
    try { ramp = JSON.parse(rampMatch[1]); } catch { ramp = null; }
  }
  return {
    version,
    file,
    passed: Boolean(report.passed),
    stableThrough: stability?.stableThrough ?? null,
    failureReasons: stability?.failureReasons ?? [],
    unstable,
    materials,
    ramp,
    hashes: activeFixtureLaws.map((law: Json) => law.astHash).filter(Boolean),
    note: iterationNotes[version],
  };
});

const enactedFixtureIds = [
  "selective-factory-ramp",
  "water-capitalization",
  "selective-price-to-22",
  "terminal-discipline-23-30",
  "logistics-22-30",
  "rotation-capitalization",
  "flow-balance-1-30",
  "stable-rotation-23-30",
] as const;

const notEnactedInV104 = ["global-x2", "items-22-30-x2", "global-x10", "adaptive-price-only", "advanced-31-35"];

const publicFloors: Array<{ label: string; records: Json[] }> = [
  ["plank 木板", currentDetail.plankWarehouseFloorPurchases],
  ["ore 矿石", currentDetail.oreWarehouseFloorPurchases],
  ["water 水", currentDetail.waterWarehouseFloorPurchases],
  ["fire 炉火", [currentDetail.fireWarehouseFloorPurchase]],
  ["metal 金属", currentDetail.metalWarehouseFloorPurchases],
  ["tools 工具", [currentDetail.toolsWarehouseFloorPurchase]],
  ["gear 齿轮", currentDetail.gearWarehouseFloorPurchases],
  ["cable 线缆", currentDetail.cableWarehouseFloorPurchases],
  ["glass 玻璃", [currentDetail.glassWarehouseFloorPurchase]],
  ["lamp 灯", [currentDetail.lampWarehouseFloorPurchase]],
  ["chassis 底盘", [currentDetail.chassisWarehouseFloorPurchase]],
].map(([label, records]) => ({ label: String(label), records: (records as Json[]).filter(Boolean) }));

function lawDetails(id: string, draft: LawDraft): string {
  const testCase = DEEPSEEK_ACCEPTANCE_CASES.find((entry) => entry.id === id);
  return `<details class="law" id="law-${escapeHtml(id)}">
    <summary><span>${escapeHtml(draft.title)}</span><code>${escapeHtml(draft.astHash)}</code></summary>
    <div class="law-grid">
      <div><b>用途</b><p>${escapeHtml(testCase?.purpose ?? draft.summary)}</p></div>
      <div><b>来源</b><p>固定响应夹具；本轮没有调用真实 DeepSeek。</p></div>
      <div><b>验证</b><p>${draft.validation.examplesPassed}/${draft.validation.examplesTotal} 样例，语法 ${draft.validation.syntax ? "通过" : "失败"}，安全 ${draft.validation.safety ? "通过" : "失败"}</p></div>
      <div><b>规模</b><p>${Buffer.byteLength(draft.sourceCode, "utf8").toLocaleString("zh-CN")} 字节，${draft.sourceCode.split(/\r?\n/).length} 行</p></div>
    </div>
    <h4>玩家提示词</h4><pre class="prompt">${escapeHtml(testCase?.playerText ?? draft.playerText)}</pre>
    <h4>本次 v104 实际颁布源码</h4><pre><code>${escapeHtml(draft.sourceCode)}</code></pre>
  </details>`;
}

const stageRows = currentSeed.stages.map((stage: Json, index: number) => {
  const stability = stage.stability;
  const result = stability
    ? `${stability.passed ? "通过" : "失败"}；stableThrough=${stability.stableThrough}${stability.failureReasons?.length ? `；${stability.failureReasons.join("；")}` : ""}`
    : stage.passed ? "阶段目标通过，未执行稳态观察" : "失败";
  return `<tr><td>${index + 1}</td><td>${escapeHtml(stage.name)}</td><td>${logicalTime(stage.simulatedElapsedMs)}</td><td>${coins(stage.treasuryStartCents)} → ${coins(stage.treasuryEndCents)}</td><td>${escapeHtml(result)}</td></tr>`;
}).join("");

const operationRows = [
  ["0", "新档初始化", "载入 7 条不可见于模型调用的预制法规；11 只猫、seed=7、难度5、5000×确定性加速。", "无玩家交易。"],
  ["1", "冻结操作观察 1–10", "不新增法规。", "等待首次完成前10项，再清零统计基线并观察三窗口；通过，且第11项整个观察期为0。"],
  ["2", "购买图纸 11–15", "不新增法规。", "逐项调用公开 buyRecipe；不改库存。随后冻结操作并观察；前15项稳定通过。"],
  ["3", "购买图纸 16–20", "不新增法规。", "fundAndBuyRange 会在国库不足时公开买入猫商品并立即按仓库价转售以筹资；精确逐笔数未被失败快照保留。前19稳定；第20仅首次制作1次，窗口[1,0,0]。"],
  ["4", "工厂价格爬坡", "颁布 selective-factory-ramp。", "推进并允许公开套利交易，直到 factory 首次出现。"],
  ["5", "水资源猫资本化", "颁布 water-capitalization。", "从水资源猫公开买入并立即转售 water 共15件；同时执行少量普通公开套利。"],
  ["6", "切换至 22 阶段法规", "废止 selective-factory-ramp 与 water-capitalization；颁布 selective-price-to-22。", "购买图纸21–22，允许公开交易筹资；前22项严格稳定通过。"],
  ["7", "收购并部署工厂", "法规不变。", "通过猫的公开建筑报价收购一座 factory，并放置在(-1,0)。"],
  ["8", "准备 23–30 主路径", "颁布 terminal-discipline-23-30、logistics-22-30。", "公开收购 cable 两件作为仓库下限信号；随后逐项筹资购买23–30图纸并等待每项首次制作。"],
  ["9", "责任猫资本化", "临时以最高优先级颁布 rotation-capitalization。", "公开买入并立即转售 memory、wheel、factory、factory 各1件，分别给责任猫现金；之后废止该临时法。"],
  ["10", "建立公开仓库下限", "颁布 flow-balance-1-30。", "依次公开买入 plank×2、ore×2、water×2、fire×1、metal×2、tools×1、gear×3、glass×1、lamp×1；随后等新 chassis 出现并公开买入×1。仓库品不进入猫库存或自主制作统计。"],
  ["11", "冻结前终端轮换", "最后颁布 stable-rotation-23-30。", `在 3,600,000ms 逻辑爬坡中执行 1,717 次普通买入再转售和 7 次责任猫终端品买入再转售；目标增量 ${JSON.stringify(currentDetail.terminalRotationRamp.targetCraftDelta)}。`],
  ["12", "纯自主爬坡", "法规不变。", `再推进 7,200,000ms，不交易；23–30 增量 ${JSON.stringify(currentDetail.terminalAutonomousRamp.targetCraftDelta)}。`],
  ["13", "正式稳态观察", "冻结全部法规、价格和玩家操作。", "观察 5,400,000ms，分三个等长窗口。lamp 与 wheel 各仅1次且都为[1,0,0]；lamp 产1耗6，库存6→1。"],
].map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("");

const iterationRows = iterations.map((entry) => {
  const unstable = entry.unstable.length
    ? entry.unstable.map((item: Json) => `${item.itemId}=${item.craftedDuringObservation}[${item.windowCrafts.join("/")}]`).join("；")
    : "无逐项窗口失败记录";
  const materials = entry.materials.length
    ? entry.materials.map((item: Json) => `${item.itemId} 产${item.crafted}/耗${item.consumed}，库存${item.stockStart}→${item.stockEnd}`).join("；")
    : "无材料缺口记录";
  return `<tr>
    <td>v${entry.version}</td>
    <td>${escapeHtml(entry.note?.change ?? "现有工件没有保存变更说明")}</td>
    <td>${escapeHtml(entry.note?.outcome ?? "见原始工件")}</td>
    <td>${entry.stableThrough === null ? "未进入正式观察" : entry.stableThrough}</td>
    <td>${escapeHtml(unstable)}<br><span class="muted">${escapeHtml(materials)}</span></td>
    <td>${entry.hashes.map((hash: string) => `<code>${escapeHtml(hash)}</code>`).join(" ") || "—"}</td>
    <td><code>${escapeHtml(entry.file)}</code></td>
  </tr>`;
}).join("");

const floorRows = publicFloors.map(({ label, records }) => `<tr>
  <td>${escapeHtml(label)}</td><td>${records.length}</td>
  <td>${records.map((record) => `${escapeHtml(record.catId)}：${coins(record.costCents)}，购后仓库=${record.warehouseQuantity}`).join("<br>")}</td>
</tr>`).join("");

const starterLaws = starterState.laws.map((law) => `<details class="law">
  <summary><span>${escapeHtml(law.title)}</span><code>${escapeHtml(law.astHash)}</code></summary>
  <div class="law-grid"><div><b>ID</b><p><code>${escapeHtml(law.id)}</code></p></div><div><b>说明</b><p>${escapeHtml(law.playerText)}</p></div></div>
  <h4>摘要</h4><p>${escapeHtml(law.summary)}</p>
  <h4>预制源码</h4><pre><code>${escapeHtml(law.sourceCode)}</code></pre>
</details>`).join("");

const enactedLaws = enactedFixtureIds.map((id) => lawDetails(id, drafts[id])).join("");
const candidateLaws = notEnactedInV104.map((id) => lawDetails(id, drafts[id])).join("");
const failedEvidence = currentStability.itemEvidence.filter((item: Json) => !item.stable);

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>猫咪工坊：截至 v104 的法规与玩家操作审计</title>
  <style>
    :root { color-scheme: light; --ink:#1d1f1c; --muted:#666b66; --line:#d9ddd8; --soft:#f5f6f4; --good:#167447; --bad:#b42318; --warn:#9a6700; --accent:#245c3b; }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; background:#fff; color:var(--ink); font:15px/1.65 "Segoe UI","Microsoft YaHei",sans-serif; letter-spacing:0; }
    header, main, footer { width:min(1460px, calc(100% - 40px)); margin:auto; }
    header { padding:46px 0 26px; border-bottom:1px solid var(--line); }
    h1 { margin:0 0 10px; font-size:32px; font-weight:750; }
    h2 { margin:44px 0 14px; font-size:23px; border-bottom:1px solid var(--line); padding-bottom:8px; }
    h3 { margin:28px 0 10px; font-size:18px; }
    h4 { margin:18px 0 7px; }
    p { margin:7px 0 12px; }
    a { color:var(--accent); }
    code { font-family:"Cascadia Code",Consolas,monospace; font-size:.9em; }
    p > code, li > code { overflow-wrap:anywhere; word-break:break-all; }
    pre { max-height:520px; overflow:auto; margin:8px 0 18px; padding:14px; background:#f7f8f7; border:1px solid var(--line); border-radius:4px; white-space:pre-wrap; overflow-wrap:anywhere; }
    pre.prompt { max-height:360px; background:#fff; }
    .lede { max-width:980px; color:var(--muted); font-size:17px; }
    .status { display:inline-block; padding:4px 9px; border:1px solid #efb0aa; color:var(--bad); background:#fff5f4; border-radius:4px; font-weight:700; }
    .grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin:18px 0; }
    .metric { border:1px solid var(--line); padding:14px; min-height:102px; }
    .metric b { display:block; font-size:22px; }
    .metric span { color:var(--muted); }
    .callout { border-left:4px solid var(--warn); background:#fffaf0; padding:12px 15px; margin:15px 0; }
    .good { color:var(--good); } .bad { color:var(--bad); } .warn { color:var(--warn); } .muted { color:var(--muted); }
    nav { display:flex; flex-wrap:wrap; gap:8px 16px; margin-top:18px; }
    table { width:100%; border-collapse:collapse; margin:10px 0 22px; font-size:13px; }
    th, td { border:1px solid var(--line); padding:8px 9px; text-align:left; vertical-align:top; }
    th { background:var(--soft); position:sticky; top:0; z-index:1; }
    tr:nth-child(even) td { background:#fbfcfb; }
    details.law { border:1px solid var(--line); margin:9px 0; }
    details.law > summary { cursor:pointer; padding:12px 14px; display:flex; justify-content:space-between; gap:14px; background:var(--soft); font-weight:650; }
    details.law > :not(summary) { margin-left:14px; margin-right:14px; }
    .law-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-top:14px; }
    .law-grid > div { border-bottom:1px solid var(--line); }
    .definition { display:grid; grid-template-columns:180px 1fr; border-top:1px solid var(--line); }
    .definition > * { padding:9px; border-bottom:1px solid var(--line); }
    footer { margin-top:50px; padding:20px 0 40px; border-top:1px solid var(--line); color:var(--muted); }
    @media (max-width:900px) { .grid,.law-grid { grid-template-columns:1fr 1fr; } table { display:block; overflow:auto; } }
    @media (max-width:560px) { header,main,footer { width:min(100% - 22px,1460px); } .grid,.law-grid { grid-template-columns:1fr; } h1 { font-size:25px; } }
    @media print { nav { display:none; } details.law > pre { max-height:none; } }
  </style>
</head>
<body>
<header>
  <span class="status">已停止继续模拟 · 当前验收未通过</span>
  <h1>猫咪工坊：截至 v104 的法规与玩家操作审计</h1>
  <p class="lede">这份报告逐项记录当前严格验收路径中颁布、废止的法规，公开玩家操作，v88–v104 每轮改动与结果，以及仍未解决的失败。报告不把首次制作或重复制作写成稳定制作，也不把固定夹具冒充为真实 DeepSeek 返回。</p>
  <nav><a href="#conclusion">当前结论</a><a href="#definitions">判定口径</a><a href="#stages">阶段结果</a><a href="#operations">操作流水</a><a href="#iterations">v88–v104</a><a href="#laws">法规原文</a><a href="#limitations">审计边界</a></nav>
</header>
<main>
  <section id="conclusion">
    <h2>当前结论</h2>
    <div class="grid">
      <div class="metric"><b class="good">稳定 1–10</b><span>不操作；第11项观察期为0</span></div>
      <div class="metric"><b class="good">稳定 1–15</b><span>购买11–15图纸后</span></div>
      <div class="metric"><b class="good">仅稳定到 19</b><span>第20项仅首次制作1次</span></div>
      <div class="metric"><b class="good">稳定 1–22</b><span>选择性价格/评分法规后</span></div>
      <div class="metric"><b class="bad">v104 稳定到 20</b><span>lamp、wheel 未稳定</span></div>
      <div class="metric"><b class="warn">v97 节拍到 30</b><span>但 tools/lamp 材料守恒失败</span></div>
      <div class="metric"><b class="bad">35 未执行</b><span>30 的严格门槛尚未通过</span></div>
      <div class="metric"><b>${escapeHtml(currentSeed.antiCheat.sharedBehaviorHash)}</b><span>共享行为与运行时哈希未变</span></div>
    </div>
    <div class="callout"><b>停止点：</b>v104 已完成首次制作到第30项，但正式观察中 lamp 与 wheel 各只制作1次，窗口均为 <code>[1,0,0]</code>；lamp 同期只产1、消耗6，库存从6降到1。没有长期冻结的订单、悬赏、合同或计划，但仍不满足稳定制作定义。</div>
    <p>v104 的全猫机会诊断显示：lamp 的清算收益为正，但每只猫的完整采购资本都是 <code>Infinity</code>；wheel 在中心猫处有有限报价（所需 28.32 金币），其他岗位为 <code>Infinity</code>。因此当前是两个不同问题：lamp 缺完整供应报价链，wheel 则有可融资候选却没有被岗位评分选中。</p>
  </section>

  <section id="definitions">
    <h2>判定口径</h2>
    <div class="definition"><b>首次制作</b><span>观察期内至少1次，只表示做出来过。</span><b>重复制作</b><span>至少3次，但尚未满足跨窗口与守恒。</span><b>稳定制作</b><span>每项至少3次；3个窗口中至少2个有产出；最后窗口仍有目标产出；总产量不连续两个窗口下降超过50%；市场无长期冻结；关键原料不能靠历史库存透支；观察期内法规和玩家操作冻结。</span></div>
    <p>公开买入的商品记录在玩家仓库来源账本中，不进入猫库存，也不计入猫自主制作统计。公开买入后立刻转售只用于把国库资金通过真实交易交给卖猫，仍会重置正式稳定观察起点。</p>
  </section>

  <section id="stages">
    <h2>v104 阶段结果</h2>
    <table><thead><tr><th>#</th><th>阶段</th><th>逻辑耗时</th><th>国库</th><th>结果</th></tr></thead><tbody>${stageRows}</tbody></table>
    <h3>正式观察失败项</h3>
    <table><thead><tr><th>商品</th><th>观察期新增</th><th>三个窗口</th><th>活跃窗口</th><th>分类</th></tr></thead><tbody>${failedEvidence.map((item: Json) => `<tr><td>${escapeHtml(item.itemId)}</td><td>${item.craftedDuringObservation}</td><td>${escapeHtml(item.windowCrafts.join(" / "))}</td><td>${item.activeWindows}</td><td>${escapeHtml(item.classification)}</td></tr>`).join("")}</tbody></table>
    <h3>严格材料守恒失败</h3>
    <pre>${compactJson(currentStability.materialCoverage.filter((item: Json) => !item.passed))}</pre>
  </section>

  <section id="operations">
    <h2>v104 玩家操作与法规流水</h2>
    <p>下表按测试器真实执行顺序整理。凡是循环公开套利而失败快照没有逐笔保留的地方，明确以“算法/聚合数”记录，不伪造逐笔交易。</p>
    <table><thead><tr><th>序号</th><th>操作阶段</th><th>法规变更</th><th>玩家操作与效果</th></tr></thead><tbody>${operationRows}</tbody></table>
    <h3>公开仓库下限的逐笔收购</h3>
    <table><thead><tr><th>商品</th><th>次数</th><th>卖猫、成交价与购后仓库数量</th></tr></thead><tbody>${floorRows}</tbody></table>
    <h3>责任猫资本化交易</h3>
    <table><thead><tr><th>卖猫</th><th>商品</th><th>买入价</th><th>仓库转售价</th></tr></thead><tbody>${currentDetail.terminalCapitalizationTrades.map((trade: Json) => `<tr><td>${escapeHtml(trade.catId)}</td><td>${escapeHtml(trade.itemId)}</td><td>${coins(trade.costCents)}</td><td>${coins(trade.warehouseRevenueCents)}</td></tr>`).join("")}</tbody></table>
  </section>

  <section id="iterations">
    <h2>v88–v104 每轮法规修订与效果</h2>
    <p>这些版本都使用 seed 7、难度5和 5000×确定性加速。每轮只修订法规固定响应或公开操作顺序；没有修改共享行为、配方、价格表、猫库存、建筑或世界状态。历史工件没有嵌入逐字源码，所以本表提供当时保存的法规哈希、修订含义和结果；当前 v104 的逐字源码在下一节。</p>
    <table><thead><tr><th>版本</th><th>本轮法规/操作改动</th><th>实际效果</th><th>stableThrough</th><th>严格失败证据</th><th>活跃夹具哈希</th><th>原始工件</th></tr></thead><tbody>${iterationRows}</tbody></table>
  </section>

  <section id="deepseek">
    <h2>DeepSeek 调用状态</h2>
    <p><b>v88–v104 共 0 次真实 DeepSeek API 调用。</b>所有工件的 <code>sourceMode</code> 都是 <code>fixture</code>，模型字段为 <code>fixed-ci-fixture</code>。固定响应仍经过与在线草案相同的 AST、安全、样例和哈希校验，但它不是模型网络返回。</p>
    <p>此前单独的“80×2 创意/提示注入可用性测试”调用过官方端点和本地 8318 端点；它只做编译与沙箱审计，没有把任何法规颁布进本次游戏存档，也没有参与 v104 的生产结果。因此本报告不把那 160 组响应列入玩家操作流水。</p>
  </section>

  <section id="laws">
    <h2>法规原文</h2>
    <h3>新档自带的 7 条法规</h3>
    <p>以下源码来自当前新档 seed 7。它们从开局起一直存在；v104 没有修改共享行为文件。</p>
    ${starterLaws}
    <h3>v104 路径实际颁布过的 8 条法规</h3>
    <p>其中工厂爬坡法、水资本化法和责任猫资本化法在完成任务后已废止；其余按上文顺序保持或参与最终状态。</p>
    ${enactedLaws}
    <h3>已编译但 v104 没有颁布的候选法规</h3>
    <p>四条纯价格负对照因为本次命令使用 <code>--skip-branches</code> 没有重跑；advanced-31-35 因第30项严格验收未通过而没有颁布。</p>
    ${candidateLaws}
  </section>

  <section id="limitations">
    <h2>审计边界与未完成事项</h2>
    <ul>
      <li>v104 失败快照的 <code>commandAudit</code> 最终只保留最后一条 <code>advance-time</code>；因此图纸筹资阶段和 1,717 次普通套利的逐笔猫/商品明细无法从现有工件恢复。报告保留测试器算法、聚合次数和所有专门底仓收购明细。</li>
      <li>v88–v103 工件保存了活跃法规哈希和失败状态，没有保存每一版逐字法规源码。逐字源码只对当前 v104 给出。</li>
      <li>四个纯价格负分支没有在 v104 重跑；不能用旧结果冒充当前法规哈希下的新验收。</li>
      <li>seed 1、7、91 的同法复验尚未开始；第31–35项、真实 DeepSeek 编译、浏览器/Playwright 和最终 HTML 验收均未开始。</li>
      <li>当前未解决：lamp 的递归完整报价为 Infinity；wheel 的有限候选与岗位法规错配。用户要求停止后没有继续修改或运行。</li>
    </ul>
    <h3>可复核文件</h3>
    <p><code>${escapeHtml(currentArtifactPath)}</code></p>
    <p><code>${escapeHtml(join(root, "scripts", "qa-deepseek-to-35-headless.mts"))}</code></p>
    <p><code>${escapeHtml(join(root, "scripts", "deepseek-to-35-fixtures.mts"))}</code></p>
    <p><code>${escapeHtml(join(root, "scripts", "deepseek-to-35-cases.mts"))}</code></p>
  </section>
</main>
<footer>生成时间：${escapeHtml(new Date().toISOString())} · 数据工件：${escapeHtml(basename(currentArtifactPath))} · 结论：停止于 v104，严格 30/35 验收未通过。</footer>
</body>
</html>`;

writeFileSync(outputPath, html, "utf8");
process.stdout.write(`${JSON.stringify({ output: outputPath, bytes: Buffer.byteLength(html, "utf8"), iterations: iterations.length, starterLaws: starterState.laws.length, enactedFixtureLaws: enactedFixtureIds.length })}\n`);
