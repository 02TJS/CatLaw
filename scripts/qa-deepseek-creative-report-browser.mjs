import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { mkdir } from "node:fs/promises";

const reportPath = path.resolve("output/DeepSeek-Creative-Availability-80x2.html");
const outputDir = path.resolve("output/deepseek-creative-report-browser");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`page: ${error.message}`));

await page.goto(pathToFileURL(reportPath).href, { waitUntil: "load" });
const summary = await page.evaluate(() => {
  const tables = [...document.querySelectorAll("table")];
  const text = document.body.textContent ?? "";
  return {
    title: document.title,
    cards: document.querySelectorAll(".card").length,
    tables: tables.length,
    needRows: tables[0]?.querySelectorAll("tbody tr").length ?? 0,
    injectionRows: tables[1]?.querySelectorAll("tbody tr").length ?? 0,
    dangerBadges: document.querySelectorAll(".status.danger").length,
    overflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    reportLinks: document.querySelectorAll(".links a").length,
    chineseHeadingPresent: text.includes("40 条法规需求与首答结果") && text.includes("40 条提示注入与首答结果"),
    replacementCharacterPresent: text.includes("�"),
  };
});

await page.screenshot({ path: path.join(outputDir, "full.png"), fullPage: true });
await page.screenshot({ path: path.join(outputDir, "top.png") });
await page.locator("table").first().screenshot({ path: path.join(outputDir, "needs.png") });
await page.locator("h2").nth(1).scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(outputDir, "injections-top.png") });

const result = { ...summary, errors };
if (summary.cards !== 6 || summary.tables !== 2 || summary.needRows !== 40 || summary.injectionRows !== 40
  || summary.dangerBadges !== 0 || summary.overflowPx !== 0 || summary.reportLinks !== 4
  || !summary.chineseHeadingPresent || summary.replacementCharacterPresent || errors.length) {
  throw new Error(`Report browser QA failed: ${JSON.stringify(result)}`);
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
await browser.close();
