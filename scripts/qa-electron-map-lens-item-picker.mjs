import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const outputDir = path.resolve("output", "electron-map-lens-item-picker", `run-${Date.now()}`);
fs.mkdirSync(outputDir, { recursive: true });
const packagedExecutable = process.env.CAT_WORKSHOP_EXECUTABLE;
const electronApp = await electron.launch({
  ...(packagedExecutable
    ? { executablePath: packagedExecutable, args: [`--user-data-dir=${path.join(outputDir, "user-data")}`] }
    : { args: [`--user-data-dir=${path.join(outputDir, "user-data")}`, path.resolve(".")] }),
  env: { ...process.env, CAT_WORKSHOP_PORT: "18858" },
});

try {
  const page = await electronApp.firstWindow();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));
  await page.waitForSelector("[data-testid=game-canvas]", { timeout: 30_000 });
  await page.evaluate(() => window.advanceTime(11_000));

  const results = [];
  for (const testCase of [
    { id: "native-100", wheel: 0, itemId: "wood" },
    { id: "native-55", wheel: 4_000, itemId: "stone" },
    { id: "native-135", wheel: -4_000, itemId: "fire" },
  ]) {
    if (testCase.wheel) {
      const canvas = page.getByTestId("game-canvas");
      const canvasBox = await canvas.boundingBox();
      assert(canvasBox, `${testCase.id}: canvas has no pointer box`);
      await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
      await page.mouse.wheel(0, testCase.wheel);
      await page.waitForTimeout(500);
    }
    const bounds = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    await page.getByTestId("map-lens-button").click();
    await page.getByTestId("map-lens-orders").click();
    await page.getByTestId("map-lens-item").click();
    const option = page.getByTestId(`map-lens-item-${testCase.itemId}`);
    await option.scrollIntoViewIfNeeded();
    const optionBox = await option.boundingBox();
    assert(optionBox, `${testCase.id}: ${testCase.itemId} has no pointer box`);
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("data-testid"), {
      x: optionBox.x + optionBox.width / 2,
      y: optionBox.y + optionBox.height / 2,
    });
    assert(hit === `map-lens-item-${testCase.itemId}`, `${testCase.id}: pointer hits ${hit}`);
    await page.mouse.click(optionBox.x + optionBox.width / 2, optionBox.y + optionBox.height / 2);
    await page.waitForTimeout(80);
    const state = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    assert(state.world.mapLens.id === "orders", `${testCase.id}: order lens was lost`);
    assert(state.world.mapLens.itemId === testCase.itemId, `${testCase.id}: ${testCase.itemId} was not selected`);
    await page.screenshot({ path: path.join(outputDir, `${testCase.id}-${testCase.itemId}.png`), omitBackground: true });
    results.push({ ...testCase, bounds, selectedItemId: state.world.mapLens.itemId, hit });
    await page.getByTestId("expand-mode-button").click();
  }
  assert(errors.length === 0, errors.join(" | "));
  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify({ ok: true, results, errors }, null, 2));
  console.log(JSON.stringify({ ok: true, outputDir, results, errors }, null, 2));
} finally {
  await electronApp.close().catch(() => undefined);
}
