import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outputDir = path.resolve("output/warehouse-qa");
fs.mkdirSync(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 920, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const stateText = async () => JSON.parse(await page.evaluate(() => window.render_game_to_text()));

try {
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.waitForFunction(() => typeof window.render_game_to_text === "function" && Boolean(window.__CAT_WORKSHOP__));
  await page.evaluate(async () => {
    await window.__CAT_WORKSHOP__.reset(3);
    window.advanceTime(60_000);
  });

  const mainCommerce = page.getByTestId("main-commerce-actions");
  assert(await mainCommerce.isVisible(), "main commerce actions are not visible beside the treasury");
  for (const testId of ["buy-all-cat-stock", "buy-all-cat-stock-and-sell"]) {
    assert(await page.getByTestId(testId).isVisible(), `${testId} is not visible on the main interface`);
  }
  assert(!(await page.locator(".pet-headline-stats").textContent())?.includes("猫咪"), "active cat statistics are still in the title bar");
  assert(!(await page.locator(".pet-quick-stats").textContent())?.includes("库存"), "left quick statistics still show inventory quantity");

  let text = await stateText();
  assert(text.totalSalesCents === 0, "baseline unexpectedly has external sales");
  assert(text.grossProductionValuePerMinuteCents > 0, "gross production value did not grow after crafting");
  const displayedProduction = await page.getByTestId("gross-production-rate").textContent();
  assert(displayedProduction?.includes((text.grossProductionValuePerMinuteCents / 100).toFixed(2)), "displayed production value disagrees with text state");
  const initialQuote = text.world.warehouse.allCatStockQuote;
  assert(initialQuote.totalQuantity > 0, "starter cats did not accumulate purchasable stock");
  assert((await page.getByTestId("buy-all-price").textContent())?.includes((initialQuote.totalCostCents / 100).toFixed(2)), "one-click purchase button does not show its total cost");
  assert((await page.getByTestId("buy-resell-price").textContent())?.includes((Math.abs(initialQuote.netCents) / 100).toFixed(2)), "buy-and-resell button does not show its net settlement");
  const commerceTypography = await page.evaluate(() => {
    const treasuryLabel = document.querySelector(".pet-headline-stats small");
    const treasuryValue = document.querySelector(".pet-headline-stats strong");
    const actionLabel = document.querySelector('[data-testid="buy-all-cat-stock"] > span');
    const actionPrice = document.querySelector('[data-testid="buy-all-cat-stock"] > small');
    return {
      treasuryLabel: treasuryLabel ? getComputedStyle(treasuryLabel).fontSize : null,
      treasuryValue: treasuryValue ? getComputedStyle(treasuryValue).fontSize : null,
      actionLabel: actionLabel ? getComputedStyle(actionLabel).fontSize : null,
      actionPrice: actionPrice ? getComputedStyle(actionPrice).fontSize : null,
    };
  });
  assert(commerceTypography.actionLabel === commerceTypography.treasuryLabel, "purchase action label does not match the treasury label font size");
  assert(commerceTypography.actionPrice === commerceTypography.treasuryValue, "purchase price does not match the treasury value font size");
  await page.screenshot({ path: path.join(outputDir, "00-main-commerce-and-production-value.png"), omitBackground: true });

  await page.getByTestId("buy-all-cat-stock").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="main-commerce-message"]')?.textContent?.includes("已购买"));
  text = await stateText();
  const expectedPurchaseKinds = new Set(initialQuote.lines.map((line) => line.itemId)).size;
  assert(await page.getByTestId("commerce-item-deltas").locator("i").count() === expectedPurchaseKinds, "one-click purchase did not show every purchased item icon at once");
  assert(text.commerceAnimation.active && text.commerceAnimation.items.length === expectedPurchaseKinds, "text state is missing the item transaction animation");
  assert(text.commerceAnimation.treasuryDeltaCents === -initialQuote.totalCostCents, "purchase treasury delta is incorrect");
  assert((await page.getByTestId("treasury-delta").textContent())?.includes((initialQuote.totalCostCents / 100).toFixed(2)), "purchase treasury delta is not visible beside the treasury");
  assert(text.world.warehouse.totalItems === initialQuote.totalQuantity, "one-click purchase did not move all stock into the warehouse");
  assert(text.world.warehouse.allCatStockQuote.totalQuantity === 0, "one-click purchase left unreserved cat stock behind");
  await page.waitForTimeout(850);
  assert(Number(await page.getByTestId("treasury-value").getAttribute("data-value-cents")) === text.treasuryCents, "rolling treasury target disagrees with the game treasury");
  await page.screenshot({ path: path.join(outputDir, "00b-purchase-icons-and-treasury-roll.png"), omitBackground: true });

  await page.locator(".pet-dock button").filter({ hasText: "仓库" }).click();
  const shelfCount = await page.locator('[data-testid^="warehouse-item-"]').count();
  assert(shelfCount > 0 && shelfCount === Object.keys(text.world.warehouse.inventory).length, "warehouse did not render only owned item kinds");
  assert(await page.getByTestId("sell-all-warehouse").isVisible(), "warehouse bulk-sale button is missing");
  const bulkSellText = await page.getByTestId("sell-all-warehouse").innerText();
  assert(bulkSellText.includes("非锁定商品"), "warehouse bulk sale does not explain that locked goods are excluded");
  assert(bulkSellText.includes((text.world.warehouse.bulkUnlockedSellQuote.totalRevenueCents / 100).toFixed(2)), "warehouse bulk sale does not show its live total price");
  assert(await page.getByTestId("buy-all-cat-stock").isVisible(), "main one-click purchase disappeared while the warehouse was open");
  await page.screenshot({ path: path.join(outputDir, "01-owned-only-warehouse.png"), omitBackground: true });

  await page.getByTestId("sell-all-warehouse").click();
  text = await stateText();
  assert(text.world.warehouse.totalItems === 0 && text.totalSalesCents > 0, "warehouse bulk sale failed");

  await page.evaluate(async () => {
    await window.__CAT_WORKSHOP__.reset(3);
    window.advanceTime(60_000);
  });
  text = await stateText();
  const resaleQuote = text.world.warehouse.allCatStockQuote;
  assert(resaleQuote.totalQuantity > 0, "reset scenario has no stock for buy-and-resell");
  const treasuryBeforeResale = text.treasuryCents;
  await page.getByTestId("buy-all-cat-stock-and-sell").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="main-commerce-message"]')?.textContent?.includes("购买并转售"));
  text = await stateText();
  const expectedResaleKinds = new Set(resaleQuote.lines.map((line) => line.itemId)).size;
  assert(await page.getByTestId("commerce-item-deltas").locator("i").count() === expectedResaleKinds, "buy-and-resell did not show every transacted item icon at once");
  assert(text.commerceAnimation.treasuryDeltaCents === resaleQuote.netCents, "buy-and-resell treasury delta is incorrect");
  assert(text.totalSalesCents === resaleQuote.resaleRevenueCents, "buy-and-resell did not record external resale value");
  assert(text.treasuryCents === treasuryBeforeResale + resaleQuote.netCents, "buy-and-resell treasury settlement mismatch");
  await page.screenshot({ path: path.join(outputDir, "02-buy-and-resell-feedback.png"), omitBackground: true });

  assert(errors.length === 0, errors.join("\n"));
  const result = {
    ok: true,
    grossProductionValuePerMinuteCents: text.grossProductionValuePerMinuteCents,
    firstPurchaseQuantity: initialQuote.totalQuantity,
    shelfCount,
    resaleQuantity: resaleQuote.totalQuantity,
    resaleRevenueCents: resaleQuote.resaleRevenueCents,
    finalTreasuryCents: text.treasuryCents,
    commerceTypography,
    errors,
  };
  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result));
} finally {
  await browser.close();
}
