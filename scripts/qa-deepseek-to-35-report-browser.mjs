import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const reportPath = path.resolve("output/DeepSeek-to-35-Acceptance.html");
const outputDir = path.resolve("output/deepseek-to-35-report-browser");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`page: ${error.message}`));

await page.goto(pathToFileURL(reportPath).href, { waitUntil: "load" });
await page.waitForTimeout(150);
const summary = await page.evaluate(() => {
  const text = document.body.textContent ?? "";
  return {
    title: document.title,
    status: document.querySelector(".status strong")?.textContent?.trim() ?? null,
    stageRows: document.querySelectorAll("#stage-timing tbody tr").length,
    itemRows: document.querySelectorAll("#crafted-items tbody tr").length,
    details: document.querySelectorAll("details").length,
    overflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    hasLogicalTime: text.includes("逻辑模拟时间"),
    hasEngineClock: text.includes("引擎时钟推进"),
    hasWallClock: text.includes("实际墙钟"),
    hasFailureEvidence: text.includes("tools,gear,cable,battery,chassis"),
    browserGateBlocked: text.includes("blocked-by-headless-progression"),
  };
});

await page.screenshot({ path: path.join(outputDir, "full.png"), fullPage: true });
await page.locator(".status").screenshot({ path: path.join(outputDir, "status.png") });
const firstTable = page.locator("table").first();
await firstTable.screenshot({ path: path.join(outputDir, "timing.png") });

const failures = [];
if (summary.status !== "未通过") failures.push(`状态应为未通过，实际为 ${summary.status}`);
if (summary.stageRows !== 3) failures.push(`阶段行数应为 3，实际为 ${summary.stageRows}`);
if (summary.itemRows !== 35) failures.push(`商品行数应为 35，实际为 ${summary.itemRows}`);
if (summary.overflowPx > 0) failures.push(`页面横向溢出 ${summary.overflowPx}px`);
if (!summary.hasLogicalTime || !summary.hasEngineClock || !summary.hasWallClock) failures.push("四类时间字段显示不完整");
if (!summary.hasFailureEvidence) failures.push("未显示稳定生产失败商品");
if (!summary.browserGateBlocked) failures.push("未显示浏览器前置门禁状态");
failures.push(...errors);

const result = { passed: failures.length === 0, ...summary, errors, failures };
await writeFile(path.join(outputDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
await browser.close();
if (!result.passed) process.exitCode = 1;
