import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const output = path.resolve("output/desktop-pet-qa");
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 760, height: 720 }, deviceScaleFactor: 1 });
const main = await context.newPage();
const qaUrl = process.env.CAT_WORKSHOP_QA_URL ?? "http://127.0.0.1:5173";
const errors = [];
const track = (page, label) => {
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${label}: ${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`${label}: ${String(error)}`));
};
track(main, "main");

await main.goto(qaUrl, { waitUntil: "networkidle" });
await main.waitForSelector("[data-testid=game-canvas]");
await main.evaluate(() => window.advanceTime?.(15_000));
await main.screenshot({ path: path.join(output, "pet-main.png") });
await main.evaluate(() => document.documentElement.classList.add("desktop-shell"));
await main.screenshot({ path: path.join(output, "pet-native-shell.png"), omitBackground: true });
await main.evaluate(() => document.documentElement.classList.remove("desktop-shell"));

await main.getByRole("button", { name: /仓库/ }).click();
await main.waitForSelector("[data-testid=drawer-warehouse]");
const emptyWarehouseCards = await main.locator(".warehouse-item-card").count();
if (emptyWarehouseCards !== 0) throw new Error(`fresh warehouse should render no product cards, got ${emptyWarehouseCards}`);
await main.screenshot({ path: path.join(output, "pet-warehouse-empty.png") });
await main.locator("[data-testid=drawer-warehouse] > header button").click();
await main.getByTestId("buy-all-cat-stock").click();
await main.getByRole("button", { name: /仓库/ }).click();
await main.waitForSelector("[data-testid=drawer-warehouse]");
await main.waitForTimeout(150);
const stockedWarehouseCards = await main.locator(".warehouse-item-card.stocked").count();
const nonStockedWarehouseCards = await main.locator(".warehouse-item-card:not(.stocked)").count();
if (stockedWarehouseCards === 0 || nonStockedWarehouseCards !== 0) {
  throw new Error(`owned-only warehouse failed: stocked=${stockedWarehouseCards}, nonStocked=${nonStockedWarehouseCards}`);
}
await main.screenshot({ path: path.join(output, "pet-warehouse-owned.png") });
await main.locator("[data-testid=drawer-warehouse] > header button").click();

const popupPromise = context.waitForEvent("page");
await main.getByTestId("open-recipes").click();
await main.waitForSelector("[data-testid=drawer-recipes]");
const recipePurchaseCards = await main.locator("[data-testid=drawer-recipes] .recipe-card").count();
if (recipePurchaseCards !== 65) throw new Error(`recipe purchase drawer should contain 65 entries, got ${recipePurchaseCards}`);
await main.screenshot({ path: path.join(output, "pet-recipe-purchases.png") });
await main.getByTestId("open-recipe-graph").click();
const recipes = await popupPromise;
track(recipes, "recipes");
await recipes.setViewportSize({ width: 1280, height: 820 });
await recipes.waitForLoadState("networkidle");
await recipes.waitForSelector(".recipe-node");
await recipes.getByRole("button", { name: "全图" }).click();
await recipes.waitForTimeout(300);
const graphCounts = {
  nodes: await recipes.locator(".recipe-node").count(),
  edges: await recipes.locator(".recipe-edge").count(),
};
if (graphCounts.nodes !== 65) throw new Error(`expected 65 recipe nodes, got ${graphCounts.nodes}`);
if (graphCounts.edges !== 164) throw new Error(`expected 164 recipe edges, got ${graphCounts.edges}`);
await recipes.screenshot({ path: path.join(output, "recipes-overview.png") });
await recipes.getByRole("button", { name: /^🚀 火箭 =/ }).click();
await recipes.waitForTimeout(150);
const focusCounts = {
  nodes: await recipes.locator(".recipe-node").count(),
  edges: await recipes.locator(".recipe-edge").count(),
  highlightedNodes: await recipes.locator(".recipe-node:not(.dimmed)").count(),
  highlightedEdges: await recipes.locator(".recipe-edges g.selected").count(),
};
if (focusCounts.nodes !== 65 || focusCounts.edges !== 164 || focusCounts.highlightedNodes !== 8 || focusCounts.highlightedEdges !== 7) {
  throw new Error(`rocket highlight must preserve the 65-item flow while emphasizing 8 nodes and 7 edges, got ${JSON.stringify(focusCounts)}`);
}
await recipes.screenshot({ path: path.join(output, "recipes-full-flow.png") });

const state = JSON.parse(await main.evaluate(() => window.render_game_to_text?.() ?? "{}"));
const result = {
  mainViewport: await main.evaluate(() => ({ width: innerWidth, height: innerHeight })),
  graphCounts,
  focusCounts,
  recipeConnected: await recipes.locator(".recipe-connection.online").count() === 1,
  visibleMainControls: await main.locator(".pet-dock button").allTextContents(),
  warehouseCardsInFreshSave: emptyWarehouseCards,
  warehouseCardsAfterPublicPurchase: stockedWarehouseCards,
  recipePurchaseCards,
  cats: state.cats?.length ?? 0,
  errors,
};
fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
await browser.close();
if (errors.length > 0) throw new Error(`browser errors:\n${errors.join("\n")}`);
console.log(JSON.stringify(result, null, 2));
