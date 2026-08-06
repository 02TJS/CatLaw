import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const outputDir = path.resolve("output", "map-lens-item-picker");
fs.mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const cases = [
  { id: "minimum", controlScale: 0.5, interfaceFontScale: 0.5 },
  { id: "default", controlScale: 1, interfaceFontScale: 1 },
  { id: "maximum", controlScale: 1.8, interfaceFontScale: 2.2 },
];
const results = [];

try {
  for (const testCase of cases) {
    const context = await browser.newContext({ viewport: { width: 760, height: 720 } });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));
    await page.addInitScript((preferences) => {
      document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("desktop-shell"));
      localStorage.setItem("cat-workshop-ui-preferences-v1", JSON.stringify({
        ...preferences,
        speechBubbleScale: 1,
        mapScale: 1,
      }));
    }, testCase);
    await page.goto(process.argv[2] ?? "http://127.0.0.1:5173", { waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean(window.__CAT_WORKSHOP__ && window.advanceTime));
    await page.evaluate(() => window.advanceTime(11_000));

    // Reproduce the reported case exactly: the computer blueprint exists in
    // this isolated save, but no cat has crafted a computer yet.  Persist and
    // reload so this exercises the real UI/state boundary rather than a DOM
    // shortcut or Playwright's selectOption().
    await page.evaluate(async () => {
      const state = window.__CAT_WORKSHOP__.state();
      if (!state.unlockedRecipes.includes("make_computer")) state.unlockedRecipes.push("make_computer");
      await new Promise((resolve, reject) => {
        const request = indexedDB.open("cat-law-workshop", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction("saves", "readwrite");
          transaction.objectStore("saves").put(state, "autosave");
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      });
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean(window.__CAT_WORKSHOP__ && window.advanceTime));

    await page.getByTestId("map-lens-button").click();
    await page.getByTestId("map-lens-orders").click();
    const trigger = page.getByTestId("map-lens-item");
    await trigger.click();
    const options = page.getByTestId("map-lens-item-options");
    await options.waitFor();
    const values = await options.locator("[data-item-id]").evaluateAll((buttons) => (
      buttons.map((button) => button.getAttribute("data-item-id"))
    ));
    assert(values.includes("wood"), `${testCase.id}: discovered wood is missing`);
    assert(values.includes("fire"), `${testCase.id}: unlocked fire is missing before first craft`);
    assert(values.includes("computer"), `${testCase.id}: unlocked computer is missing before first craft`);

    const computer = page.getByTestId("map-lens-item-computer");
    await computer.scrollIntoViewIfNeeded();
    const computerBox = await computer.boundingBox();
    assert(computerBox, `${testCase.id}: computer option has no pointer box`);
    const hit = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return element?.getAttribute("data-testid") ?? element?.tagName ?? null;
    }, { x: computerBox.x + computerBox.width / 2, y: computerBox.y + computerBox.height / 2 });
    assert(hit === "map-lens-item-computer", `${testCase.id}: pointer hits ${hit} instead of computer`);
    await page.mouse.click(computerBox.x + computerBox.width / 2, computerBox.y + computerBox.height / 2);
    await page.waitForTimeout(50);
    const selectedState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    assert(selectedState.world.mapLens.id === "orders", `${testCase.id}: order lens was lost`);
    assert(selectedState.world.mapLens.itemId === "computer", `${testCase.id}: real pointer click did not select computer`);
    assert(await trigger.getAttribute("data-value") === "computer", `${testCase.id}: trigger did not display selected value`);
    assert(!await options.isVisible().catch(() => false), `${testCase.id}: options did not close after selection`);

    await trigger.click();
    const optionBox = await options.boundingBox();
    const dockBox = await page.locator(".pet-dock").boundingBox();
    assert(optionBox && dockBox, `${testCase.id}: missing option or dock box`);
    assert(optionBox.x >= 0 && optionBox.y >= 0 && optionBox.x + optionBox.width <= 760 && optionBox.y + optionBox.height <= 720,
      `${testCase.id}: item options are clipped outside the desktop pet`);
    assert(optionBox.y + optionBox.height <= dockBox.y,
      `${testCase.id}: item options overlap the dock`);
    if (testCase.id === "maximum") {
      await page.screenshot({ path: path.join(outputDir, "maximum-options-open.png"), omitBackground: true });
    }
    await page.keyboard.press("Escape");
    assert(!await options.isVisible().catch(() => false), `${testCase.id}: Escape did not close item options`);
    assert(await page.getByTestId("map-lens-palette").isVisible(), `${testCase.id}: Escape closed the whole filter palette`);

    await page.screenshot({
      path: path.join(outputDir, `${testCase.id}-orders-computer.png`),
      omitBackground: true,
    });
    assert(errors.length === 0, `${testCase.id}: ${errors.join(" | ")}`);
    results.push({ ...testCase, selectableItems: values, selectedItemId: selectedState.world.mapLens.itemId, optionBox, dockBox, errors });
    await context.close();
  }
  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify({ ok: true, results }, null, 2));
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  await browser.close();
}
