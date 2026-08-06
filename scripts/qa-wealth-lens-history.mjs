import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const outputDir = path.resolve("output", "wealth-lens-history");
fs.mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 760, height: 720 } });
const page = await context.newPage();
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));

try {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("desktop-shell"));
    localStorage.setItem("cat-workshop-ui-preferences-v1", JSON.stringify({
      controlScale: 1.8,
      interfaceFontScale: 2.2,
      speechBubbleScale: 1,
      mapScale: 1,
    }));
  });
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__CAT_WORKSHOP__ && window.advanceTime));
  await page.evaluate(() => window.advanceTime(65_000));

  await page.getByTestId("map-lens-button").click();
  await page.getByTestId("map-lens-wealth").click();
  const controls = page.getByTestId("wealth-lens-controls");
  await controls.waitFor();
  let state = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(state.world.mapLens.wealthNormalization.mode === "total", "wealth lens did not start in total mode");
  assert(state.world.mapLens.title.includes("当前总量"), `unexpected total title: ${state.world.mapLens.title}`);
  await page.screenshot({ path: path.join(outputDir, "maximum-total.png"), omitBackground: true });

  await page.getByTestId("wealth-lens-change").click();
  await page.getByTestId("wealth-window-15000").click();
  state = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const fifteen = state.world.mapLens.wealthNormalization;
  assert(fifteen.mode === "change" && fifteen.windowMs === 15_000, `15-second mode mismatch: ${JSON.stringify(fifteen)}`);
  assert(fifteen.baselineAtMs !== null && fifteen.historySamples >= 13, `wealth history was not sampled: ${JSON.stringify(fifteen)}`);
  assert(fifteen.cats.some((cat) => cat.value !== 0), "all recent wealth changes were unexpectedly zero");
  assert(state.world.mapLens.title.includes("近15秒增量"), `unexpected delta title: ${state.world.mapLens.title}`);
  await page.screenshot({ path: path.join(outputDir, "maximum-change-15s.png"), omitBackground: true });

  await page.getByTestId("map-lens-button").click();
  assert(!await page.getByTestId("map-lens-palette").isVisible().catch(() => false), "filter palette did not close over the active heat map");
  await page.screenshot({ path: path.join(outputDir, "maximum-change-15s-map.png"), omitBackground: true });
  await page.getByTestId("map-lens-button").click();

  await page.getByTestId("wealth-window-300000").click();
  state = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(state.world.mapLens.wealthNormalization.windowMs === 300_000, "five-minute window was not selected");
  const paletteBox = await page.getByTestId("map-lens-palette").boundingBox();
  const dockBox = await page.locator(".pet-dock").boundingBox();
  assert(paletteBox && dockBox, "missing palette or dock layout box");
  assert(paletteBox.x >= 0 && paletteBox.y >= 0 && paletteBox.x + paletteBox.width <= 760,
    `wealth controls are clipped: ${JSON.stringify(paletteBox)}`);
  assert(paletteBox.y + paletteBox.height <= dockBox.y,
    `wealth controls overlap the dock: palette=${JSON.stringify(paletteBox)} dock=${JSON.stringify(dockBox)}`);
  await page.screenshot({ path: path.join(outputDir, "maximum-change-5m.png"), omitBackground: true });

  await page.waitForTimeout(1_300);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__CAT_WORKSHOP__ && window.advanceTime));
  const persistedHistory = await page.evaluate(() => window.__CAT_WORKSHOP__.state().wealthHistory);
  assert(persistedHistory.length >= 13, "wealth history did not survive reload");
  await page.getByTestId("map-lens-button").click();
  await page.getByTestId("map-lens-wealth").click();
  state = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(state.world.mapLens.wealthNormalization.mode === "change"
    && state.world.mapLens.wealthNormalization.windowMs === 300_000,
  `wealth lens preferences did not persist: ${JSON.stringify(state.world.mapLens.wealthNormalization)}`);
  assert(errors.length === 0, errors.join(" | "));

  const result = {
    ok: true,
    historySamples: persistedHistory.length,
    mode: state.world.mapLens.wealthNormalization.mode,
    windowMs: state.world.mapLens.wealthNormalization.windowMs,
    paletteBox,
    dockBox,
    errors,
  };
  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
