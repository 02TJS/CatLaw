import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

type Json = Record<string, any>;

const escapeHtml = (value: unknown) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const formatDuration = (milliseconds: number | null | undefined) => {
  if (!Number.isFinite(milliseconds)) return "-";
  const ms = Number(milliseconds);
  if (ms < 1_000) return `${ms.toFixed(0)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(2)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(2)} min`;
  return `${(ms / 3_600_000).toFixed(2)} h`;
};

async function optionalJson(path: string): Promise<Json | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

const report = JSON.parse(await readFile("output/deepseek-to-35-headless.json", "utf8")) as Json;
const liveAudit = await optionalJson("output/deepseek-to-35-live.json");
const browserAudit = await optionalJson("output/deepseek-to-35-browser.json");
const seedOne = report.seedResults?.find((entry: Json) => entry.seed === 1) ?? report.seedResults?.[0] ?? {};
const stages: Json[] = seedOne.stages ?? [];
const items: Json[] = seedOne.craftedItems ?? [];
const ledger: Json[] = seedOne.playerLedger ?? seedOne.antiCheat?.publicPlayerCommands ?? [];
const apiResults: Json[] = liveAudit?.results ?? [];
let commit = "unavailable";
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  // The report remains usable outside a Git checkout.
}

const passed = report.passed === true;
const target = report.target ?? 35;
const finalThrough = seedOne.final?.craftedThrough ?? 0;
const totalLogicalMs = seedOne.final?.simulatedMs ?? stages.reduce((sum, stage) => sum + (stage.timing?.logicalSimulatedMs ?? stage.simulatedElapsedMs ?? 0), 0);
const totalEngineClockMs = totalLogicalMs / (report.simulationSpeed || 1);
const totalMeasuredAcceleration = report.wallClockMs > 0 ? Math.round((totalLogicalMs / report.wallClockMs) * 100) / 100 : null;
const timingRows = stages.map((stage) => `
  <tr>
    <td>${escapeHtml(stage.name)}</td>
    <td><span class="tag ${stage.passed ? "pass" : "fail"}">${stage.passed ? "通过" : "未通过"}</span></td>
    <td>${formatDuration(stage.timing?.logicalSimulatedMs ?? stage.simulatedElapsedMs)}</td>
    <td>${formatDuration(stage.timing?.engineClockAdvancedMs)}</td>
    <td>${formatDuration(stage.timing?.theoreticalRealtimeAt1xMs)}</td>
    <td>${formatDuration(stage.timing?.measuredWallClockMs ?? stage.wallClockMs)}</td>
    <td>${stage.timing?.effectiveWallClockAcceleration ?? "-"}x</td>
    <td>${stage.craftedThroughStart ?? 0} → ${stage.craftedThroughEnd ?? 0}</td>
  </tr>`).join("");

const probeSections = stages.flatMap((stage) => {
  const probe = stage.stability?.demandProbe;
  if (!probe) return [];
  const rows = probe.entries.map((entry: Json) => `
    <tr><td>${escapeHtml(entry.itemId)}</td><td>${entry.requested}</td><td>${entry.purchasedAndSold}</td><td>${entry.skipped ? "建筑商品" : "普通商品"}</td></tr>`).join("");
  return [`<details><summary>${escapeHtml(stage.name)}：需求探针，墙钟 ${formatDuration(probe.measuredWallClockMs)}</summary>
    <p>国库 ${probe.treasuryStartCents} → ${probe.treasuryEndCents} 分币。实际买走 N 件时，该项至少补产 N 件，并在 min(2,N) 个窗口出现；买不到时仍要求 3 件/2 窗。</p>
    <table><thead><tr><th>商品</th><th>请求</th><th>实际收购并售出</th><th>类型</th></tr></thead><tbody>${rows}</tbody></table>
  </details>`];
}).join("");

const itemRows = Array.from({ length: 35 }, (_, index) => {
  const item = items.find((entry) => entry.index === index + 1) ?? {};
  const crafted = item.crafted ?? 0;
  return `<tr><td>${index + 1}</td><td>${escapeHtml(item.itemId ?? "未记录")}</td><td>${crafted}</td><td>${crafted > 0 ? "至少首作" : "未制作"}</td></tr>`;
}).join("");

const apiRows = apiResults.length ? apiResults.map((entry, index) => `
  <tr><td>${index + 1}</td><td>${escapeHtml(entry.id ?? entry.purpose ?? "unknown")}</td><td>${entry.passed ? "正确" : "失败"}</td><td>${entry.httpStatus ?? entry.status ?? "-"}</td><td>${formatDuration(entry.durationMs ?? entry.wallClockMs)}</td><td>${escapeHtml(entry.model ?? report.model)}</td><td>${escapeHtml(entry.retryCount ?? entry.retries ?? 0)}</td></tr>`).join("")
  : `<tr><td colspan="7">本次使用固定夹具，真实 DeepSeek API 调用为 0；没有把历史调用记入本次验收。</td></tr>`;

const apiDetails = apiResults.length ? apiResults.map((entry, index) => `
  <details><summary>#${index + 1} ${escapeHtml(entry.id ?? entry.purpose ?? "unknown")} · ${entry.passed ? "校验通过" : "校验失败"}</summary>
    <p><strong>玩家提示词：</strong>${escapeHtml(entry.playerPrompt ?? "-")}</p>
    <p><strong>校验结果：</strong>${escapeHtml((entry.validationFailures ?? []).join("；") || "全部通过")}</p>
    <h3>脱敏编译请求</h3><pre>${escapeHtml(JSON.stringify(entry.compileRequest ?? null, null, 2))}</pre>
    <h3>模型返回与解析法规</h3><pre>${escapeHtml(JSON.stringify(entry.responseBody ?? entry.parsedDraft ?? null, null, 2))}</pre>
  </details>`).join("")
  : `<p class="note">本次为固定夹具运行，API 调用次数为 0。真实 API 的提示词、返回、耗时和重试只会来自同一次 <code>npm run test:deepseek:live</code> 生成的审计文件。</p>`;

const commandCounts = Object.entries(ledger.reduce((counts: Record<string, number>, entry: Json) => {
  counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  return counts;
}, {})).map(([kind, count]) => `<tr><td>${escapeHtml(kind)}</td><td>${count}</td></tr>`).join("");

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek → 35 稳态验收报告</title>
<style>
:root{font-family:Inter,"Microsoft YaHei",system-ui,sans-serif;color:#172126;background:#eef2f0}*{box-sizing:border-box}body{margin:0}main{max-width:1240px;margin:auto;background:#fff;min-height:100vh;padding:36px}h1{font-size:32px;margin:0 0 8px;letter-spacing:0}h2{font-size:21px;margin:34px 0 12px;border-bottom:2px solid #d9e2dd;padding-bottom:8px}p{line-height:1.7}.status{padding:18px 20px;border-left:6px solid ${passed ? "#16835f" : "#b43b35"};background:${passed ? "#edf8f3" : "#fff1f0"};margin:20px 0}.status strong{font-size:25px;color:${passed ? "#126b4f" : "#942e2a"}}.metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}.metric{border:1px solid #d9e2dd;padding:12px;background:#f8faf9}.metric b{display:block;font-size:20px}.metric span{font-size:12px;color:#5c6b64}table{width:100%;border-collapse:collapse;font-size:13px}th,td{border:1px solid #dce4df;padding:8px;text-align:left;vertical-align:top}th{background:#eef3f0}.tag{display:inline-block;padding:2px 7px;border-radius:3px}.tag.pass{background:#dff4e9;color:#126b4f}.tag.fail{background:#ffe0dd;color:#942e2a}details{margin:10px 0;border:1px solid #dce4df;padding:10px}summary{font-weight:700;cursor:pointer}code,pre{font-family:"Cascadia Mono",Consolas,monospace}pre{white-space:pre-wrap;word-break:break-word;background:#16201c;color:#e6eee9;padding:14px;max-height:440px;overflow:auto}.note{background:#fff8db;border:1px solid #e7d590;padding:12px}.small{font-size:12px;color:#65736c}@media(max-width:900px){main{padding:20px}.metrics{grid-template-columns:repeat(2,1fr)}table{display:block;overflow:auto}}
</style></head><body><main>
<h1>猫咪工坊：DeepSeek → 35 稳态验收</h1>
<p class="small">生成时间 ${escapeHtml(report.generatedAt)} · commit ${escapeHtml(commit)} · schema ${escapeHtml(report.schema)}</p>
<div class="status"><strong>${passed ? "通过" : "未通过"}</strong><p>${passed ? `最高难度 seed 1 已稳定制作前 ${target} 项。` : `本次只达到连续首作 ${finalThrough} 项，未满足稳定制作到 ${target} 项；后续阶段未执行或未通过。`}</p></div>
<div class="metrics">
  <div class="metric"><b>${finalThrough}/${target}</b><span>连续首作进度</span></div>
  <div class="metric"><b>${report.difficulty}</b><span>难度</span></div>
  <div class="metric"><b>${escapeHtml(report.model)}</b><span>模型/夹具</span></div>
  <div class="metric"><b>${report.simulationSpeed}x</b><span>引擎配置加速</span></div>
  <div class="metric"><b>${formatDuration(totalLogicalMs)}</b><span>逻辑时间 / 理论 1×</span></div>
  <div class="metric"><b>${formatDuration(totalEngineClockMs)}</b><span>配置引擎时钟推进</span></div>
  <div class="metric"><b>${formatDuration(report.wallClockMs)}</b><span>本次总墙钟</span></div>
  <div class="metric"><b>${totalMeasuredAcceleration ?? "-"}x</b><span>整次实测墙钟加速</span></div>
  <div class="metric"><b>${seedOne.antiCheat?.prohibitedMutationCount ?? "-"}</b><span>禁止变更计数</span></div>
</div>

<h2>评测标准</h2>
<p>“达到”不是首次制作。每阶段先通过允许的玩家收购/售卖施加可审计需求，再冻结玩家操作和法典，分三个等长窗口观察真实 craft 完成。实际买走 N 件时至少补产 N 件并覆盖 min(2,N) 个窗口；买不到库存时仍要求至少3件、覆盖2窗。另检查原料库存透支、长期计划/合同、信用缺口、未结悬赏和共享行为源码哈希。</p>
<p class="note">时间换算：逻辑模拟时间就是不加速时的理论现实耗时，因为基础动作固定5秒。引擎时钟推进 = 逻辑模拟时间 ÷ ${report.simulationSpeed}；实测有效加速 = 逻辑模拟时间 ÷ 墙钟时间。配置${report.simulationSpeed}x不等于实测速度，两者分开报告。</p>

<h2>阶段与时间</h2>
<table id="stage-timing"><thead><tr><th>阶段</th><th>结论</th><th>逻辑模拟时间</th><th>引擎时钟推进</th><th>理论1×现实耗时</th><th>实际墙钟</th><th>实测加速</th><th>进度</th></tr></thead><tbody>${timingRows || `<tr><td colspan="8">没有保留下阶段记录。</td></tr>`}</tbody></table>
${probeSections}

<h2>DeepSeek API</h2>
<table><thead><tr><th>#</th><th>用途</th><th>校验</th><th>HTTP</th><th>耗时</th><th>模型</th><th>重试</th></tr></thead><tbody>${apiRows}</tbody></table>
${apiDetails}

<h2>浏览器阶段</h2>
<p><strong>${browserAudit?.passed ? "通过" : "未通过/未执行"}</strong> · 状态 ${escapeHtml(browserAudit?.status ?? "尚未生成浏览器审计")}</p>
<p>${escapeHtml(browserAudit?.reason ?? "先运行无界面稳定产出门禁；只有前置门禁通过后才允许打开游戏重放完整 UI 路径。")}</p>
<p class="small">打开游戏：${browserAudit?.openedGame ? "是" : "否"} · 本阶段 API 调用：${browserAudit?.apiCalls ?? 0} · 墙钟 ${formatDuration(browserAudit?.wallClockMs)}</p>

<h2>共享行为与防作弊</h2>
<p>共享 behavior 哈希：<code>${escapeHtml(seedOne.antiCheat?.sharedBehaviorHash ?? "未记录")}</code>；源码未变化：${seedOne.antiCheat?.sharedBehaviorUnchanged === true ? "是" : "否/未记录"}；猫与地块未被测试注入：${seedOne.antiCheat?.catsUnchanged && seedOne.antiCheat?.parcelsUnchanged ? "是" : "否/未记录"}。</p>
<table><thead><tr><th>玩家命令</th><th>次数</th></tr></thead><tbody>${commandCounts || `<tr><td colspan="2">无</td></tr>`}</tbody></table>

<h2>前35项制作清单</h2>
<table id="crafted-items"><thead><tr><th>#</th><th>商品ID</th><th>累计制作</th><th>状态</th></tr></thead><tbody>${itemRows}</tbody></table>

<h2>本次改动与结论</h2>
<ul><li>法规只读输入新增最近60模拟秒真实制作量，玩家购买不计入。</li><li>近期产量按决策批次一次汇总，避免每猫×每商品重复扫描。</li><li>初始评分法规合并为三条循环法；沙箱上限为24 KiB、4096个AST节点和64层深度，并保留启动安全校验。</li><li>稳态评测增加受审计需求探针、库存透支和长期计划检查。</li></ul>
<p><strong>结论：</strong>${passed ? "全部发布门槛通过。" : "当前物流在高级轻工业补产阶段仍不稳定；不能宣称22、30或35项稳态通过。"}</p>
<h2>原始失败</h2><pre>${escapeHtml(report.fatalError ?? "无")}</pre>
</main></body></html>`;

await mkdir("output", { recursive: true });
await writeFile("output/DeepSeek-to-35-Acceptance.html", html, "utf8");
process.stdout.write(`${JSON.stringify({ output: "output/DeepSeek-to-35-Acceptance.html", passed, stages: stages.length, items: items.length })}\n`);
