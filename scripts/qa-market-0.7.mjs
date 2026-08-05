import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const outputDir = path.resolve("output/schema14-market-browser");
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
await page.screenshot({ path: path.join(outputDir, "01-initial-11-cats.png"), omitBackground: true });

await page.evaluate(() => window.advanceTime(12_000));
await page.waitForTimeout(100);
const beforeInspector = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
await page.screenshot({ path: path.join(outputDir, "02-orders-plans-contracts.png"), omitBackground: true });

const canvas = page.getByTestId("game-canvas");
const box = await canvas.boundingBox();
if (!box) throw new Error("game canvas has no bounding box");
// The default camera keeps the first cat at world (0,0) centered at this
// stable isometric offset. Clicking the tile opens the real cat inspector.
await page.mouse.click(box.x + box.width / 2 - 32 * 1.08, box.y + box.height / 2 - 28 * 1.08);
await page.getByTestId("drawer-cat").waitFor();
await page.getByTestId("cat-market").waitFor();
await page.screenshot({ path: path.join(outputDir, "03-cat-assets-market-plan.png"), omitBackground: true });
await page.getByTestId("cat-assets").screenshot({ path: path.join(outputDir, "04-cat-assets.png") });
await page.getByTestId("cat-market").screenshot({ path: path.join(outputDir, "05-cat-market.png") });
await page.getByTestId("cat-action-detail").screenshot({ path: path.join(outputDir, "06-cat-funded-plan.png") });

const rawState = await page.evaluate(() => window.__CAT_WORKSHOP__.state());
const textState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
const inspectorText = await page.getByTestId("drawer-cat").innerText();
await page.keyboard.press("f");
await page.waitForTimeout(100);
const enteredFullscreen = await page.evaluate(() => Boolean(document.fullscreenElement));
await page.keyboard.press("Escape");

const result = {
  schemaVersion: rawState.schemaVersion,
  starterCats: rawState.cats.length,
  sharedBehaviorHash: textState.decisionModel.sharedBehaviorHash,
  sharedLawCount: textState.decisionModel.decisionLaws.length,
  openOrderCount: beforeInspector.market.openOrders.length,
  activePlanCount: beforeInspector.market.activePlans.length,
  contractCount: beforeInspector.market.activeContracts.length,
  everyOpenOrderHasFirmQuote: beforeInspector.market.openOrders.every((order) => (
    order.committedSellerCatId && order.quotedSellerCents !== null && order.quotedRouteCatIds.length >= 2
  )),
  everyPlanHasFundingCertificate: beforeInspector.market.activePlans.every((plan) => (
    Number.isFinite(plan.bundleCostCents)
      && Number.isFinite(plan.financingReserveCents)
      && Number.isFinite(plan.expectedProfitCents)
  )),
  inspectorSections: ["资产", "信用额度", "冻结保证金", "自己的订单", "合同路线", "生产计划", "计划阶段", "可靠原料包", "融资预留"]
    .filter((label) => inspectorText.includes(label)),
  enteredFullscreen,
  errors,
};
await fs.writeFile(path.join(outputDir, "result.json"), JSON.stringify(result, null, 2));
await browser.close();

const requiredInspectorSections = 9;
if (result.schemaVersion !== 14 || result.starterCats !== 11
  || result.sharedLawCount === 0 || result.openOrderCount === 0
  || result.activePlanCount === 0 || result.contractCount === 0
  || !result.everyOpenOrderHasFirmQuote || !result.everyPlanHasFundingCertificate
  || result.inspectorSections.length !== requiredInspectorSections
  || !enteredFullscreen || errors.length > 0) {
  throw new Error(`schema-14 market browser QA failed:\n${JSON.stringify(result, null, 2)}`);
}
console.log(JSON.stringify(result, null, 2));
