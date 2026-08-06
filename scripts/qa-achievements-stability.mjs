import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outputDir = path.resolve("output/qa-achievements-stability");
fs.mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`page: ${error.message}`));

try {
  await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__CAT_WORKSHOP__ && window.advanceTime));
  await page.evaluate(async () => {
    await window.__CAT_WORKSHOP__.reset(3);
    window.__CAT_WORKSHOP__.setSpeed(1);
    window.advanceTime(180_000);
  });
  await page.waitForTimeout(250);

  const firstDialog = page.getByTestId("achievement-dialog");
  const queuedBeforeCommerce = JSON.parse(await page.evaluate(() => window.render_game_to_text())).achievements;
  if (!queuedBeforeCommerce.pending.length || !queuedBeforeCommerce.awaitingCommerceTrigger || queuedBeforeCommerce.currentDialogId !== null) {
    throw new Error(`制作成就没有安静等待交易触发：${JSON.stringify(queuedBeforeCommerce)}`);
  }
  if (await firstDialog.isVisible().catch(() => false)) throw new Error("制作成就在交易前自行弹出");
  await page.screenshot({ path: path.join(outputDir, "achievements-queued-without-dialog.png") });

  const buyButton = page.getByTestId("buy-all-cat-stock");
  if (await buyButton.isDisabled()) throw new Error("制作成就等待验收时没有可执行的一键购买");
  await buyButton.click();
  const commerceMessage = page.getByTestId("main-commerce-message");
  await commerceMessage.waitFor({ state: "visible" });
  await firstDialog.waitFor({ state: "visible" });
  const duringCommerce = JSON.parse(await page.evaluate(() => window.render_game_to_text())).achievements;
  if (!duringCommerce.reviewArmed || !duringCommerce.concurrentWithCommerce || duringCommerce.deferredByCommerce
    || duringCommerce.currentDialogId === null) {
    throw new Error(`交易阶段没有与成就并行展示：${JSON.stringify(duringCommerce)}`);
  }
  const commerceZIndex = Number(await commerceMessage.evaluate((element) => getComputedStyle(element).zIndex));
  const achievementZIndex = Number(await page.getByTestId("achievement-backdrop").evaluate((element) => getComputedStyle(element).zIndex));
  if (commerceZIndex <= achievementZIndex) throw new Error(`交易浮窗没有位于成就遮罩上方：${commerceZIndex} <= ${achievementZIndex}`);
  const commerce = {
    skipped: false,
    rarities: await page.locator("[data-testid='commerce-item-deltas'] i").evaluateAll((nodes) => nodes.map((node) => ({
      itemId: node.getAttribute("data-item-id"),
      rarityLevel: Number(node.getAttribute("data-rarity-level")),
    }))),
  };
  for (let index = 1; index < commerce.rarities.length; index += 1) {
    if (commerce.rarities[index].rarityLevel > commerce.rarities[index - 1].rarityLevel) {
      throw new Error(`交易商品没有按稀有度降序：${JSON.stringify(commerce.rarities)}`);
    }
  }
  const rarityStyles = await page.locator("[data-testid='commerce-item-deltas'] i").evaluateAll((nodes) => nodes.map((node) => {
    const style = getComputedStyle(node);
    return { color: style.color, borderLeftColor: style.borderLeftColor, backgroundImage: style.backgroundImage };
  }));
  if (rarityStyles.some((style) => style.color === "rgb(70, 84, 74)" || style.backgroundImage === "none")) {
    throw new Error(`交易稀有度颜色没有加深：${JSON.stringify(rarityStyles)}`);
  }
  await page.screenshot({ path: path.join(outputDir, "commerce-and-achievement-concurrent.png") });
  const firstAchievement = await firstDialog.evaluate((element) => ({
    id: element.getAttribute("data-achievement-id"),
    kind: element.getAttribute("data-achievement-kind"),
    rarityLevel: Number(element.getAttribute("data-rarity-level")),
    text: element.textContent,
  }));
  await page.screenshot({ path: path.join(outputDir, "achievement-dialog-after-purchase.png") });

  const acknowledgementOrder = [];
  for (let index = 0; index < 80; index += 1) {
    const dialog = page.getByTestId("achievement-dialog");
    if (!(await dialog.isVisible().catch(() => false))) break;
    acknowledgementOrder.push({
      id: await dialog.getAttribute("data-achievement-id"),
      rarityLevel: Number(await dialog.getAttribute("data-rarity-level")),
    });
    await page.getByTestId("acknowledge-achievement").click();
    await page.waitForTimeout(20);
  }
  const rarityOrder = acknowledgementOrder.map((entry) => entry.rarityLevel);
  for (let index = 1; index < rarityOrder.length; index += 1) {
    if (rarityOrder[index] > rarityOrder[index - 1]) throw new Error(`成就并非高级到低级：${JSON.stringify(acknowledgementOrder)}`);
  }

  await page.waitForTimeout(50);
  const afterDrain = JSON.parse(await page.evaluate(() => window.render_game_to_text())).achievements;
  if (afterDrain.reviewArmed || afterDrain.currentDialogId !== null) throw new Error(`成就队列清空后仍保持回顾状态：${JSON.stringify(afterDrain)}`);

  await page.evaluate(async () => {
    await window.__CAT_WORKSHOP__.reset(3);
    window.advanceTime(180_000);
  });
  await page.waitForTimeout(100);
  const beforeResell = JSON.parse(await page.evaluate(() => window.render_game_to_text())).achievements;
  if (!beforeResell.pending.length || !beforeResell.awaitingCommerceTrigger || await firstDialog.isVisible().catch(() => false)) {
    throw new Error(`新制作成就没有再次等待交易：${JSON.stringify(beforeResell)}`);
  }
  const resellButton = page.getByTestId("buy-all-cat-stock-and-sell");
  if (await resellButton.isDisabled()) throw new Error("第二轮制作成就等待验收时没有可执行的购买并转售");
  await resellButton.click();
  await page.getByTestId("main-commerce-message").waitFor({ state: "visible" });
  await firstDialog.waitFor({ state: "visible" });
  const resellTriggeredAchievementId = await firstDialog.getAttribute("data-achievement-id");
  await page.screenshot({ path: path.join(outputDir, "achievement-dialog-after-resell.png") });
  for (let index = 0; index < 80 && await firstDialog.isVisible().catch(() => false); index += 1) {
    await page.getByTestId("acknowledge-achievement").click();
    await page.waitForTimeout(20);
  }

  await page.getByTestId("map-lens-button").click();
  await page.getByTestId("map-lens-stability").click();
  const select = page.getByTestId("map-lens-item");
  await select.click();
  const optionValues = await page.getByTestId("map-lens-item-options").locator("[data-item-id]")
    .evaluateAll((options) => options.map((option) => option.getAttribute("data-item-id")));
  const selectedItemId = optionValues.includes("plank") ? "plank" : optionValues.find(Boolean);
  if (!selectedItemId) throw new Error("没有可供生产稳定滤镜选择的商品");
  await page.getByTestId(`map-lens-item-${selectedItemId}`).click();
  await page.waitForTimeout(150);
  const stateBeforeReload = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const stability = stateBeforeReload.world.mapLens.stabilityHistory;
  if (!stability?.persistentAcrossSaves || stability.selectedItemId !== selectedItemId) throw new Error("稳定滤镜未暴露持久记录");
  if (!stability.producers.length) throw new Error(`稳定滤镜没有 ${selectedItemId} 的历史生产者`);
  await page.screenshot({ path: path.join(outputDir, "stability-history.png") });

  const counterBefore = stability.producers.reduce((sum, entry) => sum + entry.plannedCount + entry.craftedCount, 0);
  await page.waitForTimeout(1_250);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__CAT_WORKSHOP__ && window.advanceTime));
  const persistedState = await page.evaluate(() => window.__CAT_WORKSHOP__.state());
  const counterAfter = Object.values(persistedState.productionHistory.byCat).reduce((sum, byItem) => {
    const entry = byItem[selectedItemId];
    return sum + (entry?.plannedCount ?? 0) + (entry?.craftedCount ?? 0);
  }, 0);
  if (counterAfter < counterBefore) throw new Error(`重载后生产记录减少：${counterBefore} -> ${counterAfter}`);

  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify({
    firstAchievement,
    acknowledgementOrder,
    commerce,
    queuedBeforeCommerce,
    duringCommerce,
    commerceZIndex,
    achievementZIndex,
    rarityStyles,
    resellTriggeredAchievementId,
    selectedItemId,
    stability,
    persistedCounter: { before: counterBefore, after: counterAfter },
    errors,
  }, null, 2));
  if (errors.length) throw new Error(errors.join("\n"));
} finally {
  await browser.close();
}
