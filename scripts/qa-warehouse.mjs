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

try {
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.waitForFunction(() => typeof window.render_game_to_text === "function" && typeof window.advanceTime === "function");
  await page.evaluate(() => window.advanceTime(30_000));
  await page.getByRole("button", { name: "仓库", exact: true }).click();
  await page.waitForSelector('[data-testid="warehouse-item-wood"]');

  const shelfCount = await page.locator('[data-testid^="warehouse-item-"]').count();
  if (shelfCount !== 65) throw new Error(`expected 65 warehouse shelves, got ${shelfCount}`);
  const before = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  if (before.world.warehouse.purchasable.length < 1) throw new Error("expected at least one purchasable item after 30 seconds");
  await page.screenshot({ path: path.join(outputDir, "warehouse-before.png"), fullPage: true });

  const enabledBuy = page.locator('[data-testid^="buy-item-"]:not([disabled])').first();
  const testId = await enabledBuy.getAttribute("data-testid");
  if (!testId) throw new Error("no enabled warehouse buy button");
  const itemId = testId.slice("buy-item-".length);
  const sellerNetWorthBefore = before.personalCashCents - before.totalDebtCents;
  await enabledBuy.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="warehouse-message"]')?.textContent?.includes("已收购"));
  const after = JSON.parse(await page.evaluate(() => window.render_game_to_text()));

  if (after.treasuryCents >= before.treasuryCents) throw new Error("treasury was not charged");
  if (after.world.warehouse.totalItems !== before.world.warehouse.totalItems + 1) throw new Error("warehouse total did not increase by one");
  if ((after.world.warehouse.inventory[itemId] ?? 0) !== (before.world.warehouse.inventory[itemId] ?? 0) + 1) {
    throw new Error(`${itemId} did not enter warehouse inventory`);
  }
  const sellerNetWorthAfter = after.personalCashCents - after.totalDebtCents;
  if (sellerNetWorthAfter <= sellerNetWorthBefore) throw new Error("seller cat did not receive purchase proceeds");
  if (after.totalSalesCents !== before.totalSalesCents) throw new Error("warehouse purchase incorrectly changed external sales");

  await page.screenshot({ path: path.join(outputDir, "warehouse-after.png"), fullPage: true });
  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify({ shelfCount, itemId, before, after, errors }, null, 2));
  if (errors.length) throw new Error(errors.join("\n"));
  process.stdout.write(JSON.stringify({ ok: true, shelfCount, itemId, treasurySpent: before.treasuryCents - after.treasuryCents }));
} finally {
  await browser.close();
}
