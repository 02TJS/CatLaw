import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outputDir = path.resolve("output/speech-delay-pass");
fs.mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1240, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(error.message));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

try {
  await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.waitForFunction(() => typeof window.render_game_to_text === "function" && typeof window.advanceTime === "function");
  await page.evaluate(() => window.__CAT_WORKSHOP__.reset());

  let firstBatch = null;
  let passBubble = null;
  let state = null;
  for (let elapsed = 0; elapsed < 120_000; elapsed += 250) {
    await page.evaluate(() => window.advanceTime(250));
    state = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    if (!firstBatch && state.speechBubbles.length >= 2) firstBatch = structuredClone(state.speechBubbles);
    passBubble = state.speechBubbles.find((bubble) => bubble.visible && bubble.destinationCatId);
    if (passBubble) break;
  }

  assert(firstBatch, "no queued speech batch was observed");
  assert(firstBatch.every((bubble) => bubble.scheduledDelayMs >= 1_000 && bubble.scheduledDelayMs <= 5_000), "speech delay left the 1-5 second range");
  assert(new Set(firstBatch.map((bubble) => bubble.scheduledDelayMs)).size > 1, "same-batch speech was not staggered");
  assert(passBubble, "no visible paid-shipment speech was observed");
  assert(passBubble.text.includes("运到") && passBubble.text.includes("金币") && passBubble.text.includes("履行有偿运输合同"), "shipment speech lacks destination, gain, or reason");
  assert(state.speechBubbles.filter((bubble) => bubble.visible).length <= 5, "visible speech exceeded the global cap");
  assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);

  await page.locator("canvas").screenshot({ path: path.join(outputDir, "paid-shipment-speech.png") });
  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify({
    ok: true,
    simTimeMs: state.simTimeMs,
    firstBatch: firstBatch.map(({ catId, scheduledDelayMs }) => ({ catId, scheduledDelayMs })),
    passBubble,
    visibleCount: state.speechBubbles.filter((bubble) => bubble.visible).length,
    errors,
  }, null, 2));
  console.log(JSON.stringify({ ok: true, simTimeMs: state.simTimeMs, passText: passBubble.text, visibleCount: state.speechBubbles.filter((bubble) => bubble.visible).length }));
} finally {
  await browser.close();
}
