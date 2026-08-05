import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outputDir = path.resolve("artifacts/filter-discoverability");
fs.mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 760, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));

try {
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__CAT_WORKSHOP__ && typeof window.render_game_to_text === "function");
  const trigger = page.getByTestId("map-lens-button");
  if (!await trigger.isVisible()) throw new Error("persistent Filter dock entry is not visible");
  if (!(await trigger.innerText()).includes("滤镜")) throw new Error(`unexpected Filter label: ${await trigger.innerText()}`);
  if (await page.getByTestId("map-lens-palette").isVisible().catch(() => false)) throw new Error("filter choices should start closed");

  await trigger.click();
  const palette = page.getByTestId("map-lens-palette");
  await palette.waitFor();
  const choices = await palette.locator("button").allTextContents();
  if (choices.length !== 8) throw new Error(`expected ordinary plus seven filters, got ${choices.length}`);
  const layout = await palette.evaluate((element) => {
    const buttons = [...element.querySelectorAll("button")];
    return {
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      columns: getComputedStyle(element).gridTemplateColumns.split(" ").length,
      boxes: buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }),
    };
  });
  if (layout.boxes.some((box) => box.left < 0 || box.right > layout.viewportWidth || box.top < 0 || box.bottom > layout.viewportHeight)) {
    throw new Error("at least one filter choice is clipped outside the compact pet viewport");
  }
  if (layout.columns !== 4) throw new Error(`expected four-column filter grid, got ${layout.columns}`);
  await page.screenshot({ path: path.join(outputDir, "compact-filter-options.png"), omitBackground: false });

  await page.getByTestId("map-lens-orders").click();
  const state = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  if (state.world?.mapLens?.id !== "orders" || !state.world?.mapInteractionMode) throw new Error("one-click Filter entry did not activate map/lens mode");
  if (!state.world?.mapLens?.actionItemsHidden) throw new Error("analysis lens did not suppress standard action icons");
  if (!state.world?.mapLens?.speechBubblesHidden) throw new Error("analysis lens did not suppress cat speech bubbles");
  if (errors.length > 0) throw new Error(errors.join("\n"));
  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify({ ok: true, choices, columns: layout.columns, errors }, null, 2));
  process.stdout.write(JSON.stringify({ ok: true, choices, columns: layout.columns, errors }));
} finally {
  await browser.close();
}
