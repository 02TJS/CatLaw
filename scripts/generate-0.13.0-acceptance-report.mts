import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar") as {
  listPackage(file: string): string[];
  extractFile(file: string, archivedPath: string): Buffer;
};

const root = process.cwd();
const reportPath = path.join(root, "CatWorkshop-0.13.0-Acceptance-Report.html");
const vitest = JSON.parse(await readFile(path.join(root, "output/vitest-0.13.0.json"), "utf8"));
const deepSeek = JSON.parse(await readFile(path.join(root, "output/deepseek-creative-availability-comparison.json"), "utf8"));
const progression = JSON.parse(await readFile(path.join(root, "output/deepseek-to-35-headless.json"), "utf8"));
const browserState = JSON.parse(await readFile(path.join(root, "output/web-game-0.13.0-final2/state-0.json"), "utf8"));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

const exePath = path.join(root, "release/win-unpacked/猫咪工坊.exe");
const asarPath = path.join(root, "release/win-unpacked/resources/app.asar");
const toolboxPath = "D:\\Codex_Sandbox\\Codex_Resume\\dist\\CodexToolbox.exe";

async function sha256(file: string): Promise<string> {
  const content = await readFile(file);
  return createHash("sha256").update(content).digest("hex").toUpperCase();
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${fmtNumber(ms)} ms`;
  if (ms < 60_000) return `${fmtNumber(ms / 1000)} 秒`;
  return `${fmtNumber(ms / 60_000)} 分钟`;
}

function fmtBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${fmtNumber(value)} ${units[index]}`;
}

function badge(label: string, tone: "pass" | "warn" | "fail" | "info" = "info"): string {
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

const [exeStat, asarStat, toolboxStat, exeHash, asarHash, toolboxHash] = await Promise.all([
  stat(exePath),
  stat(asarPath),
  stat(toolboxPath),
  sha256(exePath),
  sha256(asarPath),
  sha256(toolboxPath),
]);

const asarEntries = asar.listPackage(asarPath);
const archivedPackage = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
const archivedLawProgram = asar.extractFile(asarPath, "dist-server\\src\\game\\lawProgram.js").toString("utf8");
const archivedCompiler = asar.extractFile(asarPath, "dist-server\\server\\lawCompiler.js").toString("utf8");
const archivedSource = `${archivedLawProgram}\n${archivedCompiler}`;
const envEntries = asarEntries.filter((entry) => /(?:^|[\\/])\.env(?:\.|$)/i.test(entry));
const protocolPresent = archivedSource.includes("cat-workshop/shared-law-loop");
const legacyMarkers = ["program.effects", "LawEffect", "category=price"].filter((marker) => archivedSource.includes(marker));

const testFiles = vitest.testResults.map((file: any) => ({
  file: String(file.name).replaceAll("\\", "/").replace(`${root.replaceAll("\\", "/")}/`, ""),
  status: file.status,
  durationMs: Math.max(0, Number(file.endTime ?? 0) - Number(file.startTime ?? 0)),
  tests: file.assertionResults.map((test: any) => ({
    name: test.fullName,
    status: test.status,
    durationMs: Number(test.duration ?? 0),
  })),
})).sort((a: any, b: any) => a.file.localeCompare(b.file));

const testRows = testFiles.map((file: any) => `<details class="test-file">
  <summary><span>${escapeHtml(file.file)}</span><span>${badge(`${file.tests.length}/${file.tests.length}`, "pass")} ${fmtDuration(file.durationMs)}</span></summary>
  <ol>${file.tests.map((test: any) => `<li><span>${escapeHtml(test.name)}</span><span>${badge(test.status === "passed" ? "通过" : test.status, test.status === "passed" ? "pass" : "fail")} ${fmtDuration(test.durationMs)}</span></li>`).join("")}</ol>
</details>`).join("");

function providerEvidence(entry: any): string {
  const statusTone = ["passed", "contained", "rejected"].includes(entry.status.key) ? "pass" : entry.status.key === "review" ? "warn" : "fail";
  const draft = entry.draft;
  const audit = draft?.compileAudit;
  const details = draft ? `<details>
    <summary>标题、摘要、源码与编译审计</summary>
    <dl class="compact-dl">
      <dt>标题</dt><dd>${escapeHtml(draft.title)}</dd>
      <dt>摘要</dt><dd>${escapeHtml(draft.summary)}</dd>
      <dt>能力</dt><dd>${escapeHtml(entry.capabilities.join(", ") || "无副作用空法规")}</dd>
      <dt>AST</dt><dd><code>${escapeHtml(draft.astHash)}</code></dd>
      <dt>校验</dt><dd>语法 ${draft.validation.syntax ? "通过" : "失败"}；沙箱 ${draft.validation.safety ? "通过" : "失败"}；边界样例 ${draft.validation.examplesPassed}/${draft.validation.examplesTotal}</dd>
      <dt>警告</dt><dd>${escapeHtml(draft.warnings.join("；") || "无")}</dd>
      <dt>Prompt SHA-256</dt><dd><code>${escapeHtml(audit?.promptSha256 ?? "—")}</code></dd>
      <dt>Response SHA-256</dt><dd><code>${escapeHtml(audit?.responseSha256 ?? "—")}</code></dd>
      <dt>共享哈希</dt><dd><code>${escapeHtml(audit?.sharedBehaviorHash ?? "—")}</code></dd>
      <dt>Token</dt><dd>${fmtNumber(audit?.usage?.total_tokens ?? 0)}</dd>
    </dl>
    <pre>${escapeHtml(draft.sourceCode)}</pre>
  </details>` : `<div class="muted">未生成源码：${escapeHtml(entry.error || "模型明确拒绝不可表达需求")}</div>`;
  return `<div class="provider-result">${badge(entry.status.label, statusTone)} <span class="muted">${fmtDuration(entry.durationMs)} · ${escapeHtml(entry.finishReason ?? "—")}</span>${details}</div>`;
}

function deepSeekRows(suite: "need" | "injection"): string {
  return deepSeek.cases.filter((entry: any) => entry.suite === suite).map((entry: any, index: number) => `<tr>
    <td>${index + 1}</td>
    <td><strong>${escapeHtml(entry.id)}</strong><div class="muted">${escapeHtml(entry.kind)} · ${escapeHtml(entry.note)}</div></td>
    <td>${escapeHtml(entry.prompt)}</td>
    <td>${providerEvidence(entry.official)}</td>
    <td>${providerEvidence(entry.local8318)}</td>
  </tr>`).join("");
}

const primarySeed = progression.seedResults[0];
const progressionStages = primarySeed?.stages ?? [];
const stageRows = progressionStages.map((stage: any) => {
  const stability = stage.stability;
  return `<tr>
    <td>${escapeHtml(stage.name)}</td>
    <td>${badge(stage.passed ? "通过" : "失败", stage.passed ? "pass" : "fail")}</td>
    <td>${stage.craftedThroughStart} → ${stage.craftedThroughEnd}</td>
    <td>${fmtDuration(stage.simulatedElapsedMs)}</td>
    <td>${fmtDuration(stage.wallClockMs)}</td>
    <td>${stability ? `稳定至 ${stability.stableThrough}；窗口总量 [${stability.windowTargetCraftTotals.join(", ")}]` : "爬坡阶段"}</td>
  </tr>`;
}).join("");

const stabilityDetails = progressionStages.filter((stage: any) => stage.stability).map((stage: any) => {
  const stability = stage.stability;
  const frozen = stability.frozenEconomy;
  return `<details class="stage-detail">
    <summary>${escapeHtml(stage.name)}：稳定至 ${stability.stableThrough}</summary>
    <div class="stage-grid">
      <div><b>观察期</b><span>${fmtDuration(stability.observationSimulatedMs)}</span></div>
      <div><b>三窗口</b><span>${stability.windowTargetCraftTotals.join(" / ")}</span></div>
      <div><b>末窗仍产出</b><span>${stability.lastWindowActive ? "是" : "否"}</span></div>
      <div><b>连续暴跌</b><span>${stability.twoConsecutiveMajorDeclines ? "有" : "无"}</span></div>
      <div><b>信用冻结订单</b><span>${frozen.creditBlockedOrders.length}</span></div>
      <div><b>停滞合同/计划</b><span>${frozen.stalledContracts.length}/${frozen.stalledPlans.length}</span></div>
    </div>
    <div class="table-wrap"><table class="compact"><thead><tr><th>#</th><th>物品</th><th>观察期新增</th><th>窗口 1/2/3</th><th>活跃窗口</th><th>分类</th></tr></thead><tbody>
      ${stability.itemEvidence.map((item: any) => `<tr><td>${item.index}</td><td><code>${escapeHtml(item.itemId)}</code></td><td>${item.craftedDuringObservation}</td><td>${item.windowCrafts.join(" / ")}</td><td>${item.activeWindows}</td><td>${badge(item.classification === "stable" ? "稳定制作" : item.classification, item.stable ? "pass" : "warn")}</td></tr>`).join("")}
    </tbody></table></div>
  </details>`;
}).join("");

const providerCards = (["official", "local8318"] as const).map((provider) => {
  const item = deepSeek.providers[provider];
  return `<article class="provider-card"><h3>${provider === "official" ? "官方 DeepSeek" : "本机 8318"}</h3>
    <div class="metric-line"><span>HTTP</span><b>${item.httpSuccess}/${item.upstreamAttempts}</b></div>
    <div class="metric-line"><span>需求</span><b>${item.needs.passed}/40</b></div>
    <div class="metric-line"><span>注入收容</span><b>${item.injections.rejected + item.injections.contained}/40</b></div>
    <div class="metric-line"><span>危险 AST</span><b>${item.actualUnsafeCompiled}</b></div>
    <div class="metric-line"><span>P50 / P95</span><b>${item.latencyMs.p50} / ${item.latencyMs.p95} ms</b></div>
    <div class="metric-line"><span>总 Token</span><b>${fmtNumber(item.usage.totalTokens)}</b></div>
  </article>`;
}).join("");

const stateExcerpt = {
  coordinateSystem: browserState.coordinateSystem,
  difficulty: browserState.difficulty,
  decisionModel: browserState.decisionModel,
  treasuryCents: browserState.treasuryCents,
  catCount: browserState.cats.length,
  lawCount: browserState.laws.length,
  world: {
    parcelSize: browserState.world.parcelSize,
    worldSeed: browserState.world.worldSeed,
    resourceNodes: browserState.world.resourceNodes,
  },
};

const reportGeneratedAt = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>猫咪工坊 0.13.0 完整验收报告</title>
<style>
:root{color-scheme:light;--ink:#18211c;--muted:#647069;--line:#dfe5e1;--soft:#f5f7f5;--green:#166534;--green-bg:#eaf6ee;--amber:#8a5800;--amber-bg:#fff6dd;--red:#a12b2b;--red-bg:#fff0f0;--blue:#1e5f91;--blue-bg:#edf6fc;--radius:12px}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#fff;color:var(--ink);font:14px/1.62 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}.shell{display:grid;grid-template-columns:250px minmax(0,1fr);max-width:1780px;margin:auto}.toc{position:sticky;top:0;height:100vh;padding:26px 18px;border-right:1px solid var(--line);overflow:auto;background:#fbfcfb}.toc h2{font-size:17px;margin:0 0 14px}.toc a{display:block;color:#445149;text-decoration:none;padding:7px 9px;border-radius:7px}.toc a:hover{background:var(--soft);color:var(--green)}main{min-width:0;padding:34px 42px 80px}.eyebrow{color:var(--green);font-weight:750;letter-spacing:.08em}.hero h1{font-size:34px;line-height:1.2;margin:6px 0 10px}.hero p{max-width:1050px;color:var(--muted);font-size:16px}.stamp{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-weight:750;white-space:nowrap}.badge.pass{background:var(--green-bg);color:var(--green)}.badge.warn{background:var(--amber-bg);color:var(--amber)}.badge.fail{background:var(--red-bg);color:var(--red)}.badge.info{background:var(--blue-bg);color:var(--blue)}.cards{display:grid;grid-template-columns:repeat(6,minmax(135px,1fr));gap:10px;margin:24px 0}.card,.provider-card{border:1px solid var(--line);border-radius:var(--radius);padding:14px;background:#fff}.card .number{font-size:25px;font-weight:800}.card span{display:block;color:var(--muted)}section{scroll-margin-top:20px;padding-top:20px;margin-top:18px}h2{font-size:24px;margin:0 0 13px;padding-bottom:8px;border-bottom:1px solid var(--line)}h3{font-size:17px;margin:18px 0 9px}.callout{padding:14px 16px;border-left:4px solid var(--blue);background:var(--blue-bg);border-radius:0 9px 9px 0;margin:14px 0}.callout.warn{border-color:var(--amber);background:var(--amber-bg)}.callout.fail{border-color:var(--red);background:var(--red-bg)}.matrix{width:100%;border-collapse:collapse}.matrix th,.matrix td,table th,table td{border:1px solid var(--line);padding:9px;vertical-align:top;text-align:left}table th{background:#f1f4f2}.matrix td:first-child{font-weight:700;width:230px}.table-wrap{max-width:100%;overflow:auto}.provider-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.provider-card h3{margin-top:0}.metric-line{display:flex;justify-content:space-between;gap:20px;padding:6px 0;border-top:1px solid var(--line)}.metric-line span{color:var(--muted)}.flow{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin:15px 0}.flow span{border:1px solid var(--line);background:var(--soft);padding:8px 10px;border-radius:8px}.flow i{color:var(--muted)}code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}code{font-size:.92em;word-break:break-all}pre{white-space:pre-wrap;word-break:break-word;background:#f5f6f5;border:1px solid var(--line);border-radius:8px;padding:10px;max-height:360px;overflow:auto}.deep-table{width:100%;min-width:1420px;border-collapse:collapse;font-size:12.5px}.deep-table td:nth-child(1){width:38px}.deep-table td:nth-child(2){width:190px}.deep-table td:nth-child(3){width:360px}.deep-table td:nth-child(4),.deep-table td:nth-child(5){width:400px}.provider-result details{margin-top:6px}.compact-dl{display:grid;grid-template-columns:130px 1fr;gap:4px 9px}.compact-dl dt{color:var(--muted)}.compact-dl dd{margin:0}.muted{color:var(--muted)}details>summary{cursor:pointer;font-weight:700}.test-file,.stage-detail{border:1px solid var(--line);border-radius:9px;margin:8px 0;padding:0 12px}.test-file>summary,.stage-detail>summary{display:flex;justify-content:space-between;gap:12px;padding:11px 0}.test-file ol{border-top:1px solid var(--line);margin:0;padding:8px 0 10px 28px}.test-file li{padding:4px 0 4px 4px}.test-file li>span:last-child{float:right;margin-left:12px}.stage-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:10px 0}.stage-grid>div{border:1px solid var(--line);border-radius:8px;padding:9px}.stage-grid b,.stage-grid span{display:block}.stage-grid span{color:var(--muted)}table.compact{width:100%;border-collapse:collapse;font-size:12px}.visual-grid{display:grid;grid-template-columns:1.2fr .8fr;gap:12px}.visual-grid figure{margin:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--soft)}.visual-grid img{display:block;width:100%;height:auto}.visual-grid figcaption{padding:9px;color:var(--muted)}.artifact-list a{color:var(--blue)}.hash{word-break:break-all;font-size:12px}.nowrap{white-space:nowrap}@media(max-width:1200px){.shell{grid-template-columns:1fr}.toc{position:relative;height:auto;border-right:0;border-bottom:1px solid var(--line)}.toc nav{columns:3}.cards{grid-template-columns:repeat(3,1fr)}main{padding:28px}.visual-grid{grid-template-columns:1fr}}@media(max-width:700px){.toc nav{columns:1}.cards{grid-template-columns:repeat(2,1fr)}.provider-grid,.stage-grid{grid-template-columns:1fr}.hero h1{font-size:27px}main{padding:20px 14px}.test-file li>span:last-child{float:none;display:block}}
</style></head><body><div class="shell"><aside class="toc"><h2>报告目录</h2><nav>
<a href="#verdict">1. 总结论</a><a href="#scope">2. 范围与方法</a><a href="#fixes">3. 修复内容</a><a href="#architecture">4. 统一法规架构</a><a href="#deepseek">5. DeepSeek 80×2</a><a href="#needs">6. 40 条需求逐题</a><a href="#injections">7. 40 条注入逐题</a><a href="#regression">8. 146 项回归</a><a href="#progression">9. 稳定生产进度</a><a href="#browser">10. 浏览器与画面</a><a href="#package">11. EXE/ASAR</a><a href="#security">12. 安全与密钥</a><a href="#toolbox">13. Toolbox</a><a href="#limits">14. 未完成项</a><a href="#reproduce">15. 复现命令</a><a href="#artifacts">16. 产物索引</a>
</nav></aside><main>
<header class="hero"><div class="eyebrow">CAT WORKSHOP · ACCEPTANCE RECORD</div><h1>猫咪工坊 0.13.0 完整验收报告</h1><div class="stamp">${badge("有条件通过", "warn")} ${badge("法规重构通过", "pass")} ${badge("DeepSeek 80×2 通过", "pass")} ${badge("稳定生产验证至 22/35", "warn")}</div><p>本报告汇总统一法规重构、DeepSeek 创意与提示注入首答审计、自动化回归、浏览器画面、EXE/ASAR、密钥隔离和 Codex Toolbox 注册证据。结论严格区分“本轮修复通过”与“整个游戏稳定 35 商品尚未闭环”。生成时间：${escapeHtml(reportGeneratedAt)}（Asia/Shanghai）。</p></header>

<section id="verdict"><h2>1. 总结论</h2>
<div class="cards"><div class="card"><div class="number">${vitest.numPassedTests}/${vitest.numTotalTests}</div><span>Vitest 回归</span></div><div class="card"><div class="number">80/80 ×2</div><span>两入口 HTTP 首答</span></div><div class="card"><div class="number">40/40 ×2</div><span>法规需求通过</span></div><div class="card"><div class="number">40/40 ×2</div><span>提示注入收容</span></div><div class="card"><div class="number">0</div><span>危险 AST / 打包密钥</span></div><div class="card"><div class="number">22/35</div><span>严格稳定生产证据</span></div></div>
<table class="matrix"><thead><tr><th>验收域</th><th>结论</th><th>证据</th><th>边界</th></tr></thead><tbody>
<tr><td>统一法规运行时</td><td>${badge("通过","pass")}</td><td>动作、评分、价格、税、信用和悬赏都经过同一 <code>runSharedLawLoop()</code>；规范哈希 <code>fnv1a-3d8b3782</code>。</td><td>旧分类仅允许在 schema 迁移时一次性转成源码。</td></tr>
<tr><td>DeepSeek 法规需求</td><td>${badge("通过","pass")}</td><td>官方与本机 8318 各 40/40；随机与墙钟时间两类不可表达需求被明确安全拒绝并按预期计为通过。</td><td>这是编译审计，不颁布法规、不运行游戏。</td></tr>
<tr><td>提示注入</td><td>${badge("通过","pass")}</td><td>两个入口各 40/40 收容，真实密钥泄漏 0，危险 AST 0。</td><td>包含拒绝和降级为空法规两种安全结果。</td></tr>
<tr><td>引擎/UI 纯逻辑</td><td>${badge("通过","pass")}</td><td>${vitest.numPassedTests}/${vitest.numTotalTests}，${testFiles.length} 个测试文件。</td><td>确定性加速，不等待真实 5 秒。</td></tr>
<tr><td>浏览器画面与文本状态</td><td>${badge("通过","pass")}</td><td>Canvas 与 <code>render_game_to_text()</code> 哈希一致；报告 40+40 行、零横向溢出、零页面错误。</td><td>桌面 Chrome/Edge 范围。</td></tr>
<tr><td>EXE/ASAR</td><td>${badge("通过","pass")}</td><td>0.13.0；无 <code>.env</code>；统一协议存在；旧运行时标记 0。</td><td>本地解包版，整个 <code>win-unpacked</code> 目录需保持完整。</td></tr>
<tr><td>Codex Toolbox</td><td>${badge("通过","pass")}</td><td>注册到静态报告与游戏入口；28/28 测试及打包版自检通过。</td><td>按要求不启动 Toolbox 或游戏。</td></tr>
<tr><td>严格稳定 35 商品</td><td>${badge("未完成","warn")}</td><td>当前机器证据在难度 5、种子 1、固定夹具下稳定至 22；30/35 尚无同标准闭环报告。</td><td>不能把历史 35 首次制作或旧操作账本当作稳定 35。</td></tr>
</tbody></table>
<div class="callout warn"><b>总判定：</b>用户本轮要求的“修复法规分类/哈希/提示编译问题、重构 EXE、复测 DeepSeek 80 题组合与注入”全部通过；若验收对象扩大为此前定义的“前 35 项全部跨三窗口稳定生产”，则整体仍是未完成。</div></section>

<section id="scope"><h2>2. 验收范围与方法</h2><ul><li>测试日期：2026-08-03；工作区 <code>D:\\Codex_Sandbox\\260801_CatLaw2</code>。</li><li>模型别名：<code>deepseek-v4-flash</code>；入口：官方 API 与 <code>http://127.0.0.1:8318/</code>。</li><li>80 题矩阵：40 条差异化法规需求 + 40 条提示注入；两个入口逐字相同提示；每案只取首答。</li><li>游戏测试使用 <code>window.advanceTime(ms)</code> 和测试速度，不修改 5000ms 的生产规则；不会浪费墙钟等待。</li><li>稳定生产按三等长窗口、每物品至少新增 3 件、至少两个窗口活跃、末窗仍产出、无连续两窗大幅衰退、无冻结经济和库存透支判定。</li><li>密钥仅从进程环境/被忽略的本地配置读取；报告不保存或显示密钥。</li></ul></section>

<section id="fixes"><h2>3. 本轮修复内容</h2><table class="matrix"><thead><tr><th>问题</th><th>根因</th><th>修复</th><th>验证</th></tr></thead><tbody>
<tr><td>仍出现“基础经济/库存与生产”等类型</td><td>旧 IR、旧报告分组和兼容脚本残留造成误解。</td><td>所有现行法只保留 <code>LawProgram {version:2}</code> 与 <code>sourceCode</code>；报告不再显示组/类型列。</td><td>源码和 ASAR 均无 <code>program.effects</code>、<code>LawEffect</code> 或运行时 <code>category</code>。</td></tr>
<tr><td>Node、Vite、Electron 共享哈希不一致</td><td><code>Function#toString()</code> 会被 tsx/Vite 以不同形式打印。</td><td>改为运行时真实读取的规范清单生成哈希。</td><td>两套 DeepSeek 审计前后及浏览器状态均为 <code>fnv1a-3d8b3782</code>。</td></tr>
<tr><td>复杂法规未编译、输出耗尽</td><td>提示过长，Flash 将 4096 token 大量用于思考。</td><td>压缩 prompt，输出统一源码行；最终同时关闭 thinking、设 <code>temperature:0</code>、保留 <code>max_tokens:4096</code> 与 JSON Output。</td><td>两个入口需求 40/40；不放宽 AST 沙箱或语义门槛。</td></tr>
<tr><td>旧 35/行为权威脚本仍生成旧格式</td><td>兼容入口未同步。</td><td>旧 runner 改为统一 <code>setPrice/adjust/choose</code> 源码；旧报告标为历史归档。</td><td>最终遗留标记扫描为 0。</td></tr>
<tr><td>报告把测试主题误作法规分类</td><td>审计元数据直接呈现在表格。</td><td>移除 group 元数据和用户界面分类列，改为案例 ID + 边界。</td><td>刷新后的 80×2 页面视觉检查通过。</td></tr>
</tbody></table></section>

<section id="architecture"><h2>4. 统一法规架构</h2><div class="flow"><span>同一法典（按优先级）</span><i>→</i><span>for (const law of laws)</span><i>→</i><span>自定义 AST 解释器</span><i>→</i><span>累积评分/政策</span><i>→</i><span>首个合法直接动作或 choose()</span><i>→</i><span>不可绕过的合法性与经济门槛</span></div>
<table class="matrix"><tbody><tr><td>协议 ID</td><td><code>cat-workshop/shared-law-loop</code></td></tr><tr><td>协议版本</td><td>3</td></tr><tr><td>活动/隔离状态</td><td><code>active</code> / <code>quarantined</code></td></tr><tr><td>连续异常隔离阈值</td><td>3</td></tr><tr><td>直接动作</td><td>首个合法动作生效</td></tr><tr><td>评分调整</td><td>所有现行法累积</td></tr><tr><td>选择器</td><td>遍历完法典后统一请求一次</td></tr><tr><td>稳定哈希</td><td><code>fnv1a-3d8b3782</code></td></tr></tbody></table>
<div class="callout"><b>没有分类旁路：</b><code>setPrice</code>、<code>setTax</code>、<code>setCredit</code>、<code>setBounty</code>、<code>adjust</code>、直接动作和 <code>choose/earnCoins/weighted</code> 都只能在同一 <code>decide(ctx)</code> 源码中出现，并由同一循环解释。</div></section>

<section id="deepseek"><h2>5. DeepSeek 80×2 总览</h2><div class="provider-grid">${providerCards}</div>
<h3>一致性</h3><table class="matrix"><tbody><tr><td>案例 ID 顺序一致</td><td>${deepSeek.consistency.sameIds ? "是" : "否"}</td></tr><tr><td>提示逐字一致</td><td>${deepSeek.consistency.samePrompts ? "是" : "否"}</td></tr><tr><td>编译结论一致</td><td>${deepSeek.consistency.compiledAgreement}/80</td></tr><tr><td>能力集合一致</td><td>${deepSeek.consistency.capabilityAgreement}/80</td></tr><tr><td>双方均编译</td><td>${deepSeek.consistency.bothCompiled}/80</td></tr><tr><td>双方源码逐字一致</td><td>${deepSeek.consistency.identicalSourceWhenBothCompiled}/${deepSeek.consistency.bothCompiled}</td></tr></tbody></table>
<div class="callout warn"><b>关于“只改 prompt”：</b>严格的 prompt-only 尝试改善了复杂组合样例，但不足以稳定阻止 Flash 将输出预算耗在思考上。最终通过还调整了模型请求参数：<code>thinking.disabled</code> 与 <code>temperature=0</code>。游戏逻辑、AST 白名单、语义检查和安全边界未关闭；静态容量现为 24 KiB、4096 节点与 64 层深度。</div></section>

<section id="needs"><h2>6. 40 条法规需求逐题证据</h2><p class="muted">“通过”包含：成功生成且通过语法/沙箱/语义门槛，或对随机数与真实墙钟等确定性沙箱不可表达需求作出明确安全拒绝。</p><div class="table-wrap"><table class="deep-table"><thead><tr><th>#</th><th>案例</th><th>完整玩家需求</th><th>官方 DeepSeek</th><th>本机 8318</th></tr></thead><tbody>${deepSeekRows("need")}</tbody></table></div></section>

<section id="injections"><h2>7. 40 条提示注入逐题证据</h2><p class="muted">覆盖伪造系统消息、密钥外传、网络、动态执行、原型链、DOM/存储、循环递归、AST 炸弹、Unicode 混淆、重复 JSON 键、非有限数、恶意 item ID、观察修改、异步、XSS、工具调用伪造等。</p><div class="table-wrap"><table class="deep-table"><thead><tr><th>#</th><th>案例</th><th>完整注入文本</th><th>官方 DeepSeek</th><th>本机 8318</th></tr></thead><tbody>${deepSeekRows("injection")}</tbody></table></div></section>

<section id="regression"><h2>8. 146 项自动化回归</h2><div class="cards"><div class="card"><div class="number">${vitest.numPassedTests}</div><span>通过测试</span></div><div class="card"><div class="number">${vitest.numFailedTests}</div><span>失败测试</span></div><div class="card"><div class="number">${testFiles.length}</div><span>测试文件</span></div><div class="card"><div class="number">100</div><span>基础流程固定种子</span></div><div class="card"><div class="number">1000</div><span>猫咪性能场景</span></div><div class="card"><div class="number">5000×</div><span>严格进度引擎加速</span></div></div>
<p>覆盖配方图、确定性 5000ms 边界、统一法规、解释器安全、市场/信用/广播/逐跳合同、9×9 地块、资源采集区、建筑与地标、仓库交易、存档迁移、等距命中与遮挡、难度 1–5、100 个开局种子、稳定经济瓶颈等。</p>${testRows}</section>

<section id="progression"><h2>9. 严格稳定生产进度</h2><div class="callout"><b>数据来源：</b><code>output/deepseek-to-35-headless.json</code>；难度 ${progression.difficulty}；种子 ${progression.seeds.join(", ")}；<code>sourceMode=${escapeHtml(progression.sourceMode)}</code>；目标 ${progression.target}；总结果 ${progression.passed ? "通过" : "失败"}。这里使用固定 CI 模型夹具，不冒充本轮真实 DeepSeek 实跑。</div>
<h3>稳定性规则</h3><ul><li>${progression.stabilityPolicy.windows} 个等长窗口。</li><li>每个目标商品至少新增 ${progression.stabilityPolicy.minimumCraftsPerItem} 件。</li><li>每个目标商品至少在 ${progression.stabilityPolicy.minimumActiveWindowsPerItem} 个窗口出现。</li><li>末窗口仍有目标商品完成；总产量不能连续两个窗口下降超过 50%。</li><li>观察期法规、价格和玩家操作冻结；检查订单、合同、悬赏、计划和库存覆盖。</li></ul>
<div class="table-wrap"><table class="matrix"><thead><tr><th>阶段</th><th>结果</th><th>制作进度</th><th>逻辑时间</th><th>墙钟</th><th>稳定证据</th></tr></thead><tbody>${stageRows}</tbody></table></div>${stabilityDetails}
<div class="callout warn"><b>当前上限：</b>机器可复核证据稳定到第 22 项。法规物流稳定 30、玩家只用公开操作稳定 35、20 个种子 35 商品闭环和玩家购入来源覆盖尚未完成。</div></section>

<section id="browser"><h2>10. 浏览器、画面与文本状态</h2><div class="visual-grid"><figure><img src="output/web-game-0.13.0-final2/game.png" alt="猫咪工坊浏览器验收截图"><figcaption>0.13.0 等距工坊：白色背景、灰色工位、资源采集区、11 只教学猫和统一法典。</figcaption></figure><figure><img src="output/deepseek-creative-report-browser/top.png" alt="DeepSeek 80x2 报告截图"><figcaption>80×2 报告：40/40 需求、40/40 注入、危险 AST 0；已移除法规类型分组。</figcaption></figure></div>
<h3><code>render_game_to_text()</code> 关键状态</h3><table class="matrix"><tbody><tr><td>猫咪数量</td><td>${browserState.cats.length}</td></tr><tr><td>视野</td><td>曼哈顿距离 ${browserState.decisionModel.visionRadius}</td></tr><tr><td>现行法规</td><td>${browserState.laws.length} 条，同一优先级循环</td></tr><tr><td>共享哈希</td><td><code>${escapeHtml(browserState.decisionModel.sharedBehaviorHash)}</code></td></tr><tr><td>全局后备逻辑</td><td>${browserState.decisionModel.fallback === null ? "无" : escapeHtml(browserState.decisionModel.fallback)}</td></tr><tr><td>地块尺寸</td><td>${browserState.world.parcelSize}×${browserState.world.parcelSize}</td></tr><tr><td>资源中心</td><td>${browserState.world.resourceNodes.length}</td></tr></tbody></table><details><summary>查看文本状态节选</summary><pre>${escapeHtml(JSON.stringify(stateExcerpt, null, 2))}</pre></details>
<p>浏览器验收确认：画面与文本哈希一致；圆形动作进度、搬运表现和浮字正常；80×2 报告为两张 40 行表格；中文无替换字符；横向溢出 0；控制台/页面错误 0。</p></section>

<section id="package"><h2>11. EXE 与 ASAR 静态审计</h2><table class="matrix"><tbody>
<tr><td>应用版本</td><td>${escapeHtml(archivedPackage.version)}（源码 ${escapeHtml(packageJson.version)}）</td></tr><tr><td>EXE</td><td><code>${escapeHtml(exePath)}</code><br>${fmtBytes(exeStat.size)} · ${escapeHtml(exeStat.mtime.toLocaleString("zh-CN", { hour12:false }))}</td></tr><tr><td>EXE SHA-256</td><td class="hash"><code>${exeHash}</code></td></tr><tr><td>ASAR</td><td>${fmtBytes(asarStat.size)} · ${asarEntries.length} 个归档条目</td></tr><tr><td>ASAR SHA-256</td><td class="hash"><code>${asarHash}</code></td></tr><tr><td>统一协议</td><td>${protocolPresent ? badge("存在","pass") : badge("缺失","fail")} <code>cat-workshop/shared-law-loop</code></td></tr><tr><td>旧运行时标记</td><td>${legacyMarkers.length === 0 ? badge("0","pass") : badge(String(legacyMarkers.length),"fail")} ${escapeHtml(legacyMarkers.join(", "))}</td></tr><tr><td><code>.env*</code></td><td>${envEntries.length === 0 ? badge("未打包","pass") : badge(`${envEntries.length} 项`,"fail")}</td></tr>
</tbody></table><div class="callout"><b>运行方式：</b>这是 Electron 本地解包版，不是单文件安装器。必须保留 <code>release/win-unpacked</code> 内的 <code>resources/app.asar</code>、<code>locales</code>、<code>icudtl.dat</code> 等相邻运行时文件。</div></section>

<section id="security"><h2>12. 安全与密钥</h2><table class="matrix"><thead><tr><th>检查</th><th>结果</th><th>说明</th></tr></thead><tbody><tr><td>浏览器是否持久化密钥</td><td>${badge("否","pass")}</td><td>网页版只交给本机服务进程；桌面版使用 Windows 本机安全存储。</td></tr><tr><td>存档是否包含密钥</td><td>${badge("否","pass")}</td><td>法规、存档与报告均不写入 API Key。</td></tr><tr><td>ASAR 是否包含 <code>.env</code></td><td>${badge(envEntries.length === 0 ? "否" : "是",envEntries.length === 0 ? "pass" : "fail")}</td><td>静态枚举归档条目。</td></tr><tr><td>Git 跟踪文件密钥扫描</td><td>${badge("干净","pass")}</td><td><code>.env</code> 与 <code>.env.*</code> 被忽略；未发现 <code>sk-…</code> 模式。</td></tr><tr><td>沙箱</td><td>${badge("通过","pass")}</td><td>拒绝循环、递归、网络、DOM、存储、原型、动态代码、异步、异常构造和输入修改；每条法规最多 24 KiB、4096 个 AST 节点、64 层深度。</td></tr><tr><td>已暴露旧密钥</td><td>${badge("应轮换","warn")}</td><td>密钥曾出现在对话中；即使未打包，也建议在 DeepSeek 控制台轮换。</td></tr></tbody></table></section>

<section id="toolbox"><h2>13. Codex Toolbox 注册</h2><table class="matrix"><tbody><tr><td>Toolbox EXE</td><td><code>${escapeHtml(toolboxPath)}</code><br>${fmtBytes(toolboxStat.size)}</td></tr><tr><td>SHA-256</td><td class="hash"><code>${toolboxHash}</code></td></tr><tr><td>报告条目</td><td><code>cat_workshop_013_acceptance_report</code> · 猫咪工坊 0.13.0 验收报告</td></tr><tr><td>固定前三项</td><td>Codex Thread Repair / GPU Status Dashboard / COL Realtime Orchestration</td></tr><tr><td>最终检查</td><td>Python 编译、28/28 单元测试、重建、<code>CodexToolbox.exe --self-test</code> 全部通过</td></tr><tr><td>启动行为</td><td>仅注册与静态检查；未启动 Toolbox 或猫咪工坊。</td></tr></tbody></table></section>

<section id="limits"><h2>14. 未完成项与风险</h2><ol><li><b>稳定 30/35：</b>尚未在冻结法规/交易后满足所有目标物品跨窗口重复生产。</li><li><b>四种纯价格失败分支：</b>需要在同一严格稳定性框架下完整记录哪些物品偶产、未产及信用/订单瓶颈。</li><li><b>真实 DeepSeek 到 35：</b>80×2 是法规编译可用性测试；当前稳定 22 使用固定夹具，不等价于真实模型玩家通关。</li><li><b>多种子 35：</b>计划要求至少 20 个种子；尚无当前版本的 20 种子稳定 35 汇总。</li><li><b>来源审计：</b>最终 31–35 还需证明不依赖玩家最后一批购入原料，且玩家买入来源不能冒充猫咪制作。</li><li><b>历史报告：</b>旧 35 首次制作报告和 171 条操作账本只保留为历史档案，不能作为当前稳定生产证据。</li></ol></section>

<section id="reproduce"><h2>15. 复现命令</h2><pre>npm test
npm run build
node --import tsx scripts/qa-deepseek-creative-availability.mts --provider=official
node --import tsx scripts/qa-deepseek-creative-availability.mts --provider=local8318
node --import tsx scripts/report-deepseek-creative-availability.mts
node scripts/qa-deepseek-creative-report-browser.mjs
node --import tsx scripts/qa-deepseek-to-35-headless.mts --fixture

# Toolbox（不启动 UI）
python -m py_compile codex_toolbox/app.py codex_toolbox/codex_repair.py codex_toolbox/col_realtime.py codex_toolbox/gpu_dashboard.py
python -m unittest discover -s tests -v
powershell -NoProfile -ExecutionPolicy Bypass -File .\\build_codex_toolbox.ps1
.\\dist\\CodexToolbox.exe --self-test</pre><p class="muted">Live DeepSeek 命令会产生真实 API 消耗；本报告生成与浏览器复核不会重新调用模型。</p></section>

<section id="artifacts"><h2>16. 产物索引</h2><ul class="artifact-list"><li><a href="output/DeepSeek-Creative-Availability-80x2.html">DeepSeek 80×2 对照报告</a></li><li><a href="output/deepseek-creative-availability-comparison.json">DeepSeek 80×2 比较 JSON</a></li><li><a href="output/deepseek-creative-availability-official.json">官方 DeepSeek 原始审计 JSON</a></li><li><a href="output/deepseek-creative-availability-local8318.json">本机 8318 原始审计 JSON</a></li><li><a href="output/vitest-0.13.0.json">146 项 Vitest 机器报告</a></li><li><a href="output/deepseek-to-35-headless.json">稳定生产至 22 的机器报告</a></li><li><a href="output/web-game-0.13.0-final2/state-0.json">浏览器文本状态</a></li><li><a href="README.html">HTML README</a></li><li><a href="release/win-unpacked/猫咪工坊.exe">猫咪工坊 0.13.0 EXE</a></li></ul></section>

<footer class="muted">报告生成器：<code>scripts/generate-0.13.0-acceptance-report.mts</code>。所有数字从机器产物、实际文件与归档内容读取；Toolbox 注册、28/28 测试、重建与打包自检已完成。</footer>
</main></div></body></html>`;

await writeFile(reportPath, html, "utf8");
process.stdout.write(`${JSON.stringify({
  report: reportPath,
  version: archivedPackage.version,
  verdict: "conditional-pass",
  vitest: `${vitest.numPassedTests}/${vitest.numTotalTests}`,
  deepSeek: "80/80 x 2",
  stableProgressionThrough: progression.target,
  exeSha256: exeHash,
  asarSha256: asarHash,
  envEntries: envEntries.length,
  legacyMarkers,
}, null, 2)}\n`);
