import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const reportPath = path.resolve("CatWorkshop-Price-Model-Report.html");
const outputDir = path.resolve("output/price-model-report-browser");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

await page.goto(pathToFileURL(reportPath).href, { waitUntil: "load" });
await page.screenshot({ path: path.join(outputDir, "top.png") });
await page.locator("#derivation").scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(outputDir, "derivation.png") });
await page.locator("#compute").scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(outputDir, "compute.png") });
await page.locator("#prices").scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(outputDir, "prices.png") });

const result = await page.evaluate(() => ({
  title: document.title,
  h1: document.querySelector("h1")?.textContent?.trim(),
  sectionCount: document.querySelectorAll("main > section").length,
  priceRows: document.querySelectorAll("#prices tbody tr").length,
  computeRows: document.querySelectorAll("#reference-models tbody tr").length,
  scenarioRunsPresent: document.body.innerText.includes("8,600"),
  formulaPresent: document.body.innerText.includes("Vᵢ = Σⱼ qᵢⱼ · Vⱼ + 1"),
  recommendationPresent: document.body.innerText.includes("basePrice(item)")
    && document.body.innerText.includes("workUnits(item)"),
  replacementCharacterPresent: document.body.innerText.includes("�"),
  secretLikeTextPresent: /sk-[A-Za-z0-9_-]{12,}/.test(document.body.innerText),
  overflowPx: Math.max(0, document.body.scrollWidth - window.innerWidth),
}));

if (result.title !== "猫咪工坊基础价格数学模型与并行模拟报告") errors.push(`unexpected title: ${result.title}`);
if (result.priceRows !== 65) errors.push(`price rows: ${result.priceRows}`);
if (result.computeRows !== 5) errors.push(`compute rows: ${result.computeRows}`);
if (!result.scenarioRunsPresent || !result.formulaPresent || !result.recommendationPresent) errors.push("core evidence missing");
if (result.replacementCharacterPresent) errors.push("replacement character found");
if (result.secretLikeTextPresent) errors.push("secret-like text present");
if (result.overflowPx !== 0) errors.push(`horizontal overflow: ${result.overflowPx}px`);

const payload = { ...result, errors };
await writeFile(path.join(outputDir, "result.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
await browser.close();
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
if (errors.length) process.exitCode = 1;
