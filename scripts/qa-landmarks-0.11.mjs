import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outputDir = path.resolve("output/landmarks-0.11");
fs.mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));

const stateText = async () => JSON.parse(await page.evaluate(() => window.render_game_to_text()));
const tilePoint = async ({ x, y }) => {
  const box = await page.locator("#game-canvas").boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  const isoX = (x - y) * 64;
  const isoY = (x + y) * 32;
  return {
    x: box.x + box.width / 2 + (isoX - 32) * 1.08,
    y: box.y + box.height / 2 + (isoY - 28) * 1.08,
  };
};
const clickTile = async (position, hoverOnly = false) => {
  const point = await tilePoint(position);
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(120);
  if (!hoverOnly) await page.mouse.click(point.x, point.y);
};

try {
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__CAT_WORKSHOP__ && typeof window.render_game_to_text === "function");
  await page.evaluate(async () => {
    await window.__CAT_WORKSHOP__.reset(3);
    const state = window.__CAT_WORKSHOP__.state();
    state.paused = true;
    state.cats = [state.cats[0]];
    state.cats[0].position = { x: 0, y: 0 };
    state.cats[0].action = null;
    state.resourceNodes = [];
    state.buildings = [];
    state.landmarks = [];
    state.unlockedLandmarkIds = [];
    state.nextLandmarkIndex = 0;
    state.playerBuildingInventory = {};
    state.discoveredItems = [];
    state.treasuryCoins = 100_000;
    state.procurementPlans = [];
    state.demandOrders = [];
    state.marketBroadcasts = state.marketBroadcasts.filter((broadcast) => !broadcast.kind.startsWith("demand-"));
    state.marketBroadcasts = [];
    state.shipmentContracts = [];
    state.buildingOrders = [];
    state.buildingOffers = [];
    window.advanceTime(1);
  });
  await page.getByRole("button", { name: "仓库", exact: true }).click();
  await page.waitForSelector('[data-testid="landmark-card-founders_plaza"]');
  const blueprint = page.locator('[data-testid="buy-blueprint-founders_plaza"]');
  if (!(await blueprint.isDisabled())) throw new Error("blueprint should be locked before material discovery");
  await page.screenshot({ path: path.join(outputDir, "01-blueprints-locked.png"), fullPage: true });

  await page.evaluate(() => {
    const state = window.__CAT_WORKSHOP__.state();
    state.discoveredItems.push("stone", "plank", "tools");
    state.playerBuildingInventory = { stone: 6, plank: 2, tools: 1 };
    window.advanceTime(1);
  });
  if (await blueprint.isDisabled()) throw new Error("blueprint did not unlock after discovering materials");
  const treasuryBefore = (await stateText()).treasuryCents;
  await blueprint.click();
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).world.landmarkEngineering.blueprints[0].unlocked);
  const bought = await stateText();
  if (treasuryBefore - bought.treasuryCents !== 1_000) throw new Error("blueprint did not charge exactly 1000 cents");
  await page.screenshot({ path: path.join(outputDir, "02-blueprint-owned.png"), fullPage: true });

  const buildButton = page.locator('[data-testid="build-landmark-founders_plaza"]');
  await buildButton.click();
  await clickTile({ x: 1, y: 0 }, true);
  await page.screenshot({ path: path.join(outputDir, "03-placement-aura.png") });
  await clickTile({ x: 1, y: 0 });
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).world.landmarkEngineering.deployed.length === 1);
  let text = await stateText();
  if (text.world.warehouse.totalItems !== 0) throw new Error("first landmark did not atomically consume exact materials");
  await page.screenshot({ path: path.join(outputDir, "04-landmark-built-missing-materials.png"), fullPage: true });

  await page.evaluate(() => {
    const state = window.__CAT_WORKSHOP__.state();
    state.playerBuildingInventory = { stone: 18, plank: 6, tools: 3 };
    window.advanceTime(1);
  });
  for (const position of [{ x: -1, y: 0 }, { x: 0, y: 1 }]) {
    await buildButton.click();
    await clickTile(position);
    await page.waitForTimeout(120);
  }
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).world.landmarkEngineering.deployed.length === 3);
  text = await stateText();
  if (text.cats[0].landmarkEffects.stacks.founders_plaza !== 3) throw new Error("three-layer founder plaza stack missing");
  if (Math.abs(text.cats[0].landmarkEffects.actionSpeedReduction - 0.3) > 1e-9) throw new Error("three-layer speed bonus should be 30%");
  await page.screenshot({ path: path.join(outputDir, "05-three-layer-landmarks.png") });

  await page.evaluate(() => {
    const state = window.__CAT_WORKSHOP__.state();
    state.playerBuildingInventory = { stone: 6, plank: 2, tools: 1 };
    window.advanceTime(1);
  });
  await buildButton.click();
  const beforeFailure = (await stateText()).world.warehouse.inventory;
  await clickTile({ x: 0, y: 0 });
  await page.waitForSelector('[data-testid="landmark-message"]');
  const afterFailure = (await stateText()).world.warehouse.inventory;
  if (JSON.stringify(beforeFailure) !== JSON.stringify(afterFailure)) throw new Error("failed placement consumed materials");
  await page.screenshot({ path: path.join(outputDir, "06-failed-placement-atomic.png"), fullPage: true });
  await page.keyboard.press("Escape");

  await clickTile({ x: 0, y: 0 });
  await page.waitForSelector('[data-testid="cat-landmark-effects"]');
  const inspectorText = await page.locator('[data-testid="cat-landmark-effects"]').innerText();
  if (!inspectorText.includes("创业广场×3") || !inspectorText.includes("30%")) throw new Error("cat inspector does not show landmark stacks and total bonus");
  await page.screenshot({ path: path.join(outputDir, "07-cat-inspector-effects.png"), fullPage: true });

  await page.getByRole("button", { name: "仓库", exact: true }).click();
  const firstDismantle = page.locator('[data-testid^="deployed-landmark-"]').first().getByRole("button", { name: "拆除" });
  await firstDismantle.click();
  text = await stateText();
  if (text.world.landmarkEngineering.deployed.length !== 2) throw new Error("dismantle did not remove one landmark");
  if (text.world.warehouse.inventory.stone !== 9 || text.world.warehouse.inventory.plank !== 3 || text.world.warehouse.inventory.tools !== 1) {
    throw new Error(`unexpected dismantle refund: ${JSON.stringify(text.world.warehouse.inventory)}`);
  }
  await page.screenshot({ path: path.join(outputDir, "08-dismantled-refund.png"), fullPage: true });

  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify({ ok: errors.length === 0, errors, final: text }, null, 2));
  if (errors.length) throw new Error(errors.join("\n"));
  process.stdout.write(JSON.stringify({ ok: true, screenshots: 8, finalLandmarks: text.world.landmarkEngineering.deployed.length }));
} finally {
  await browser.close();
}
