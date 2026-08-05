import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outputDir = path.resolve("output/world-object-badges");
fs.mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 760, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));

const url = process.argv[2] ?? "http://127.0.0.1:5173";

try {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__CAT_WORKSHOP__ && typeof window.render_game_to_text === "function");
  await page.evaluate(async () => {
    await window.__CAT_WORKSHOP__.reset(3);
    const clone = globalThis.structuredClone;
    globalThis.structuredClone = (value) => value;
    try {
      const state = window.__CAT_WORKSHOP__.state();
      state.paused = true;
      state.cats = [];
      state.buildings = [];
      state.landmarks = [];
      state.floatingEvents = [];
      state.resourceNodes = [
        { id: "qa-resource-wood", itemId: "wood", position: { x: -3, y: 1 } },
        { id: "qa-resource-stone", itemId: "stone", position: { x: -2, y: 0 } },
        { id: "qa-resource-sand", itemId: "sand", position: { x: -1, y: -1 } },
        { id: "qa-resource-water", itemId: "water", position: { x: 0, y: 2 } },
        { id: "qa-resource-fiber", itemId: "fiber", position: { x: 1, y: 1 } },
        { id: "qa-resource-ore", itemId: "ore", position: { x: 2, y: 0 } },
      ];
    } finally {
      globalThis.structuredClone = clone;
    }
    window.advanceTime(1);
  });
  await page.waitForTimeout(180);
  await page.getByTestId("game-canvas").screenshot({
    path: path.join(outputDir, "01-resources-white-centered.png"),
    omitBackground: true,
  });

  await page.evaluate(() => {
    const clone = globalThis.structuredClone;
    globalThis.structuredClone = (value) => value;
    try {
      const state = window.__CAT_WORKSHOP__.state();
      state.resourceNodes = [];
      state.buildings = [
        { id: "qa-building-factory", itemId: "factory", position: { x: -3, y: 1 }, deployedAt: 0 },
        { id: "qa-building-machine", itemId: "machine_tool", position: { x: -1, y: -1 }, deployedAt: 0 },
        { id: "qa-building-antenna", itemId: "antenna", position: { x: 1, y: -3 }, deployedAt: 0 },
        { id: "qa-building-lab", itemId: "lab", position: { x: 0, y: 2 }, deployedAt: 0 },
        { id: "qa-building-reactor", itemId: "reactor", position: { x: 2, y: 0 }, deployedAt: 0 },
      ];
    } finally {
      globalThis.structuredClone = clone;
    }
    window.advanceTime(1);
  });
  await page.waitForTimeout(180);
  await page.getByTestId("game-canvas").screenshot({
    path: path.join(outputDir, "02-buildings-graded-centered.png"),
    omitBackground: true,
  });

  const text = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const buildingCount = await page.evaluate(() => {
    const clone = globalThis.structuredClone;
    globalThis.structuredClone = (value) => value;
    try {
      return window.__CAT_WORKSHOP__.state().buildings.length;
    } finally {
      globalThis.structuredClone = clone;
    }
  });
  if (buildingCount !== 5) throw new Error(`expected 5 building fixtures, got ${buildingCount}`);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const result = {
    ok: true,
    resourceIds: ["wood", "stone", "sand", "water", "fiber", "ore"],
    buildingIds: ["factory", "machine_tool", "antenna", "lab", "reactor"],
    screenshots: 2,
    errors,
  };
  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result));
} finally {
  await browser.close();
}
