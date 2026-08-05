import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const reportPath = path.resolve("output/deepseek-creative-availability-official.html");
const outputDir = path.resolve("output/deepseek-three-stage-report-browser");
await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(error.message));

try {
  await page.goto(pathToFileURL(reportPath).href, { waitUntil: "load" });
  const summary = await page.evaluate(() => ({
    rows: document.querySelectorAll("tbody tr").length,
    passedRows: [...document.querySelectorAll("tbody tr")].filter((row) => row.textContent?.includes("通过")).length,
    explanations: document.querySelectorAll(".explanation").length,
    hasThreeStageStatement: document.body.innerText.includes("每案固定调用三次：程序与逐函数参数注释、匹配台词、完整白话解释"),
    hasEightySemanticPasses: document.body.innerText.includes("80") && document.body.innerText.includes("自动语义匹配"),
    replacementCharacters: (document.body.innerText.match(/�/g) ?? []).length,
    overflowPx: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
  }));
  if (summary.rows !== 80 || summary.passedRows !== 80 || summary.explanations !== 75
    || !summary.hasThreeStageStatement || !summary.hasEightySemanticPasses
    || summary.replacementCharacters || summary.overflowPx || errors.length) {
    throw new Error(`report QA failed: ${JSON.stringify({ summary, errors })}`);
  }
  await page.screenshot({ path: path.join(outputDir, "report-top.png"), fullPage: false });
  await page.locator("tbody tr").nth(37).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDir, "report-middle.png"), fullPage: false });
  await writeFile(path.join(outputDir, "summary.json"), JSON.stringify({ ok: true, summary, errors }, null, 2), "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, summary, errors })}\n`);
} finally {
  await browser.close();
}
