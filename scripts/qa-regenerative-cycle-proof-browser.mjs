import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const reportPath = path.join(root, "CatWorkshop-Regenerative-Cycle-Complexity-Proof.html");
const artifactDir = path.join(root, "output", "regenerative-cycle-report-qa");
await mkdir(artifactDir, { recursive: true });

const source = await readFile(reportPath, "utf8");
if (source.includes("\uFFFD")) throw new Error("report contains replacement characters");
if (/sk-[A-Za-z0-9_-]{12,}/.test(source)) throw new Error("report contains a secret-like token");

const browser = await chromium.launch({ headless: true });
const errors = [];
const checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page:${error.message}`));
  await page.goto(pathToFileURL(reportPath).href, { waitUntil: "load" });
  const text = await page.locator("body").innerText();
  for (const marker of [
    "再生循环复杂度", "5090_Lian / marathon", "5,000", "Collatz–Wielandt",
    "右删失", "尚未证明", "没有调用 DeepSeek",
  ]) {
    if (!text.includes(marker)) throw new Error(`missing report marker: ${marker}`);
    checks.push(`marker:${marker}`);
  }
  const sections = await page.locator("main > section").count();
  if (sections !== 10) throw new Error(`expected 10 sections, got ${sections}`);
  checks.push(`sections:${sections}`);
  const tables = await page.locator("table").count();
  if (tables < 9) throw new Error(`expected at least 9 tables, got ${tables}`);
  checks.push(`tables:${tables}`);
  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (desktopOverflow > 1) throw new Error(`desktop horizontal overflow: ${desktopOverflow}`);
  checks.push(`desktopOverflow:${desktopOverflow}`);
  await page.screenshot({ path: path.join(artifactDir, "report-top.png"), fullPage: false });
  await page.locator("#period").screenshot({ path: path.join(artifactDir, "report-period.png") });
  await page.locator("#actual").screenshot({ path: path.join(artifactDir, "report-actual.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "load" });
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (mobileOverflow > 1) throw new Error(`mobile horizontal overflow: ${mobileOverflow}`);
  checks.push(`mobileOverflow:${mobileOverflow}`);
  await page.screenshot({ path: path.join(artifactDir, "report-mobile.png"), fullPage: false });
} finally {
  await browser.close();
}
if (errors.length) throw new Error(`browser errors: ${errors.join(" | ")}`);
const result = { reportPath, artifactDir, checks, errors };
await writeFile(path.join(artifactDir, "qa.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(result)}\n`);
