import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const reportPath = path.resolve("CatWorkshop-Dynamic-Systems-Research.html");
const outputDir = path.resolve("output/dynamic-systems-research-browser");
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
  ["#models", "models.png"],
  ["#local", "local.png"],
  ["#gap", "gap.png"],
  ["#section10", "section10.png"],
  ["#sources", "sources.png"],
]) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDir, filename) });
}

const result = await page.evaluate(() => ({
  title: document.title,
  h1: document.querySelector("h1")?.textContent?.trim(),
  sectionCount: document.querySelectorAll("main > section").length,
  sourceCount: document.querySelectorAll("#sources .source").length,
  modelRows: document.querySelectorAll("#models tbody tr").length,
  localLpRows: document.querySelectorAll("#local table tbody tr").length,
  coreRecommendationPresent: document.body.innerText.includes("有色定时 Petri 网的离散参考模型")
    && document.body.innerText.includes("监督控制")
    && document.body.innerText.includes("时间逻辑"),
  localEvidencePresent: document.body.innerText.includes("5.551e-16")
    && document.body.innerText.includes("22/35")
    && document.body.innerText.includes("762 / 792 / 776"),
  qualificationPresent: document.body.innerText.includes("不能直接相除比较")
    && document.body.innerText.includes("固定模型夹具"),
  replacementCharacterPresent: document.body.innerText.includes("�"),
  secretLikeTextPresent: /sk-[A-Za-z0-9_-]{12,}/.test(document.body.innerText),
  overflowPx: Math.max(0, document.body.scrollWidth - window.innerWidth),
}));

if (result.title !== "猫咪工坊闭环动态模型调研与本地证据分析") errors.push(`unexpected title: ${result.title}`);
if (result.sectionCount !== 12) errors.push(`section count: ${result.sectionCount}`);
if (result.sourceCount !== 7) errors.push(`source count: ${result.sourceCount}`);
if (result.modelRows !== 7) errors.push(`model rows: ${result.modelRows}`);
if (!result.coreRecommendationPresent) errors.push("core recommendation missing");
if (!result.localEvidencePresent) errors.push("local evidence missing");
if (!result.qualificationPresent) errors.push("qualification missing");
if (result.replacementCharacterPresent) errors.push("replacement character found");
if (result.secretLikeTextPresent) errors.push("secret-like text present");
if (result.overflowPx !== 0) errors.push(`horizontal overflow: ${result.overflowPx}px`);

const payload = { ...result, errors };
await writeFile(path.join(outputDir, "result.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
await browser.close();
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
if (errors.length) process.exitCode = 1;
