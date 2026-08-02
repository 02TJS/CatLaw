import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const url = process.argv[2] ?? "http://127.0.0.1:5173";
const outputDir = path.resolve(process.argv[3] ?? "output/qa-price-feedback");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
page.on("pageerror", (error) => errors.push(`page: ${error.message}`));

await page.goto(url);
await page.waitForFunction(() => Boolean(window.__CAT_WORKSHOP__));
await page.evaluate(() => window.__CAT_WORKSHOP__.reset(5));
await page.getByRole("button", { name: "配方图" }).click();
const wheelCard = page.locator('[data-testid="recipe-make_wheel"]');
await wheelCard.scrollIntoViewIfNeeded();
await page.waitForTimeout(250);
await wheelCard.screenshot({ path: path.join(outputDir, "wheel-job-demand.png") });

const cardText = (await wheelCard.textContent())?.replace(/\s+/g, " ").trim() ?? "";
const state = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
const wheelDemand = state.market.priceSensitiveJobDemand.find((entry) => entry.itemId === "wheel");
const result = {
  difficulty: state.difficulty.level,
  cardText,
  wheelDemand,
  overflow: documentOverflow(await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))),
  errors,
};
if (result.difficulty !== 5 || !cardText.includes("配料作业报价合计") || !wheelDemand || errors.length) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  await browser.close();
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
await browser.close();

function documentOverflow({ scrollWidth, clientWidth }) {
  return scrollWidth - clientWidth;
}
