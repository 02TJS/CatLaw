import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { mkdir } from "node:fs/promises";

const reportPath = path.resolve("CatWorkshop-Behavior-Authority-Test-Report.html");
const outputDir = path.resolve("output/behavior-authority-report");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`page: ${error.message}`));

await page.goto(pathToFileURL(reportPath).href);
await page.waitForTimeout(200);
const sections = page.locator("main > section");
const apiSection = sections.filter({ hasText: "DeepSeek API 调用、返回与改动审计" });
const summary = await page.evaluate(() => ({
  title: document.title,
  language: document.documentElement.lang,
  sections: document.querySelectorAll("main > section").length,
  apiRows: document.querySelectorAll(".api-table tbody tr").length,
  details: document.querySelectorAll("details").length,
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  textHasApiTime: document.body.textContent?.includes("145.231 秒") ?? false,
  textHasBuildTime: document.body.textContent?.includes("34.252 秒") ?? false,
}));

await page.screenshot({ path: path.join(outputDir, "full.png"), fullPage: true });
await apiSection.screenshot({ path: path.join(outputDir, "api-audit.png") });
process.stdout.write(`${JSON.stringify({ ...summary, errors }, null, 2)}\n`);
await browser.close();
