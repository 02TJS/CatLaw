import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
await page.waitForFunction(() => Boolean(window.__CAT_WORKSHOP__));
await page.evaluate(() => window.__CAT_WORKSHOP__.reset(3));
await page.waitForTimeout(100);

await page.keyboard.press("4");
const speedAfterKey = JSON.parse(await page.evaluate(() => window.render_game_to_text())).runtimeSpeedMultiplier;
await page.keyboard.press("p");
const pausedAfterP = JSON.parse(await page.evaluate(() => window.render_game_to_text())).paused;
await page.locator(".panel-tabs button").nth(3).click();
await page.waitForSelector('[data-testid="cat-removal"]');
await page.evaluate(() => {
  const state = window.__CAT_WORKSHOP__.state();
  state.cats[0].coins = 500;
  state.cats[0].debtCents = 200;
  state.cats[0].inventory.wood = 2;
});
page.once("dialog", (dialog) => dialog.accept());
await page.getByTestId("cat-removal").getByRole("button", { name: "删除并结算" }).click();
await page.waitForTimeout(100);
const afterRemoval = await page.evaluate(() => {
  const state = window.__CAT_WORKSHOP__.state();
  return { cats: state.cats.length, treasury: state.treasuryCoins, hasCat0: state.cats.some((cat) => cat.id === "cat-0") };
});
await page.screenshot({ path: "output/web-game-speed/full-page-speed-removal.png", fullPage: true });
console.log(JSON.stringify({ speedAfterKey, pausedAfterP, afterRemoval, errors }));
await browser.close();
