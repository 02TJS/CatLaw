import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const outputDir = path.resolve("output", "electron-wealth-lens-history", `run-${Date.now()}`);
fs.mkdirSync(outputDir, { recursive: true });
const packagedExecutable = process.env.CAT_WORKSHOP_EXECUTABLE;
const electronApp = await electron.launch({
  ...(packagedExecutable
    ? { executablePath: packagedExecutable, args: [`--user-data-dir=${path.join(outputDir, "user-data")}`] }
    : { args: [`--user-data-dir=${path.join(outputDir, "user-data")}`, path.resolve(".")] }),
  env: { ...process.env, CAT_WORKSHOP_PORT: "18859" },
});

try {
  const page = await electronApp.firstWindow();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));
  await page.waitForSelector("[data-testid=game-canvas]", { timeout: 30_000 });
  await page.evaluate(() => window.advanceTime(65_000));

  const canvasBox = await page.getByTestId("game-canvas").boundingBox();
  assert(canvasBox, "game canvas has no pointer box");
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  await page.mouse.wheel(0, -4_000);
  await page.waitForTimeout(500);

  await page.getByTestId("map-lens-button").click();
  await page.getByTestId("map-lens-wealth").click();
  await page.getByTestId("wealth-lens-change").click();
  const fiveMinutes = page.getByTestId("wealth-window-300000");
  const optionBox = await fiveMinutes.boundingBox();
  assert(optionBox, "five-minute wealth option has no pointer box");
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("data-testid"), {
    x: optionBox.x + optionBox.width / 2,
    y: optionBox.y + optionBox.height / 2,
  });
  assert(hit === "wealth-window-300000", `pointer hits ${hit} instead of five-minute wealth option`);
  await page.mouse.click(optionBox.x + optionBox.width / 2, optionBox.y + optionBox.height / 2);

  const state = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const wealth = state.world.mapLens.wealthNormalization;
  assert(wealth.mode === "change" && wealth.windowMs === 300_000, `packaged wealth controls failed: ${JSON.stringify(wealth)}`);
  assert(wealth.historySamples >= 13 && wealth.baselineAtMs !== null, `packaged history missing: ${JSON.stringify(wealth)}`);
  const paletteBox = await page.getByTestId("map-lens-palette").boundingBox();
  const dockBox = await page.locator(".pet-dock").boundingBox();
  assert(paletteBox && dockBox && paletteBox.y + paletteBox.height <= dockBox.y,
    `packaged wealth controls overlap dock: ${JSON.stringify({ paletteBox, dockBox })}`);
  await page.screenshot({ path: path.join(outputDir, "packaged-135-change-5m.png"), omitBackground: true });
  await page.getByTestId("map-lens-button").click();
  await page.screenshot({ path: path.join(outputDir, "packaged-135-change-map.png"), omitBackground: true });
  assert(errors.length === 0, errors.join(" | "));

  const bounds = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  const result = { ok: true, outputDir, bounds, hit, wealth, paletteBox, dockBox, errors };
  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await electronApp.close().catch(() => undefined);
}
