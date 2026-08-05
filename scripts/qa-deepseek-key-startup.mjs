import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:8799";
const outputDir = path.resolve("output/deepseek-key-startup-browser");
const testKey = `sk-${"startup-check".repeat(3)}`;
fs.mkdirSync(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
let settingsResponseText = "";
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`page: ${String(error)}`));
page.on("response", async (response) => {
  if (response.url().endsWith("/api/settings/deepseek-key")) settingsResponseText = await response.text();
});

await page.goto(url, { waitUntil: "networkidle" });
const dialog = page.getByTestId("deepseek-key-dialog");
await dialog.waitFor({ state: "visible" });
const stateBefore = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
await page.waitForTimeout(900);
const stateWhileBlocked = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
if (stateBefore.simTimeMs !== stateWhileBlocked.simTimeMs) {
  throw new Error(`Startup gate did not freeze simulation: ${stateBefore.simTimeMs} -> ${stateWhileBlocked.simTimeMs}`);
}
await page.screenshot({ path: path.join(outputDir, "01-key-required.png"), fullPage: true });

await page.getByTestId("deepseek-key-input").fill(testKey);
await page.getByTestId("deepseek-key-save").click();
await dialog.waitFor({ state: "hidden" });
if (settingsResponseText.includes(testKey)) throw new Error("The settings response echoed the API key");
await page.getByTestId("open-deepseek-settings").waitFor({ state: "visible" });
const configuredLabel = await page.getByTestId("open-deepseek-settings").textContent();
if (!configuredLabel?.includes("✓")) throw new Error(`Configured status was not shown: ${configuredLabel}`);
await page.waitForTimeout(250);
const stateAfter = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
if (stateAfter.simTimeMs <= stateWhileBlocked.simTimeMs) throw new Error("Simulation did not resume after saving the key");
await page.screenshot({ path: path.join(outputDir, "02-key-saved.png"), fullPage: true });

await page.reload({ waitUntil: "networkidle" });
await dialog.waitFor({ state: "visible" });
await page.getByTestId("deepseek-key-use-existing").waitFor({ state: "visible" });
const reloadBefore = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
await page.waitForTimeout(400);
const reloadBlocked = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
if (reloadBefore.simTimeMs !== reloadBlocked.simTimeMs) throw new Error("Configured startup confirmation did not freeze simulation");
await page.screenshot({ path: path.join(outputDir, "03-existing-key-confirmation.png"), fullPage: true });
await page.getByTestId("deepseek-key-use-existing").click();
await dialog.waitFor({ state: "hidden" });

const health = await page.evaluate(async () => fetch("/api/health", { cache: "no-store" }).then((response) => response.json()));
if (!health.configured) throw new Error("Health endpoint did not retain the configured key for this server session");
if (errors.length) throw new Error(errors.join("\n"));

fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify({
  passed: true,
  configuredLabel,
  storage: health.keyStorage,
  startupSimTimeMs: stateBefore.simTimeMs,
  blockedSimTimeMs: stateWhileBlocked.simTimeMs,
  resumedSimTimeMs: stateAfter.simTimeMs,
  responseEchoedSecret: false,
  consoleErrors: errors,
}, null, 2));
await browser.close();
