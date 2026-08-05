import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const reportPath = path.resolve("CatWorkshop-Computer-Simulation-Plan.html");
const outputDir = path.resolve("output/computer-simulation-plan-browser");
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
  ["#evidence", "evidence.png"],
  ["#matrix", "matrix.png"],
  ["#mapping", "decision-map.png"],
  ["#parameter", "parameter-methods.png"],
  ["#sources", "sources.png"],
]) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDir, filename) });
}

const result = await page.evaluate(() => {
  const navTargets = [...document.querySelectorAll("nav a")].map((link) => link.getAttribute("href"));
  const missingNavTargets = navTargets.filter((target) => !target || !document.querySelector(target));
  const bodyText = document.body.innerText;
  return {
    title: document.title,
    h1: document.querySelector("h1")?.textContent?.trim(),
    sectionCount: document.querySelectorAll("main > section").length,
    navCount: navTargets.length,
    missingNavTargets,
    sourceCount: document.querySelectorAll("#sources .source").length,
    experimentRows: document.querySelectorAll("#matrix tbody tr").length,
    decisionRows: document.querySelectorAll("#mapping tbody tr").length,
    stageRows: document.querySelectorAll("#stages tbody tr").length,
    localEvidencePresent: bodyText.includes("5.551e-16")
      && bodyText.includes("956/1000")
      && bodyText.includes("762/792/776")
      && bodyText.includes("stalled-contract"),
    behaviorHashMismatchPresent: bodyText.includes("fnv1a-74017d29")
      && bodyText.includes("fnv1a-3d8b3782")
      && bodyText.includes("不一致，必须重跑"),
    theoryPresent: bodyText.includes("有色定时 Petri 网")
      && bodyText.includes("CP-SAT/MILP")
      && bodyText.includes("Morris")
      && bodyText.includes("Sobol")
      && bodyText.includes("Little 定律"),
    decisionCoveragePresent: ["价格", "法规", "物流", "信用", "建筑", "地图"]
      .every((label) => document.querySelector("#mapping")?.textContent?.includes(label)),
    replacementCharacterPresent: bodyText.includes("�"),
    secretLikeTextPresent: /sk-[A-Za-z0-9_-]{12,}/.test(bodyText),
    overflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
  };
});

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const mobileErrors = [];
mobile.on("console", (message) => {
  if (message.type() === "error") mobileErrors.push(`console: ${message.text()}`);
});
mobile.on("pageerror", (error) => mobileErrors.push(`pageerror: ${error.message}`));
await mobile.goto(pathToFileURL(reportPath).href, { waitUntil: "load" });
await mobile.screenshot({ path: path.join(outputDir, "mobile-top.png"), fullPage: false });
const mobileResult = await mobile.evaluate(() => ({
  overflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
  navVisible: Boolean(document.querySelector("nav")?.getBoundingClientRect().height),
  h1Visible: Boolean(document.querySelector("h1")?.getBoundingClientRect().height),
}));

if (result.title !== "猫咪工坊计算机模拟研究计划与本地证据分析") errors.push(`unexpected title: ${result.title}`);
if (result.h1 !== "计算机模拟研究计划与本地证据分析") errors.push(`unexpected h1: ${result.h1}`);
if (result.sectionCount !== 15) errors.push(`section count: ${result.sectionCount}`);
if (result.navCount !== 15) errors.push(`nav count: ${result.navCount}`);
if (result.missingNavTargets.length) errors.push(`missing nav targets: ${result.missingNavTargets.join(", ")}`);
if (result.sourceCount !== 18) errors.push(`source count: ${result.sourceCount}`);
if (result.experimentRows !== 10) errors.push(`experiment rows: ${result.experimentRows}`);
if (result.decisionRows !== 12) errors.push(`decision rows: ${result.decisionRows}`);
if (result.stageRows !== 6) errors.push(`stage rows: ${result.stageRows}`);
if (!result.localEvidencePresent) errors.push("local evidence missing");
if (!result.behaviorHashMismatchPresent) errors.push("behavior hash qualification missing");
if (!result.theoryPresent) errors.push("research methods missing");
if (!result.decisionCoveragePresent) errors.push("decision coverage incomplete");
if (result.replacementCharacterPresent) errors.push("replacement character found");
if (result.secretLikeTextPresent) errors.push("secret-like text present");
if (result.overflowPx !== 0) errors.push(`desktop horizontal overflow: ${result.overflowPx}px`);
if (mobileResult.overflowPx !== 0) errors.push(`mobile horizontal overflow: ${mobileResult.overflowPx}px`);
if (!mobileResult.navVisible || !mobileResult.h1Visible) errors.push("mobile primary content hidden");
errors.push(...mobileErrors);

const payload = { ...result, mobile: mobileResult, errors };
await writeFile(path.join(outputDir, "result.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
await browser.close();
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
if (errors.length) process.exitCode = 1;
