import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outputDir = path.resolve("output/factory-resource-placement");
fs.mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 760, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));

try {
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__CAT_WORKSHOP__ && typeof window.advanceTime === "function");
  await page.evaluate(async () => {
    await window.__CAT_WORKSHOP__.reset(3);
    const clone = globalThis.structuredClone;
    globalThis.structuredClone = (value) => value;
    try {
      const state = window.__CAT_WORKSHOP__.state();
      state.paused = true;
      state.cats = [];
      state.resourceNodes = [{ id: "qa-wood", itemId: "wood", position: { x: -2, y: 1 } }];
      state.buildings = [];
      state.landmarks = [];
      state.playerBuildingInventory = { factory: 1 };
    } finally {
      globalThis.structuredClone = clone;
    }
    window.advanceTime(1);
  });

  await page.getByRole("button", { name: /仓库/ }).click();
  await page.getByTestId("place-building-factory").click();
  const canvas = page.getByTestId("game-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no layout box");
  const tile = { x: -3, y: 1 };
  const point = {
    x: box.x + box.width / 2 + (((tile.x - tile.y) * 64) - 32) * 1.08,
    y: box.y + box.height / 2 + (((tile.x + tile.y) * 32) - 28) * 1.08,
  };
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(120);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(160);

  const state = await page.evaluate(() => window.__CAT_WORKSHOP__.state());
  const factory = state.buildings.find((building) => building.itemId === "factory");
  if (!factory || factory.position.x !== tile.x || factory.position.y !== tile.y) {
    throw new Error(`factory was not placed on the resource harvest cell: ${JSON.stringify(state.buildings)}`);
  }
  if (state.resourceNodes[0].position.x === tile.x && state.resourceNodes[0].position.y === tile.y) {
    throw new Error("fixture accidentally targeted the resource center instead of a neighboring harvest cell");
  }
  await page.screenshot({ path: path.join(outputDir, "factory-on-resource-harvest-cell.png"), omitBackground: true });
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const result = { ok: true, resourceCenter: state.resourceNodes[0].position, factoryPosition: factory.position, errors };
  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result));
} finally {
  await browser.close();
}
