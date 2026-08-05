import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outputDir = path.resolve("output/speech-frequency");
fs.mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 920, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(error.message));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

try {
  await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.waitForFunction(() => typeof window.render_game_to_text === "function" && window.__CAT_WORKSHOP__);
  await page.evaluate(() => window.__CAT_WORKSHOP__.reset());
  await page.getByTestId("open-settings").click();

  const slider = page.getByTestId("speech-frequency");
  await slider.waitFor();
  assert(await slider.inputValue() === "70", `default frequency is not 70: ${await slider.inputValue()}`);
  await page.locator(".pet-drawer").screenshot({ path: path.join(outputDir, "settings-70.png") });

  await slider.fill("0");
  assert(await page.evaluate(() => window.__CAT_WORKSHOP__.state().speechFrequency) === 0, "slider did not set frequency to zero");
  await page.evaluate(() => window.advanceTime(20_000));
  let textState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(textState.visualPreferences.speechFrequencyPercent === 0, "text state did not expose zero frequency");
  assert(textState.speechBubbles.length === 0, "zero frequency still emitted speech");

  await slider.fill("100");
  assert(await page.evaluate(() => window.__CAT_WORKSHOP__.state().speechFrequency) === 100, "slider did not set frequency to 100");
  await page.evaluate(() => window.advanceTime(10_000));
  textState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(textState.visualPreferences.speechFrequencyPercent === 100, "text state did not expose 100 frequency");
  assert(textState.speechBubbles.length > 0 && textState.speechBubbles.length <= 5, `100 frequency emitted ${textState.speechBubbles.length} bubbles`);
  const hundredBubbleCount = textState.speechBubbles.length;
  await page.screenshot({ path: path.join(outputDir, "frequency-100.png"), omitBackground: true });

  await slider.fill("40");
  assert(await page.evaluate(() => window.__CAT_WORKSHOP__.state().speechFrequency) === 40, "slider did not set frequency to 40");
  textState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(textState.speechBubbles.length <= 2, `lowering to 40 did not immediately trim speech: ${textState.speechBubbles.length}`);
  await page.evaluate(() => window.advanceTime(10_000));
  textState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(textState.speechBubbles.length > 0 && textState.speechBubbles.length <= 2, `40 frequency emitted ${textState.speechBubbles.length} bubbles`);
  const fortyBubbleCount = textState.speechBubbles.length;
  assert(fortyBubbleCount < hundredBubbleCount, `frequency did not visibly change the result: 40=${fortyBubbleCount}, 100=${hundredBubbleCount}`);
  await page.screenshot({ path: path.join(outputDir, "frequency-40.png"), omitBackground: true });

  await slider.fill("70");
  assert(await page.evaluate(() => window.__CAT_WORKSHOP__.state().speechFrequency) === 70, "slider did not restore frequency to 70");
  assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify({
    ok: true,
    defaultFrequency: 70,
    zeroBubbleCount: 0,
    fortyBubbleCount,
    hundredBubbleCount,
    restoredFrequency: 70,
    errors,
  }, null, 2));
  console.log(JSON.stringify({ ok: true, hundredBubbleCount: textState.speechBubbles.length, errors }));
} finally {
  await browser.close();
}
