import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";

const executablePath = process.env.CAT_WORKSHOP_EXECUTABLE;
if (!executablePath) throw new Error("CAT_WORKSHOP_EXECUTABLE is required");
const outputDir = path.resolve("output/electron-speech-frequency");
const userDataDir = path.join(outputDir, `user-data-${process.pid}-${Date.now()}`);
fs.mkdirSync(userDataDir, { recursive: true });
const electronApp = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${userDataDir}`],
  env: {
    ...process.env,
    DEEPSEEK_API_KEY: "qa-placeholder-not-real",
    CAT_WORKSHOP_PORT: "18808",
  },
});
const errors = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };

try {
  const page = await electronApp.firstWindow();
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.waitForSelector("[data-testid=game-canvas]");
  await page.getByTestId("open-settings").click();
  const slider = page.getByTestId("speech-frequency");
  assert(await slider.inputValue() === "70", `packaged default is ${await slider.inputValue()}, not 70`);
  await page.locator(".pet-drawer").screenshot({ path: path.join(outputDir, "settings-70.png") });

  await slider.fill("0");
  await page.evaluate(() => window.advanceTime(20_000));
  let textState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(textState.visualPreferences.speechFrequencyPercent === 0, "packaged text state did not expose zero");
  assert(textState.speechBubbles.length === 0, "packaged zero frequency emitted speech");

  await slider.fill("100");
  await page.evaluate(() => window.advanceTime(10_000));
  textState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const observedHundredBubbleCount = textState.speechBubbles.length;
  assert(textState.visualPreferences.speechFrequencyPercent === 100, "packaged text state did not expose 100");
  assert(observedHundredBubbleCount > 0 && observedHundredBubbleCount <= 5,
    `packaged 100 frequency emitted ${observedHundredBubbleCount} observable bubbles`);
  await page.screenshot({ path: path.join(outputDir, "frequency-100.png"), omitBackground: true });

  await slider.fill("40");
  textState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(textState.visualPreferences.speechFrequencyPercent === 40, "packaged text state did not expose 40");
  assert(textState.speechBubbles.length <= 2, `packaged lowering to 40 retained ${textState.speechBubbles.length} bubbles`);
  await page.evaluate(() => window.advanceTime(10_000));
  textState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const observedFortyBubbleCount = textState.speechBubbles.length;
  assert(observedFortyBubbleCount > 0 && observedFortyBubbleCount <= 2,
    `packaged 40 frequency emitted ${observedFortyBubbleCount} observable bubbles`);
  assert(observedFortyBubbleCount < observedHundredBubbleCount,
    `packaged frequency did not visibly change the result: 40=${observedFortyBubbleCount}, 100=${observedHundredBubbleCount}`);
  await page.screenshot({ path: path.join(outputDir, "frequency-40.png"), omitBackground: true });
  await slider.fill("70");
  assert(await page.evaluate(() => window.__CAT_WORKSHOP__.state().speechFrequency) === 70, "packaged slider did not restore 70");
  assert(errors.length === 0, `packaged renderer errors: ${errors.join(" | ")}`);

  const result = { ok: true, defaultFrequency: 70, zeroBubbleCount: 0, fortyBubbleCount: observedFortyBubbleCount, hundredBubbleCount: observedHundredBubbleCount, errors };
  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await electronApp.close();
}
