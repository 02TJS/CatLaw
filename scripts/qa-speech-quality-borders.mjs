import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outputDir = path.resolve("output/speech-quality-borders");
fs.mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 760, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));

try {
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__CAT_WORKSHOP__ && typeof window.render_game_to_text === "function");
  await page.evaluate(async () => {
    await window.__CAT_WORKSHOP__.reset(3);
    const clone = globalThis.structuredClone;
    globalThis.structuredClone = (value) => value;
    try {
      const state = window.__CAT_WORKSHOP__.state();
      state.paused = true;
      state.resourceNodes = [];
      state.buildings = [];
      state.landmarks = [];
      state.cats = state.cats.slice(0, 6);
      const positions = [{ x: 0, y: 2 }, { x: -3, y: 0 }, { x: -1, y: -2 }, { x: 1, y: -2 }, { x: 3, y: 0 }, { x: 0, y: 0 }];
      state.cats.forEach((cat, index) => {
        cat.position = positions[index];
        cat.action = null;
      });
      const activeItems = ["fire", "metal", "lamp", "chip", "computer"];
      for (let index = 1; index < state.cats.length; index += 1) {
        const itemId = activeItems[index - 1];
        state.cats[index].action = {
          type: "craft",
          recipeId: `make_${itemId}`,
          itemId,
          startedAt: state.simTime - 2_500,
          endsAt: state.simTime + 2_500,
          reserved: {},
          lawId: "qa-quality",
          expectedGainCents: 100,
          decisionReason: "品质边框视觉夹具",
        };
      }
      state.floatingEvents = [{
        id: "qa-three-line-speech",
        catId: state.cats[0].id,
        text: "因为这趟把金属运到东边能赚十二点五金币，而且订单有利可图路线也安全，所以我现在马上出发喵",
        createdAt: state.simTime - 500,
        duration: 4_500,
        kind: "speech",
      }];
    } finally {
      globalThis.structuredClone = clone;
    }
  });
  await page.waitForTimeout(220);
  await page.getByTestId("game-canvas").screenshot({
    path: path.join(outputDir, "three-lines-and-quality-borders.png"),
    omitBackground: true,
  });
  const text = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const visible = text.speechBubbles.filter((bubble) => bubble.visible);
  if (visible.length !== 1) throw new Error(`expected one visible speech bubble, got ${visible.length}`);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const result = { ok: true, visibleSpeech: visible[0].text, actionItems: ["fire", "metal", "lamp", "chip", "computer"], errors };
  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result));
} finally {
  await browser.close();
}
