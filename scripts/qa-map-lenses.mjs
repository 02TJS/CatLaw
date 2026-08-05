import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDir = path.resolve("artifacts/map-lenses");
await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));

await page.goto(process.env.QA_URL ?? "http://127.0.0.1:5173", { waitUntil: "networkidle" });
await page.waitForSelector("[data-testid='game-canvas']");
await page.evaluate(() => window.advanceTime?.(125_000));
if (await page.getByTestId("map-lens-palette").isVisible().catch(() => false)) throw new Error("Lens options should start closed");
await page.getByTestId("map-lens-button").click();
await page.getByTestId("map-lens-palette").waitFor();
const visibleLensChoices = await page.getByTestId("map-lens-palette").locator("button").allTextContents();
if (visibleLensChoices.length !== 10) throw new Error(`Expected ordinary plus 9 lens choices, got ${visibleLensChoices.length}`);

// Dual-role supply/demand is a market-state fixture, not a guaranteed exact
// tick on every random new-save seed. Allow a bounded deterministic settling
// window instead of making the visual check flaky.
for (let attempt = 0; attempt < 8; attempt += 1) {
  await page.getByTestId("map-lens-orders").click();
  const state = JSON.parse(await page.evaluate(() => window.render_game_to_text?.() ?? "{}"));
  const participants = state.world?.mapLens?.orderParticipants ?? [];
  if (participants.some((entry) => entry.demands?.length > 0 && entry.supplies?.length > 0)) break;
  await page.getByTestId("map-lens-orders").click();
  await page.evaluate(() => window.advanceTime?.(60_000));
}
const settledLensState = JSON.parse(await page.evaluate(() => window.render_game_to_text?.() ?? "{}"));
if (settledLensState.world?.mapLens?.id === "orders") await page.getByTestId("map-lens-orders").click();

const lenses = ["inventory", "orders", "bottlenecks", "environment", "wealth", "activity", "law", "stability", "coordinates"];
const states = [];
for (const lens of lenses) {
  await page.getByTestId(`map-lens-${lens}`).click();
  if (lens === "environment" && await page.getByTestId("map-lens-item").isVisible()) {
    const options = await page.getByTestId("map-lens-item").locator("option").allTextContents();
    if (options.some((entry) => entry.includes("木材"))) await page.getByTestId("map-lens-item").selectOption("wood");
  }
  await page.waitForTimeout(180);
  const state = JSON.parse(await page.evaluate(() => window.render_game_to_text?.() ?? "{}"));
  if (state.world?.mapLens?.id !== lens) throw new Error(`Expected ${lens}, got ${state.world?.mapLens?.id}`);
  if (lens === "orders") {
    const participants = state.world?.mapLens?.orderParticipants ?? [];
    if (!participants.some((entry) => entry.demands?.length > 0)) throw new Error("Order lens has no labeled demand goods");
    if (!participants.some((entry) => entry.supplies?.length > 0)) throw new Error("Order lens has no labeled supply goods");
    if (!participants.some((entry) => entry.demands?.length > 0 && entry.supplies?.length > 0)) {
      throw new Error("Order lens has no split demand/supply workstation");
    }
    if (!participants.some((entry) => entry.demandTargets?.some((target) => target.targetItemIds?.length > 0))) {
      throw new Error("Order lens has no demanded-input to target-product marker");
    }
    if (!state.world?.mapLens?.actionItemsHidden) throw new Error("Standard craft/pass action items remain enabled in lens mode");
  }
  if (lens === "coordinates") {
    const coordinates = state.world?.mapLens?.catCoordinates ?? [];
    if (coordinates.length < 11) throw new Error("Coordinate lens is missing cat labels");
    if (!coordinates.every((entry) => Number.isInteger(entry.serial)
      && Number.isInteger(entry.position?.x) && Number.isInteger(entry.position?.y))) {
      throw new Error("Coordinate lens has invalid serial or position data");
    }
  }
  if (lens === "wealth") {
    const metric = state.world?.mapLens?.wealthNormalization;
    if (!metric || metric.cats?.length < 11) throw new Error("Wealth lens is missing normalized cat values");
    if (metric.max < metric.min) throw new Error("Wealth normalization range is reversed");
    if (!metric.cats.every((entry) => entry.normalized >= 0 && entry.normalized <= 1)) {
      throw new Error("Wealth normalization escaped the 0..1 range");
    }
    if (metric.max > metric.min) {
      const normalized = metric.cats.map((entry) => entry.normalized);
      if (Math.min(...normalized) !== 0 || Math.max(...normalized) !== 1) {
        throw new Error("Wealth heat map does not use the complete normalized color range");
      }
    }
  }
  if (lens === "activity") {
    const metric = state.world?.mapLens?.activityHeat;
    if (!metric || metric.cats?.length < 11) throw new Error("Activity lens is missing per-cat inactivity values");
    if (metric.unit !== "milliseconds" || metric.stalledAfterMs !== 60_000) {
      throw new Error("Activity lens does not expose its fixed 60-second scale");
    }
    if (!metric.cats.every((entry) => entry.inactiveMs >= 0
      && entry.normalizedInactivity >= 0 && entry.normalizedInactivity <= 1)) {
      throw new Error("Activity heat values escaped their valid ranges");
    }
  }
  const legend = await page.getByTestId("map-lens-legend").innerText();
  states.push({
    lens,
    title: state.world.mapLens.title,
    legend,
    openOrders: state.market?.openOrders ?? [],
    activeContracts: state.market?.activeContracts ?? [],
    orderParticipants: state.world?.mapLens?.orderParticipants ?? [],
    wealthNormalization: state.world?.mapLens?.wealthNormalization ?? null,
    activityHeat: state.world?.mapLens?.activityHeat ?? null,
  });
  await page.screenshot({ path: path.join(outputDir, `${lens}.png`) });
}

await page.keyboard.press("Escape");
if (await page.getByTestId("map-lens-palette").isVisible().catch(() => false)) throw new Error("Escape did not close map lenses");
const closedState = JSON.parse(await page.evaluate(() => window.render_game_to_text?.() ?? "{}"));
if (closedState.world?.mapLens?.id !== "none") throw new Error("Closed lens remained active in text state");

await writeFile(path.join(outputDir, "summary.json"), JSON.stringify({ states, errors }, null, 2));
await browser.close();
if (errors.length > 0) throw new Error(`Browser errors: ${errors.join(" | ")}`);
console.log(JSON.stringify({ lenses: states.map((entry) => entry.title), errors }, null, 2));
