import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const reportPath = path.resolve("CatWorkshop-0.13.0-Acceptance-Report.html");
const outputDir = path.resolve("output/acceptance-report-0.13.0-browser");
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

await page.locator("#deepseek").scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(outputDir, "deepseek-summary.png") });

await page.locator("#progression").scrollIntoViewIfNeeded();
await page.locator("#progression .stage-detail").first().evaluate((element) => {
  element.open = true;
});
await page.screenshot({ path: path.join(outputDir, "progression.png") });

await page.locator("#package").scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(outputDir, "package.png") });

const result = await page.evaluate(() => {
  const body = document.body;
  const images = [...document.images].map((image) => ({
    src: image.getAttribute("src"),
    complete: image.complete,
    naturalWidth: image.naturalWidth,
  }));
  return {
    title: document.title,
    h1: document.querySelector("h1")?.textContent?.trim(),
    verdict: document.querySelector(".stamp .badge")?.textContent?.trim(),
    tocLinks: document.querySelectorAll(".toc a").length,
    summaryCards: document.querySelectorAll("#verdict .card").length,
    verdictRows: document.querySelectorAll("#verdict tbody tr").length,
    needRows: document.querySelectorAll("#needs tbody tr").length,
    injectionRows: document.querySelectorAll("#injections tbody tr").length,
    regressionFiles: document.querySelectorAll("#regression .test-file").length,
    regressionTests: document.querySelectorAll("#regression .test-file li").length,
    progressionStages: document.querySelectorAll("#progression .matrix tbody tr").length,
    stableStageDetails: document.querySelectorAll("#progression .stage-detail").length,
    artifactLinks: document.querySelectorAll("#artifacts a").length,
    images,
    overflowPx: Math.max(0, body.scrollWidth - window.innerWidth),
    replacementCharacterPresent: body.innerText.includes("�"),
    conditionalVerdictPresent: body.innerText.includes("有条件通过"),
    stable35IncompletePresent: body.innerText.includes("稳定 35") && body.innerText.includes("未完成"),
    unifiedLawPresent: body.innerText.includes("cat-workshop/shared-law-loop"),
    secretLikeTextPresent: /sk-[A-Za-z0-9_-]{12,}/.test(body.innerText),
  };
});

if (result.title !== "猫咪工坊 0.13.0 完整验收报告") errors.push(`unexpected title: ${result.title}`);
if (result.needRows !== 40) errors.push(`need rows: ${result.needRows}`);
if (result.injectionRows !== 40) errors.push(`injection rows: ${result.injectionRows}`);
if (result.regressionTests !== 146) errors.push(`regression tests: ${result.regressionTests}`);
if (result.regressionFiles !== 21) errors.push(`regression files: ${result.regressionFiles}`);
if (result.progressionStages !== 5) errors.push(`progression stages: ${result.progressionStages}`);
if (result.overflowPx !== 0) errors.push(`horizontal overflow: ${result.overflowPx}px`);
if (result.replacementCharacterPresent) errors.push("replacement character found");
if (!result.conditionalVerdictPresent || !result.stable35IncompletePresent) errors.push("acceptance boundary missing");
if (!result.unifiedLawPresent) errors.push("unified law protocol missing");
if (result.secretLikeTextPresent) errors.push("secret-like text present");
if (result.images.some((image) => !image.complete || image.naturalWidth < 1)) errors.push("one or more evidence images failed to load");

const payload = { ...result, errors };
await writeFile(path.join(outputDir, "result.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
await browser.close();
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
if (errors.length) process.exitCode = 1;
