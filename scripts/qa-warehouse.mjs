import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outputDir = path.resolve("output/warehouse-qa");
fs.mkdirSync(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));

const stateText = async () => JSON.parse(await page.evaluate(() => window.render_game_to_text()));

try {
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.waitForFunction(() => typeof window.render_game_to_text === "function" && Boolean(window.__CAT_WORKSHOP__));
  await page.evaluate(async () => {
    await window.__CAT_WORKSHOP__.reset(3);
    const state = window.__CAT_WORKSHOP__.state();
    for (const cat of state.cats) {
      cat.inventory = {};
      cat.action = null;
    }
    state.procurementPlans.forEach((plan) => { plan.status = "cancelled"; });
    state.buildingOffers = [];
    state.playerBuildingInventory = {};
    state.lockedWarehouseItemIds = [];
    state.paused = true;
    state.treasuryCoins = 0;
    state.totalSales = 0;
    state.discoveredItems = ["wood", "stone"];
    state.cats[0].inventory.wood = 2;
    state.cats[1].inventory.stone = 1;
    window.advanceTime(0);
  });

  await page.getByRole("button", { name: "仓库", exact: true }).click();
  await page.waitForSelector('[data-testid="warehouse-batch-actions"]');
  const shelfCount = await page.locator('[data-testid^="warehouse-item-"]').count();
  if (shelfCount !== 65) throw new Error(`expected 65 warehouse shelves, got ${shelfCount}`);

  await page.locator('[data-testid="lock-item-wood"]').click();
  let text = await stateText();
  if (!text.world.warehouse.lockedItemIds.includes("wood")) throw new Error("wood lock was not persisted in text state");
  if (text.world.warehouse.allCatStockQuote.totalQuantity !== 3) throw new Error("unexpected batch quantity");
  if (text.world.warehouse.allCatStockQuote.resaleRevenueCents !== 200) throw new Error("locked wood incorrectly entered resale revenue");
  const requiredTreasuryCents = text.world.warehouse.allCatStockQuote.requiredTreasuryCents;
  if (requiredTreasuryCents !== text.world.warehouse.allCatStockQuote.totalCostCents - 200) throw new Error("unexpected minimum treasury difference");
  await page.evaluate((amount) => {
    window.__CAT_WORKSHOP__.state().treasuryCoins = amount;
    window.advanceTime(0);
  }, requiredTreasuryCents - 1);
  if (!(await page.locator('[data-testid="buy-all-cat-stock-and-sell"]').isDisabled())) throw new Error("net-difference button should be disabled one cent short");
  await page.locator('[data-testid="warehouse-batch-actions"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDir, "01-net-difference-insufficient.png"), fullPage: true });

  await page.evaluate((amount) => {
    window.__CAT_WORKSHOP__.state().treasuryCoins = amount;
    window.advanceTime(0);
  }, requiredTreasuryCents);
  await page.locator('[data-testid="buy-all-cat-stock-and-sell"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="warehouse-message"]')?.textContent?.includes("并转卖"));
  text = await stateText();
  if (text.treasuryCents !== 0) throw new Error(`expected net-difference treasury 0, got ${text.treasuryCents}`);
  if (text.world.warehouse.inventory.wood !== 2 || text.world.warehouse.inventory.stone) throw new Error("locked/unlocked buy-resell inventory mismatch");
  if (text.totalSalesCents !== 200 || text.itemStats.stone?.sold !== 1) throw new Error("batch resale stats mismatch");
  await page.locator('[data-testid="warehouse-batch-actions"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDir, "02-locked-buy-resell.png"), fullPage: true });

  await page.locator('[data-testid="sell-item-wood"]').click();
  text = await stateText();
  if (text.treasuryCents !== 200 || text.world.warehouse.inventory.wood !== 1) throw new Error("single warehouse sale mismatch");
  await page.locator('[data-testid="lock-item-wood"]').click();
  await page.locator('[data-testid="sell-all-warehouse"]').click();
  text = await stateText();
  if (text.treasuryCents !== 400 || text.world.warehouse.totalItems !== 0 || text.totalSalesCents !== 600) {
    throw new Error("unlocked bulk liquidation mismatch");
  }
  await page.locator('[data-testid="warehouse-batch-actions"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDir, "03-single-and-bulk-sale.png"), fullPage: true });

  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify({ shelfCount, final: text, errors }, null, 2));
  if (errors.length) throw new Error(errors.join("\n"));
  process.stdout.write(JSON.stringify({ ok: true, shelfCount, screenshots: 3, finalTreasuryCents: text.treasuryCents, totalSalesCents: text.totalSalesCents }));
} finally {
  await browser.close();
}
