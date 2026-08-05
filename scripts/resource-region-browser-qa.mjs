import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outputDir = path.resolve("output/web-game-resource-regions");
fs.mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(error.message));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

try {
  await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.waitForFunction(() => typeof window.render_game_to_text === "function");
  await page.evaluate(() => window.__CAT_WORKSHOP__.reset());
  await page.waitForTimeout(120);
  const initial = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const nodes = initial.world.resourceNodes;
  const harvestKeys = nodes.flatMap((node) => node.harvestTiles.map((tile) => `${tile.x},${tile.y}`));
  assert(nodes.length === 6, "the starter parcel does not contain six resources");
  assert(nodes.every((node) => node.centerOccupied === false), "a cat occupies a resource center");
  assert(nodes.every((node) => node.harvestTiles.length === 8), "a resource does not expose eight harvest cells");
  assert(new Set(harvestKeys).size === 48, "starter harvest regions overlap");
  assert(nodes.every((node) => node.harvestingCats.length >= 1), "a starter resource has no harvesting cat");
  assert(initial.cats.length === 11, "starter cat count changed");
  await page.screenshot({ path: path.join(outputDir, "resource-regions-full.png"), fullPage: true });

  await page.evaluate(() => {
    const state = window.__CAT_WORKSHOP__.state();
    state.paused = false;
    window.advanceTime(180_000);
    state.paused = true;
  });
  const progressed = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(progressed.discoveredItems.length === 10, `asset-greedy foundation discovered ${progressed.discoveredItems.length} items instead of ten`);
  assert(progressed.discoveredItems.includes("thread"), "asset-greedy cats did not autonomously produce item ten");
  assert(!progressed.discoveredItems.includes("paper"), "locked item eleven was produced");

  await page.evaluate(() => {
    const state = window.__CAT_WORKSHOP__.state();
    state.treasuryCoins = 10_000;
    window.advanceTime(0);
  });
  await page.getByRole("button", { name: "配方图" }).click();
  for (const recipeId of ["make_paper", "make_tools", "make_glass", "make_metal", "make_gear"]) {
    await page.getByTestId(`unlock-${recipeId}`).click();
  }
  await page.evaluate(() => {
    const state = window.__CAT_WORKSHOP__.state();
    state.paused = false;
    window.advanceTime(300_000);
    state.paused = true;
  });
  const foundation15 = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(foundation15.discoveredItems.length === 15, `asset-greedy foundation discovered ${foundation15.discoveredItems.length} items instead of fifteen`);
  assert(foundation15.discoveredItems.includes("gear"), "asset-greedy cats did not produce gear");
  assert(!foundation15.discoveredItems.includes("cable"), "industrial certification gate was crossed");
  assert(foundation15.marketChallenge.foundationCompleted === true, "text state does not report the fifteen-item foundation complete");
  await page.screenshot({ path: path.join(outputDir, "foundation-15-full.png"), fullPage: true });
  assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
  fs.writeFileSync(path.join(outputDir, "resource-regions-state.json"), JSON.stringify({ initial, progressed, foundation15 }, null, 2));
  console.log(JSON.stringify({ ok: true, resources: nodes.map((node) => ({ itemId: node.itemId, position: node.position })), harvestCells: new Set(harvestKeys).size, initialFoundation: progressed.discoveredItems, completedFoundation: foundation15.discoveredItems, errors }));
} finally {
  await browser.close();
}
