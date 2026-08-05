import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const reportPath = path.resolve("CatWorkshop-Computer-Simulation-Analysis.html");
const outputDir = path.resolve("output/simulation-analysis-report-browser");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
await page.goto(pathToFileURL(reportPath).href, { waitUntil: "load" });
await page.screenshot({ path: path.join(outputDir, "top.png") });
for (const [selector, filename] of [
  ["#baseline", "baseline.png"],
  ["#contracts", "contracts.png"],
  ["#credit", "credit.png"],
  ["#supply", "supply.png"],
  ["#decision", "decision.png"],
]) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDir, filename) });
}

const desktop = await page.evaluate(() => {
  const bodyText = document.body.innerText;
  const navTargets = [...document.querySelectorAll("nav a")].map((link) => link.getAttribute("href"));
  return {
    title: document.title,
    h1: document.querySelector("h1")?.textContent?.trim(),
    sections: document.querySelectorAll("main > section").length,
    navTargets,
    missingTargets: navTargets.filter((target) => !target || !document.querySelector(target)),
    tables: document.querySelectorAll("table").length,
    experimentRows: document.querySelectorAll("#appendix > .table-wrap:first-of-type tbody tr").length,
    failedSeedRows: document.querySelectorAll("#appendix details:first-of-type tbody tr").length,
    hashRows: document.querySelectorAll("#appendix details:nth-of-type(2) tbody tr").length,
    evidencePresent: [
      "1000/1000", "826/1000", "911/1000", "126/126", "(5,250, 5,500]",
      "fnv1a-3d8b3782", "DeepSeek 调用数为 0",
    ].every((text) => bodyText.includes(text)),
    pendingStagesQualified: ["阶段 20", "22", "30", "35"].every((text) => bodyText.includes(text))
      && bodyText.includes("顺序门禁"),
    replacementCharacterPresent: bodyText.includes("\uFFFD"),
    secretLikeTextPresent: /sk-[A-Za-z0-9_-]{12,}/.test(bodyText),
    overflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
  };
});

const mobileErrors = [];
const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
mobilePage.on("console", (message) => {
  if (message.type() === "error") mobileErrors.push(`console: ${message.text()}`);
});
mobilePage.on("pageerror", (error) => mobileErrors.push(`pageerror: ${error.message}`));
await mobilePage.goto(pathToFileURL(reportPath).href, { waitUntil: "load" });
await mobilePage.screenshot({ path: path.join(outputDir, "mobile-top.png") });
await mobilePage.locator("#supply").scrollIntoViewIfNeeded();
await mobilePage.screenshot({ path: path.join(outputDir, "mobile-supply.png") });
const mobile = await mobilePage.evaluate(() => ({
  overflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
  h1Visible: Boolean(document.querySelector("h1")?.getBoundingClientRect().height),
  navVisible: Boolean(document.querySelector("nav")?.getBoundingClientRect().height),
  tableWrappersScrollable: [...document.querySelectorAll(".table-wrap")].every((entry) => entry.scrollWidth >= entry.clientWidth),
}));

if (desktop.title !== "猫咪工坊计算机模拟分析报告") errors.push(`unexpected title: ${desktop.title}`);
if (desktop.h1 !== "猫咪工坊：计算机模拟分析报告") errors.push(`unexpected h1: ${desktop.h1}`);
if (desktop.sections !== 8) errors.push(`section count: ${desktop.sections}`);
if (desktop.navTargets.length !== 8 || desktop.missingTargets.length) errors.push("invalid navigation targets");
if (desktop.tables !== 11) errors.push(`table count: ${desktop.tables}`);
if (desktop.experimentRows !== 19) errors.push(`experiment rows: ${desktop.experimentRows}`);
if (desktop.failedSeedRows !== 174) errors.push(`failed seed rows: ${desktop.failedSeedRows}`);
if (desktop.hashRows !== 19) errors.push(`hash rows: ${desktop.hashRows}`);
if (!desktop.evidencePresent) errors.push("required evidence missing");
if (!desktop.pendingStagesQualified) errors.push("later-stage qualification missing");
if (desktop.replacementCharacterPresent) errors.push("replacement character found");
if (desktop.secretLikeTextPresent) errors.push("secret-like text found");
if (desktop.overflowPx !== 0) errors.push(`desktop overflow: ${desktop.overflowPx}px`);
if (mobile.overflowPx !== 0) errors.push(`mobile overflow: ${mobile.overflowPx}px`);
if (!mobile.h1Visible || !mobile.navVisible || !mobile.tableWrappersScrollable) errors.push("mobile layout incomplete");
errors.push(...mobileErrors);

const result = { desktop, mobile, errors };
await writeFile(path.join(outputDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
await browser.close();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (errors.length) process.exitCode = 1;
