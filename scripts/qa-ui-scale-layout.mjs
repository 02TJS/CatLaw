import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outputDir = path.resolve("output/ui-scale-layout");
fs.mkdirSync(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 760, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(String(error)));

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const box = async (selector) => {
  const value = await page.locator(selector).boundingBox();
  if (!value) throw new Error(`missing layout box: ${selector}`);
  return value;
};

try {
  await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.evaluate(() => document.documentElement.classList.add("desktop-shell"));
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByTestId("control-scale").fill("125");
  await page.getByTestId("interface-font-scale").fill("150");
  await page.getByTestId("speech-bubble-scale").fill("175");
  await page.getByTestId("map-scale").fill("135");
  await page.waitForTimeout(120);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("cat-workshop-ui-preferences-v1")));
  assert(stored.controlScale === 1.25 && stored.interfaceFontScale === 1.5
    && stored.speechBubbleScale === 1.75 && stored.mapScale === 1.35,
  `preferences were not persisted independently: ${JSON.stringify(stored)}`);
  assert(await page.getByTestId("control-scale").getAttribute("min") === "50"
    && await page.getByTestId("control-scale").getAttribute("max") === "180", "control range was not doubled");
  assert(await page.getByTestId("interface-font-scale").getAttribute("min") === "50"
    && await page.getByTestId("interface-font-scale").getAttribute("max") === "220", "interface font range was not doubled");
  assert(await page.getByTestId("speech-bubble-scale").getAttribute("min") === "50"
    && await page.getByTestId("speech-bubble-scale").getAttribute("max") === "220", "speech range was not doubled");

  const drag = await box(".pet-drag-region");
  const headline = await box(".pet-headline-stats");
  const windowControls = await box(".pet-window-controls");
  const quickStats = await box(".pet-quick-stats");
  const drawer = await box(".pet-drawer");
  const windowClose = await box("[data-testid=close-window]");
  const drawerClose = await box("[data-testid=close-drawer]");
  const titleBottom = Math.max(drag.y + drag.height, headline.y + headline.height, windowControls.y + windowControls.height);

  assert(quickStats.y >= titleBottom + 6, `quick stats overlap the title safe area: ${JSON.stringify({ titleBottom, quickStats })}`);
  assert(drawer.y >= titleBottom + 6, `drawer overlaps the title safe area: ${JSON.stringify({ titleBottom, drawer })}`);
  assert(!overlaps(windowClose, drawerClose), `global and drawer close buttons overlap: ${JSON.stringify({ windowClose, drawerClose })}`);
  assert(await page.locator(".pet-canvas-hint").count() === 0, "obsolete canvas instruction bubble is still present");

  const textState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(textState.visualPreferences.controlScale === 1.25, "text state omitted the control scale");
  assert(textState.visualPreferences.interfaceFontScale === 1.5, "text state omitted the interface font scale");
  assert(textState.visualPreferences.speechBubbleScale === 1.75, "speech bubble scale was coupled to interface text");
  assert(textState.visualPreferences.mapScale === 1.35, "text state omitted the map scale");
  assert(await page.getByTestId("game-canvas").getAttribute("data-map-scale") === "1.35", "canvas did not receive the map scale");
  await page.screenshot({ path: path.join(outputDir, "scaled-settings-and-safe-top.png"), omitBackground: true });

  await page.getByTestId("control-scale").fill("180");
  await page.getByTestId("interface-font-scale").fill("220");
  await page.getByTestId("speech-bubble-scale").fill("220");
  await page.getByTestId("map-scale").fill("200");
  await page.waitForTimeout(120);
  const maximumDrag = await box(".pet-drag-region");
  const maximumHeadline = await box(".pet-headline-stats");
  const maximumWindowControls = await box(".pet-window-controls");
  const maximumQuickStats = await box(".pet-quick-stats");
  const maximumDrawer = await box(".pet-drawer");
  const maximumWindowClose = await box("[data-testid=close-window]");
  const maximumDrawerClose = await box("[data-testid=close-drawer]");
  const dockButtons = await page.locator(".pet-dock button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().toJSON()));
  const viewportWidth = await page.evaluate(() => innerWidth);
  const viewportHeight = await page.evaluate(() => innerHeight);
  const maximumTitleBottom = Math.max(maximumDrag.y + maximumDrag.height, maximumHeadline.y + maximumHeadline.height, maximumWindowControls.y + maximumWindowControls.height);
  for (const [name, control] of Object.entries({ maximumDrag, maximumHeadline, maximumWindowControls, maximumWindowClose, maximumDrawerClose })) {
    assert(control.x >= 0 && control.y >= 0 && control.x + control.width <= viewportWidth && control.y + control.height <= viewportHeight,
      `${name} is clipped at maximum visual scales: ${JSON.stringify(control)}`);
  }
  assert(!overlaps(maximumDrag, maximumHeadline), "maximum title and treasury capsules overlap");
  assert(!overlaps(maximumDrag, maximumWindowControls), "maximum title and window-control capsules overlap");
  assert(!overlaps(maximumHeadline, maximumWindowControls), "maximum treasury and window-control capsules overlap");
  assert(maximumQuickStats.y >= maximumTitleBottom + 6, "maximum quick stats overlap the responsive title safe area");
  assert(maximumDrawer.y >= maximumTitleBottom + 6, "maximum drawer overlaps the responsive title safe area");
  assert(!overlaps(maximumQuickStats, maximumDrawer), "maximum drawer overlaps the quick statistics controls");
  assert(!overlaps(maximumWindowClose, maximumDrawerClose), "maximum close buttons overlap");
  assert(dockButtons.every((button) => button.left >= 0 && button.right <= viewportWidth), `maximum controls overflow the viewport: ${JSON.stringify(dockButtons)}`);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "maximum visual scales created horizontal page overflow");
  await page.screenshot({ path: path.join(outputDir, "maximum-visual-scales.png"), omitBackground: true });

  await page.getByTestId("close-drawer").click();
  await page.getByTestId("map-lens-button").click();
  await page.waitForTimeout(80);
  const maximumPalette = await box(".map-lens-palette");
  const maximumDock = await box(".pet-dock");
  assert(maximumPalette.y + maximumPalette.height <= maximumDock.y - 6,
    `maximum filter palette overlaps the wrapped dock: ${JSON.stringify({ maximumPalette, maximumDock })}`);
  await page.screenshot({ path: path.join(outputDir, "maximum-filter-and-wrapped-dock.png"), omitBackground: true });
  await page.getByTestId("map-lens-button").click();
  await page.getByTestId("expand-mode-button").click();
  await page.getByTestId("open-settings").click();

  await page.getByTestId("control-scale").fill("125");
  await page.getByTestId("interface-font-scale").fill("150");
  await page.getByTestId("speech-bubble-scale").fill("175");
  await page.getByTestId("map-scale").fill("135");
  await page.waitForTimeout(80);

  await page.getByTestId("close-drawer").click();
  await page.evaluate(async () => window.__CAT_WORKSHOP__.reset());
  let speechState = null;
  for (let elapsed = 0; elapsed < 120_000; elapsed += 250) {
    await page.evaluate(() => window.advanceTime(250));
    const candidate = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    if (candidate.speechBubbles.some((bubble) => bubble.visible)) {
      speechState = candidate;
      break;
    }
  }
  assert(speechState, "no visible speech bubble appeared for scaled-font visual QA");
  assert(speechState.visualPreferences.speechBubbleScale === 1.75, "visible speech bubble did not retain its independent 175% scale");
  await page.screenshot({ path: path.join(outputDir, "scaled-speech-bubble.png"), omitBackground: true });

  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => document.documentElement.classList.add("desktop-shell"));
  await page.getByTestId("open-settings").click();
  assert(await page.getByTestId("control-scale").inputValue() === "125", "control scale did not survive reload");
  assert(await page.getByTestId("interface-font-scale").inputValue() === "150", "interface font scale did not survive reload");
  assert(await page.getByTestId("speech-bubble-scale").inputValue() === "175", "speech bubble scale did not survive reload");
  assert(await page.getByTestId("map-scale").inputValue() === "135", "map scale did not survive reload");
  assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);

  const result = {
    ok: true,
    stored,
    titleBottom,
    quickStats,
    drawer,
    windowClose,
    drawerClose,
    maximumLayout: {
      drag: maximumDrag,
      headline: maximumHeadline,
      windowControls: maximumWindowControls,
      quickStats: maximumQuickStats,
      drawer: maximumDrawer,
      windowClose: maximumWindowClose,
      drawerClose: maximumDrawerClose,
      palette: maximumPalette,
      dock: maximumDock,
    },
    textPreferences: textState.visualPreferences,
    visibleSpeechBubbles: speechState.speechBubbles.filter((bubble) => bubble.visible),
    errors,
  };
  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
