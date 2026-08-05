import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const reportPath = path.resolve("CatWorkshop-Price-Theory-and-Calculation.html");
const outputDir = path.resolve("output/price-theory-report-browser");
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
for (const [selector, filename] of [
  ["#technical-theorem", "theorem.png"],
  ["#certificates", "certificates.png"],
  ["#steady-results", "steady-results.png"],
  ["#prices", "prices.png"],
]) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDir, filename) });
}

const result = await page.evaluate(() => ({
  title: document.title,
  h1: document.querySelector("h1")?.textContent?.trim(),
  sectionCount: document.querySelectorAll("main > section").length,
  priceRows: document.querySelectorAll("#prices tbody tr").length,
  aggregateRows: document.querySelectorAll("#steady-results tbody tr").length,
  proofPresent: document.body.innerText.includes("有限级数确实是")
    && document.body.innerText.includes("强对偶")
    && document.body.innerText.includes("互补松弛"),
  certificatesPresent: document.body.innerText.includes("5.551e-16")
    && document.body.innerText.includes("1.998e-15")
    && document.body.innerText.includes("4,000"),
  bottleneckPresent: document.body.innerText.includes("齿轮 969/1000"),
  conclusionPresent: document.body.innerText.includes("pᵢ=cWᵢ")
    && document.body.innerText.includes("高级品并不偏低"),
  replacementCharacterPresent: document.body.innerText.includes("�"),
  secretLikeTextPresent: /sk-[A-Za-z0-9_-]{12,}/.test(document.body.innerText),
  overflowPx: Math.max(0, document.body.scrollWidth - window.innerWidth),
}));

if (result.title !== "猫咪工坊：价格理论证明与 1000 种子计算") errors.push(`unexpected title: ${result.title}`);
if (result.priceRows !== 65) errors.push(`price rows: ${result.priceRows}`);
if (result.aggregateRows !== 4) errors.push(`aggregate rows: ${result.aggregateRows}`);
if (!result.proofPresent) errors.push("theorem proof missing");
if (!result.certificatesPresent) errors.push("numerical certificates missing");
if (!result.bottleneckPresent) errors.push("bottleneck evidence missing");
if (!result.conclusionPresent) errors.push("pricing conclusion missing");
if (result.replacementCharacterPresent) errors.push("replacement character found");
if (result.secretLikeTextPresent) errors.push("secret-like text present");
if (result.overflowPx !== 0) errors.push(`horizontal overflow: ${result.overflowPx}px`);

const payload = { ...result, errors };
await writeFile(path.join(outputDir, "result.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
await browser.close();
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
if (errors.length) process.exitCode = 1;
