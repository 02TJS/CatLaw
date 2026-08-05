import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";

const output = path.resolve("output/electron-desktop-contract");
fs.mkdirSync(output, { recursive: true });

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

const packagedExecutable = process.env.CAT_WORKSHOP_EXECUTABLE;
const qaUserDataDir = process.env.CAT_WORKSHOP_QA_USER_DATA_DIR
  ?? path.join(output, `user-data-${process.pid}-${Date.now()}`);
fs.mkdirSync(qaUserDataDir, { recursive: true });
const electronApp = await electron.launch({
  ...(packagedExecutable
    ? { executablePath: packagedExecutable, args: [`--user-data-dir=${qaUserDataDir}`] }
    : { args: [`--user-data-dir=${qaUserDataDir}`, path.resolve(".")] }),
  env: {
    ...process.env,
    DEEPSEEK_API_KEY: "qa-placeholder-not-real",
    CAT_WORKSHOP_PORT: "18798",
  },
});

try {
  const page = await electronApp.firstWindow();
  await page.waitForSelector("[data-testid=game-canvas]");
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(String(error)));

  const box = async (selector) => {
    const value = await page.locator(selector).boundingBox();
    if (!value) throw new Error(`missing layout box: ${selector}`);
    return value;
  };

  await page.evaluate(() => window.advanceTime(60_000));
  const achievementDialog = page.getByTestId("achievement-dialog");
  const queuedAchievementState = JSON.parse(await page.evaluate(() => window.render_game_to_text())).achievements;
  assert(queuedAchievementState.pending.length > 0 && queuedAchievementState.awaitingCommerceTrigger,
    `packaged achievements did not wait for commerce: ${JSON.stringify(queuedAchievementState)}`);
  assert(!(await achievementDialog.isVisible().catch(() => false)), "packaged achievement appeared before commerce");
  await page.screenshot({ path: path.join(output, "achievements-queued-without-dialog.png"), omitBackground: true });
  const commerceState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const commerceQuote = commerceState.world.warehouse.allCatStockQuote;
  const buyPriceText = await page.getByTestId("buy-all-price").textContent();
  const resellPriceText = await page.getByTestId("buy-resell-price").textContent();
  assert(commerceQuote.totalQuantity > 0, "packaged price-label scenario has no purchasable cat stock");
  assert(buyPriceText?.includes((commerceQuote.totalCostCents / 100).toFixed(2)), `packaged buy-all price is stale: ${buyPriceText}`);
  assert(resellPriceText?.includes((Math.abs(commerceQuote.netCents) / 100).toFixed(2)), `packaged buy-resell net is stale: ${resellPriceText}`);
  await page.screenshot({ path: path.join(output, "commerce-price-labels.png"), omitBackground: true });
  await page.getByTestId("buy-all-cat-stock").click();
  await page.getByTestId("main-commerce-message").waitFor({ state: "visible" });
  assert(!(await achievementDialog.isVisible().catch(() => false)), "packaged achievement appeared before commerce feedback ended");
  await page.waitForTimeout(3_350);
  assert(await achievementDialog.isVisible(), "packaged first-craft achievement did not appear after purchase");
  await page.screenshot({ path: path.join(output, "achievement-dialog-after-purchase.png"), omitBackground: true });
  for (let index = 0; index < 80 && await achievementDialog.isVisible().catch(() => false); index += 1) {
    await page.getByTestId("acknowledge-achievement").click();
    await page.waitForTimeout(15);
  }
  assert(!(await achievementDialog.isVisible().catch(() => false)), "packaged achievement queue did not drain");
  const assertTopLayout = async (label) => {
    const drag = await box(".pet-drag-region");
    const headline = await box(".pet-headline-stats");
    const windowControls = await box(".pet-window-controls");
    const quickStats = await box(".pet-quick-stats");
    const drawer = await box(".pet-drawer");
    const windowClose = await box("[data-testid=close-window]");
    const drawerClose = await box("[data-testid=close-drawer]");
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const titleBottom = Math.max(drag.y + drag.height, headline.y + headline.height, windowControls.y + windowControls.height);
    for (const [name, control] of Object.entries({ drag, headline, windowControls, windowClose, drawerClose })) {
      assert(control.x >= 0 && control.y >= 0 && control.x + control.width <= viewport.width && control.y + control.height <= viewport.height,
        `${label}: ${name} is clipped by the viewport: ${JSON.stringify(control)}`);
    }
    assert(!overlaps(drag, headline), `${label}: title and treasury capsules overlap`);
    assert(!overlaps(drag, windowControls), `${label}: title and window-control capsules overlap`);
    assert(!overlaps(headline, windowControls), `${label}: treasury and window-control capsules overlap`);
    assert(quickStats.y >= titleBottom + 6, `${label}: quick stats overlap the title safe area`);
    assert(drawer.y >= titleBottom + 6, `${label}: drawer overlaps the title safe area`);
    assert(!overlaps(quickStats, drawer), `${label}: drawer overlaps the quick statistics controls`);
    assert(!overlaps(windowClose, drawerClose), `${label}: global and drawer close buttons overlap`);
    assert(await page.locator(".pet-canvas-hint").count() === 0, `${label}: obsolete canvas hint is still present`);
    return { titleBottom, quickStats, drawer, windowClose, drawerClose };
  };

  await page.getByTestId("open-settings").click();
  assert(await page.getByTestId("speech-frequency").inputValue() === "70", "packaged settings did not default speech frequency to 70");
  await page.getByTestId("speech-frequency").fill("0");
  assert(await page.evaluate(() => window.__CAT_WORKSHOP__.state().speechFrequency) === 0, "packaged speech mute control failed");
  await page.getByTestId("speech-frequency").fill("70");
  await page.getByTestId("control-scale").fill("125");
  await page.getByTestId("interface-font-scale").fill("150");
  await page.getByTestId("speech-bubble-scale").fill("175");
  await page.getByTestId("map-scale").fill("135");
  await page.waitForTimeout(100);
  const fullScaleLayout = await assertTopLayout("100% native window");
  const visualPreferences = JSON.parse(await page.evaluate(() => window.render_game_to_text())).visualPreferences;
  assert(visualPreferences.controlScale === 1.25 && visualPreferences.interfaceFontScale === 1.5
    && visualPreferences.speechBubbleScale === 1.75 && visualPreferences.mapScale === 1.35
    && visualPreferences.speechFrequencyPercent === 70,
    `renderer did not apply independent UI scales: ${JSON.stringify(visualPreferences)}`);
  await page.getByTestId("control-scale").fill("180");
  await page.getByTestId("interface-font-scale").fill("220");
  await page.waitForTimeout(120);
  const maximumScaleLayout = await assertTopLayout("180% controls / 220% text");
  assert(await page.locator(".pet-titlebar").evaluate((element) => element.classList.contains("stacked")),
    "maximum visual scales did not activate the responsive stacked titlebar");
  await page.screenshot({ path: path.join(output, "maximum-responsive-controls.png"), omitBackground: true });
  await page.getByTestId("control-scale").fill("125");
  await page.getByTestId("interface-font-scale").fill("150");
  await page.waitForTimeout(100);
  await page.getByTestId("close-drawer").click();
  let persistedLayout = null;

  await electronApp.evaluate(({ shell }) => {
    globalThis.__CAT_WORKSHOP_EXTERNAL_URLS__ = [];
    shell.openExternal = async (url) => {
      globalThis.__CAT_WORKSHOP_EXTERNAL_URLS__.push(url);
    };
  });

  await page.getByTestId("open-recipes").click();
  assert(await page.locator("[data-testid=drawer-recipes] .recipe-card").count() === 65, "recipe drawer did not expose all 65 purchase entries");
  await page.getByTestId("open-recipe-graph").click();
  await page.waitForTimeout(100);
  const externalUrls = await electronApp.evaluate(() => globalThis.__CAT_WORKSHOP_EXTERNAL_URLS__ ?? []);
  if (externalUrls.length !== 1 || !externalUrls[0].endsWith("/recipes.html")) {
    throw new Error(`recipe action did not use shell.openExternal: ${JSON.stringify(externalUrls)}`);
  }
  if (electronApp.windows().length !== 1) throw new Error("recipe action created an Electron child window");
  await page.getByTestId("close-drawer").click();

  const before = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  const title = await page.locator(".pet-drag-region").boundingBox();
  if (!title) throw new Error("title drag capsule is missing");
  const start = { x: title.x + title.width / 2, y: title.y + title.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(start.x + 180, start.y + 120);
  await page.mouse.up({ button: "left" });
  await page.waitForTimeout(150);
  const after = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  if (after.x === before.x && after.y === before.y) {
    throw new Error(`native title drag did not move the window: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }

  const canvas = await page.getByTestId("game-canvas").boundingBox();
  if (!canvas) throw new Error("game canvas is missing for desktop drag");
  const canvasStart = { x: canvas.x + canvas.width * 0.72, y: canvas.y + canvas.height * 0.46 };
  const beforeCanvasDrag = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  await page.mouse.move(canvasStart.x, canvasStart.y);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(canvasStart.x + 140, canvasStart.y + 90);
  await page.mouse.up({ button: "left" });
  await page.waitForTimeout(150);
  const afterCanvasDrag = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  if (afterCanvasDrag.x === beforeCanvasDrag.x && afterCanvasDrag.y === beforeCanvasDrag.y) {
    throw new Error(`canvas native drag did not move the window: before=${JSON.stringify(beforeCanvasDrag)} after=${JSON.stringify(afterCanvasDrag)}`);
  }

  await page.getByTestId("expand-mode-button").click();
  assert(JSON.parse(await page.evaluate(() => window.render_game_to_text())).world.mapInteractionMode === true, "map mode did not activate");
  const beforeMapInteraction = await electronApp.evaluate(({ BrowserWindow }) => ({
    bounds: BrowserWindow.getAllWindows()[0].getBounds(),
    zoom: BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
  }));
  const mapCanvas = await page.getByTestId("game-canvas").boundingBox();
  if (!mapCanvas) throw new Error("game canvas is missing in map mode");
  const mapStart = { x: mapCanvas.x + mapCanvas.width * 0.68, y: mapCanvas.y + mapCanvas.height * 0.43 };
  await page.mouse.move(mapStart.x, mapStart.y);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(mapStart.x + 95, mapStart.y + 55);
  await page.mouse.up({ button: "left" });
  await page.mouse.wheel(0, -260);
  await page.waitForTimeout(160);
  const afterMapInteraction = await electronApp.evaluate(({ BrowserWindow }) => ({
    bounds: BrowserWindow.getAllWindows()[0].getBounds(),
    zoom: BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
  }));
  const mapPreferences = JSON.parse(await page.evaluate(() => window.render_game_to_text())).visualPreferences;
  assert(JSON.stringify(afterMapInteraction) === JSON.stringify(beforeMapInteraction),
    `map mode changed the native window: before=${JSON.stringify(beforeMapInteraction)} after=${JSON.stringify(afterMapInteraction)}`);
  assert(mapPreferences.mapScale > visualPreferences.mapScale, `map wheel did not change map scale: ${JSON.stringify(mapPreferences)}`);
  await page.getByTestId("expand-mode-button").click();

  const beforeScale = await electronApp.evaluate(({ BrowserWindow }) => ({
    bounds: BrowserWindow.getAllWindows()[0].getBounds(),
    zoom: BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
  }));
  const scalePoint = { x: canvasStart.x + 140, y: canvasStart.y + 90 };
  await page.mouse.move(scalePoint.x, scalePoint.y);
  await page.mouse.wheel(0, 520);
  await page.waitForTimeout(180);
  const afterScale = await electronApp.evaluate(({ BrowserWindow }) => ({
    bounds: BrowserWindow.getAllWindows()[0].getBounds(),
    zoom: BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
  }));
  if (afterScale.zoom === beforeScale.zoom
    || (afterScale.bounds.width === beforeScale.bounds.width && afterScale.bounds.height === beforeScale.bounds.height)) {
    throw new Error(`desktop scale did not change native size and content scale: before=${JSON.stringify(beforeScale)} after=${JSON.stringify(afterScale)}`);
  }
  await page.getByTestId("open-settings").click();
  const minimumWindowLayout = await assertTopLayout("55% native window");
  await page.screenshot({ path: path.join(output, "minimum-window-scaled-settings.png"), omitBackground: true });
  await page.getByTestId("close-drawer").click();
  const scaledCanvas = await page.getByTestId("game-canvas").boundingBox();
  if (!scaledCanvas) throw new Error("scaled game canvas is missing");
  const scaledDragStart = { x: scaledCanvas.x + scaledCanvas.width * 0.62, y: scaledCanvas.y + scaledCanvas.height * 0.44 };
  await page.mouse.move(scaledDragStart.x, scaledDragStart.y);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(scaledDragStart.x + 80, scaledDragStart.y + 50);
  await page.mouse.up({ button: "left" });
  await page.waitForTimeout(120);
  const afterScaledDrag = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  if (afterScaledDrag.x === afterScale.bounds.x && afterScaledDrag.y === afterScale.bounds.y) {
    throw new Error(`scaled canvas drag did not move the window: before=${JSON.stringify(afterScale.bounds)} after=${JSON.stringify(afterScaledDrag)}`);
  }
  await page.screenshot({ path: path.join(output, "dragged-window.png"), omitBackground: true });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("open-settings").click();
  assert(await page.getByTestId("control-scale").inputValue() === "125", "control scale did not survive Electron reload");
  assert(await page.getByTestId("interface-font-scale").inputValue() === "150", "interface font scale did not survive Electron reload");
  assert(await page.getByTestId("speech-bubble-scale").inputValue() === "175", "speech bubble scale did not survive Electron reload");
  assert(Number(await page.getByTestId("map-scale").inputValue()) > 135, "map wheel scale did not survive Electron reload");
  persistedLayout = await assertTopLayout("reloaded 55% native window");
  await page.getByTestId("close-drawer").click();
  const closeButtonAfterScale = await page.locator(".pet-window-controls button.close").boundingBox();
  if (!closeButtonAfterScale || closeButtonAfterScale.width <= 0 || closeButtonAfterScale.height <= 0) {
    throw new Error(`close control disappeared after desktop scale: ${JSON.stringify(closeButtonAfterScale)}`);
  }
  await page.locator(".pet-drag-region").click({ button: "right" });
  await page.waitForTimeout(100);
  if (electronApp.windows().length !== 1) throw new Error("title right-click must not close the desktop pet");

  const closePromise = electronApp.waitForEvent("close");
  await page.locator(".pet-window-controls button.close").click();
  await closePromise;

  const result = {
    externalUrls,
    electronWindowCountAfterRecipe: 1,
    before,
    after,
    delta: { x: after.x - before.x, y: after.y - before.y },
    beforeCanvasDrag,
    afterCanvasDrag,
    beforeScale,
    afterScale,
    beforeMapInteraction,
    afterMapInteraction,
    mapPreferences,
    afterScaledDrag,
    closeButtonAfterScale,
    visualPreferences,
    fullScaleLayout,
    maximumScaleLayout,
    persistedLayout,
    minimumWindowLayout,
    rightClickIgnored: true,
    closeButtonClosed: true,
    errors,
  };
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  if (errors.length > 0) throw new Error(`renderer errors:\n${errors.join("\n")}`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (electronApp.windows().length > 0) await electronApp.close();
}
