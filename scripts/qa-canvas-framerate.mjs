import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 920, height: 720 } });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));

try {
  await page.addInitScript(() => {
    const original = CanvasRenderingContext2D.prototype.clearRect;
    let frameCount = 0;
    let lastFrameAt = Number.NEGATIVE_INFINITY;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas?.id === "game-canvas") {
        const now = performance.now();
        if (now - lastFrameAt > 4) {
          frameCount += 1;
          lastFrameAt = now;
        }
      }
      return original.apply(this, args);
    };
    window.__CAT_CANVAS_FRAMES__ = {
      read: () => frameCount,
      reset: () => { frameCount = 0; lastFrameAt = Number.NEGATIVE_INFINITY; },
    };
  });
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.waitForFunction(() => typeof window.render_game_to_text === "function");
  await page.evaluate(() => window.__CAT_CANVAS_FRAMES__.reset());
  const startedAt = Date.now();
  await page.waitForTimeout(2_000);
  const elapsedMs = Date.now() - startedAt;
  const frames = await page.evaluate(() => window.__CAT_CANVAS_FRAMES__.read());
  const framesPerSecond = frames * 1_000 / elapsedMs;
  if (framesPerSecond < 50 || framesPerSecond > 70) {
    throw new Error(`expected approximately 60 Canvas FPS, observed ${framesPerSecond.toFixed(2)}`);
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
  process.stdout.write(JSON.stringify({ ok: true, frames, elapsedMs, framesPerSecond, errors }));
} finally {
  await browser.close();
}
