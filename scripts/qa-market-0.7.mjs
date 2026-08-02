import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const outputDir = new URL("../output/market-0.7.0-browser/", import.meta.url);
await fs.mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(String(error)));

await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__CAT_WORKSHOP__ && typeof window.advanceTime === "function");
await page.evaluate(() => window.__CAT_WORKSHOP__.reset());
await page.waitForTimeout(100);

const systemIds = [
  "starter-law-cent-settlement",
  "starter-law-private-credit",
  "starter-law-discovery-bounty",
];
const lockedLawChecks = [];
for (const id of systemIds) {
  const card = page.getByTestId(`law-${id}`);
  lockedLawChecks.push({
    id,
    visible: await card.isVisible(),
    disabledActions: await card.locator("button:disabled").count(),
    title: await card.locator("strong").first().textContent(),
  });
}
await page.screenshot({ path: fileURLToPath(new URL("01-system-laws.png", outputDir)) });

await page.evaluate(() => window.advanceTime(12_000));
await page.waitForTimeout(100);
await page.screenshot({ path: fileURLToPath(new URL("02-orders-and-law-hits.png", outputDir)) });

await page.getByRole("button", { name: "猫咪", exact: true }).click();
await page.getByTestId("cat-market").waitFor();
await page.screenshot({ path: fileURLToPath(new URL("03-cat-wallet-market.png", outputDir)) });

const state = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
await page.keyboard.press("f");
await page.waitForTimeout(100);
const enteredFullscreen = await page.evaluate(() => Boolean(document.fullscreenElement));
await page.keyboard.press("Escape");
await page.waitForTimeout(100);

const result = {
  lockedLawChecks,
  enteredFullscreen,
  errors,
  stateChecks: {
    schemaMoney: [state.treasuryCents, state.personalCashCents, state.totalDebtCents].every(Number.isFinite),
    systemLawTitles: state.laws.filter((law) => law.category === "system").map((law) => law.title),
    openOrderCount: state.market.openOrders.length,
    contractCount: state.market.activeContracts.length,
    bountyPaidCount: state.market.discoveryBounties.filter((bounty) => bounty.paid).length,
    catHasMarketFields: state.cats.every((cat) => "debtCents" in cat && "netWorthCents" in cat
      && "creditAvailableCents" in cat && Array.isArray(cat.localSignals) && Array.isArray(cat.contracts)),
  },
};
await fs.writeFile(new URL("result.json", outputDir), JSON.stringify(result, null, 2));
await browser.close();

if (errors.length || lockedLawChecks.some((entry) => !entry.visible || entry.disabledActions !== 4)
  || !enteredFullscreen || !result.stateChecks.schemaMoney || !result.stateChecks.catHasMarketFields
  || result.stateChecks.systemLawTitles.length !== 3 || result.stateChecks.bountyPaidCount === 0) {
  process.exitCode = 1;
}
