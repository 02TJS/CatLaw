import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outputDir = path.resolve("output/speech-control-avoidance");
fs.mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 760, height: 420 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));

const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function setSpeechFixture(position, id) {
  await page.evaluate(({ position, id }) => {
    const clone = globalThis.structuredClone;
    globalThis.structuredClone = (value) => value;
    try {
      const state = window.__CAT_WORKSHOP__.state();
      state.paused = true;
      state.resourceNodes = [];
      state.buildings = [];
      state.landmarks = [];
      state.cats = state.cats.slice(0, 1);
      state.cats[0].position = position;
      state.cats[0].action = null;
      state.floatingEvents = [{
        id,
        catId: state.cats[0].id,
        text: "因为这趟能赚0.25金币，所以我要把🪵木材运到北边的35号猫喵",
        createdAt: state.simTime - 500,
        duration: 4_500,
        kind: "speech",
      }];
    } finally {
      globalThis.structuredClone = clone;
    }
  }, { position, id });
  await page.waitForTimeout(260);
}

try {
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__CAT_WORKSHOP__ && typeof window.render_game_to_text === "function");
  await page.evaluate(() => document.documentElement.classList.add("desktop-shell"));
  await page.evaluate(async () => window.__CAT_WORKSHOP__.reset(3));

  await setSpeechFixture({ x: 3, y: 3 }, "qa-speech-near-dock");
  await page.screenshot({ path: path.join(outputDir, "bubble-clears-bottom-dock.png"), omitBackground: true });

  await page.getByRole("button", { name: "法典" }).click();
  await setSpeechFixture({ x: 4, y: -1 }, "qa-speech-near-drawer");
  await page.screenshot({ path: path.join(outputDir, "bubble-clears-top-and-drawer.png"), omitBackground: true });

  const textState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const expectedControls = ["dragRegion", "headlineStats", "mainCommerce", "windowControls", "dock", "drawer"];
  const avoids = textState.visualPreferences.speechBubbleAvoidsControls;
  assert(expectedControls.every((control) => avoids.includes(control)),
    `text state omitted speech control obstacles: ${JSON.stringify(avoids)}`);
  assert(textState.speechBubbles.some((bubble) => bubble.visible), "speech fixture was not visible");
  assert(errors.length === 0, errors.join("\n"));

  const result = {
    ok: true,
    viewport: { width: 760, height: 420 },
    dock: await page.locator(".pet-dock").boundingBox(),
    drawer: await page.locator(".pet-drawer").boundingBox(),
    avoids,
    errors,
  };
  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
