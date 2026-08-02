import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { mkdir } from "node:fs/promises";

const reportPath = path.resolve(process.argv[2] ?? "CatWorkshop-35-Run-Report.html");
const outputDir = path.resolve(process.argv[3] ?? "output/qa35-report-0.9.0");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`page: ${error.message}`));

await page.goto(pathToFileURL(reportPath).href);
await page.waitForTimeout(250);
const summary = await page.evaluate(() => ({
  title: document.title,
  badge: document.querySelector(".badge")?.textContent?.trim(),
  itemRows: document.querySelectorAll("#items tbody tr").length,
  ledgerRows: document.querySelectorAll("#ledger-table tbody tr").length,
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
}));

await page.screenshot({ path: path.join(outputDir, "full.png"), fullPage: true });
for (const id of ["boundary", "laws", "space", "items"]) {
  await page.locator(`#${id}`).screenshot({ path: path.join(outputDir, `${id}.png`) });
}
await page.locator("button[data-filter=phase2]").click();
await page.locator("#ledger").screenshot({ path: path.join(outputDir, "ledger-phase2.png") });
const visiblePhase2 = await page.locator("#ledger-table tbody tr:visible").count();

process.stdout.write(`${JSON.stringify({ ...summary, visiblePhase2, errors }, null, 2)}\n`);
await browser.close();

