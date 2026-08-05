import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const output = path.resolve("output/map-mode-qa");
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 760, height: 720 }, deviceScaleFactor: 1 });
await context.addInitScript(() => {
  const calls = [];
  window.__DESKTOP_INPUT_CALLS__ = calls;
  window.catWorkshopDesktop = {
    beginWindowDrag: (x, y) => calls.push({ kind: "begin", x, y }),
    moveWindowDrag: (x, y) => calls.push({ kind: "move", x, y }),
    endWindowDrag: () => calls.push({ kind: "end" }),
    scaleWindow: (deltaY, x, y) => { calls.push({ kind: "scale", deltaY, x, y }); return Promise.resolve(1); },
    openRecipesInBrowser: () => Promise.resolve(),
    toggleAlwaysOnTop: () => Promise.resolve(true),
    minimize: () => {},
    close: () => {},
  };
});
const page = await context.newPage();
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(String(error)));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

try {
  await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
  const canvas = page.getByTestId("game-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("game canvas has no box");
  const start = { x: box.x + box.width * 0.68, y: box.y + box.height * 0.42 };

  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(start.x + 70, start.y + 45);
  await page.mouse.up({ button: "left" });
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(80);
  const normalCalls = await page.evaluate(() => [...window.__DESKTOP_INPUT_CALLS__]);
  assert(normalCalls.some((call) => call.kind === "move"), "normal desktop canvas drag did not move the native pet");
  assert(normalCalls.some((call) => call.kind === "scale"), "normal desktop wheel did not scale the native pet");

  await page.getByTestId("expand-mode-button").click();
  const activeText = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(activeText.world.mapInteractionMode === true, "Map button did not enter map interaction mode");
  const callsBeforeMapInput = normalCalls.length;
  const scaleBefore = activeText.visualPreferences.mapScale;
  const eastParcelTile = { x: 5, y: 0 };
  const eastParcelPoint = {
    x: box.x + box.width / 2 + ((eastParcelTile.x - eastParcelTile.y) * 64 - 32) * 1.08,
    y: box.y + box.height / 2 + ((eastParcelTile.x + eastParcelTile.y) * 32 - 28) * 1.08,
  };
  await page.mouse.click(eastParcelPoint.x, eastParcelPoint.y);
  await page.waitForTimeout(100);
  const expanded = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(expanded.world.unlockedParcels.some((parcel) => parcel.x === 1 && parcel.y === 0), "combined Map mode no longer supports click-to-expand");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(start.x + 60, start.y + 35);
  await page.mouse.up({ button: "left" });
  await page.mouse.wheel(0, -260);
  await page.waitForTimeout(100);
  const afterMapInput = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const callsAfterMapInput = await page.evaluate(() => [...window.__DESKTOP_INPUT_CALLS__]);
  assert(callsAfterMapInput.length === callsBeforeMapInput, `map input leaked to native window handlers: ${JSON.stringify(callsAfterMapInput.slice(callsBeforeMapInput))}`);
  assert(afterMapInput.visualPreferences.mapScale > scaleBefore, "map-mode wheel did not enlarge the Canvas map");

  await page.getByTestId("expand-mode-button").click();
  await page.screenshot({ path: path.join(output, "map-mode-expanded.png"), omitBackground: true });
  assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({
    ok: true,
    normalNativeCalls: normalCalls,
    nativeCallsDuringMapMode: callsAfterMapInput.slice(callsBeforeMapInput),
    scaleBefore,
    scaleAfter: afterMapInput.visualPreferences.mapScale,
    unlockedParcels: expanded.world.unlockedParcels,
    errors,
  }, null, 2));
} finally {
  await browser.close();
}
