import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const output = path.resolve("output/world-editing-qa");
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 900, height: 760 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(String(error)));

await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__CAT_WORKSHOP__ && typeof window.render_game_to_text === "function");
await page.evaluate(() => {
  const clone = globalThis.structuredClone;
  globalThis.structuredClone = (value) => value;
  try {
    const state = window.__CAT_WORKSHOP__.state();
    state.paused = true;
    state.playerBuildingInventory = { wood: 1, stone: 50, factory: 1 };
    state.playerWarehousePurchases = { wood: 1, stone: 50 };
  } finally {
    globalThis.structuredClone = clone;
  }
  window.advanceTime(1);
});

const canvas = page.getByTestId("game-canvas");
await canvas.waitFor();
const readState = () => page.evaluate(() => JSON.parse(window.render_game_to_text()));
const pointForTile = async ({ x, y }, yOffset = 0) => {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("game canvas has no bounding box");
  const isoX = (x - y) * 64;
  const isoY = (x + y) * 32 + yOffset;
  return {
    x: box.x + box.width / 2 + (isoX - 32) * 1.08,
    y: box.y + box.height / 2 + (isoY - 28) * 1.08,
  };
};
const rightClick = async (position, yOffset = 0) => {
  const point = await pointForTile(position, yOffset);
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.waitForTimeout(100);
};
const emptyTiles = (state) => Array.from({ length: 81 }, (_, index) => ({ x: index % 9 - 4, y: Math.floor(index / 9) - 4 }))
  .filter((position) => !state.cats.some((cat) => cat.position.x === position.x && cat.position.y === position.y)
    && !state.world.resourceNodes.some((node) => node.position.x === position.x && node.position.y === position.y)
    && !state.world.buildings.some((building) => building.position.x === position.x && building.position.y === position.y)
    && !state.world.landmarkEngineering.deployed.some((landmark) => landmark.position.x === position.x && landmark.position.y === position.y));

let state = await readState();
const [landmarkTile, duplicateTile, resourceTile, buildingTile] = emptyTiles(state);
if (!buildingTile) throw new Error("not enough empty tiles for world-editing QA");

await rightClick(landmarkTile);
if (await page.getByTestId("create-landmark-menu").count() !== 1) throw new Error("one wood did not reveal Create Landmark");
if (await page.getByTestId("create-resource-stone").count() !== 1) throw new Error("fifty stone did not reveal stone resource creation");
if (await page.getByTestId("create-resource-wood").count() !== 0) throw new Error("one wood incorrectly revealed fifty-wood resource creation");
for (const itemId of ["sand", "water", "fiber", "ore"]) {
  if (await page.getByTestId(`create-resource-${itemId}`).count() !== 0) throw new Error(`missing ${itemId} stock still rendered a resource option`);
}
await page.evaluate(() => document.documentElement.classList.add("desktop-shell"));
await page.screenshot({ path: path.join(output, "material-filtered-menu.png"), omitBackground: true });

await page.getByTestId("create-landmark-menu").click();
await page.getByTestId("new-landmark-name").fill("A");
await page.getByTestId("create-landmark-form").locator("button[type='submit']").click();
await page.waitForTimeout(120);
state = await readState();
let marker = state.world.landmarkEngineering.deployed.find((entry) => entry.kind === "marker" && entry.name === "A");
if (!marker) throw new Error("named landmark A was not created");
if ((state.world.warehouse.inventory.wood ?? 0) !== 0) throw new Error("landmark did not consume exactly one wood");
await page.screenshot({ path: path.join(output, "named-landmark-a.png"), omitBackground: true });

await rightClick(marker.position, -23);
if (await page.getByTestId("context-rename-landmark").count() !== 1) throw new Error("right-clicking the landmark emoji did not hit the landmark");
await page.getByTestId("context-rename-landmark").click();
await page.getByTestId("rename-landmark-name").fill("东区");
await page.getByTestId("rename-landmark-form").locator("button[type='submit']").click();
await page.waitForTimeout(100);
state = await readState();
marker = state.world.landmarkEngineering.deployed.find((entry) => entry.id === marker.id);
if (marker?.name !== "东区") throw new Error("landmark rename did not persist to text state");

await page.evaluate(() => {
  const clone = globalThis.structuredClone;
  globalThis.structuredClone = (value) => value;
  try {
    const live = window.__CAT_WORKSHOP__.state();
    live.playerBuildingInventory.wood = 1;
  } finally {
    globalThis.structuredClone = clone;
  }
  window.advanceTime(1);
});
await rightClick(duplicateTile);
await page.getByTestId("create-landmark-menu").click();
await page.getByTestId("new-landmark-name").fill("东区");
await page.getByTestId("create-landmark-form").locator("button[type='submit']").click();
await page.waitForTimeout(80);
if ((await page.getByRole("alert").textContent()) !== "地标名称不能重复") throw new Error("duplicate landmark name did not fail inline");
await page.screenshot({ path: path.join(output, "duplicate-name-error.png"), omitBackground: true });
await page.mouse.click(4, 4);

await rightClick(resourceTile);
await page.getByTestId("create-resource-stone").click();
await page.waitForTimeout(100);
state = await readState();
const resource = state.world.resourceNodes.find((entry) => entry.source === "player-created" && entry.itemId === "stone"
  && entry.position.x === resourceTile.x && entry.position.y === resourceTile.y);
if (!resource) throw new Error("stone resource center was not created");
if ((state.world.warehouse.inventory.stone ?? 0) !== 0) throw new Error("stone resource center did not consume exactly fifty stone");
await rightClick(resource.position, -23);
if (await page.getByTestId("context-remove-resource").count() !== 1) throw new Error("right-clicking resource emoji did not hit resource");
await page.getByTestId("context-remove-resource").click();
await page.getByTestId("context-remove-resource").click();
await page.waitForTimeout(100);
state = await readState();
if (state.world.resourceNodes.some((entry) => entry.id === resource.id)) throw new Error("resource removal did not finish after confirmation");

await rightClick(buildingTile);
await page.getByTestId("context-place-building-factory").click();
await page.waitForTimeout(100);
state = await readState();
const building = state.world.buildings.find((entry) => entry.position.x === buildingTile.x && entry.position.y === buildingTile.y && entry.itemId === "factory");
if (!building) throw new Error("factory setup failed");
await rightClick(building.position, -23);
if (await page.getByTestId("context-dismantle-building").count() !== 1) throw new Error("right-clicking factory emoji did not hit building");
await page.getByTestId("context-dismantle-building").click();
await page.getByTestId("context-dismantle-building").click();
await page.waitForTimeout(100);
state = await readState();
if (state.world.buildings.some((entry) => entry.id === building.id)) throw new Error("building dismantle failed");
if ((state.world.warehouse.inventory.factory ?? 0) !== 1) throw new Error("dismantled building did not return to warehouse");

const removableCat = state.cats.at(-1);
await rightClick(removableCat.position, -30);
if (await page.getByTestId("context-cat-liquidation").count() !== 1) throw new Error("right-clicking cat body did not show liquidation audit");
await page.screenshot({ path: path.join(output, "cat-liquidation-menu.png"), omitBackground: true });
await page.getByTestId("context-remove-cat").click();
await page.getByTestId("context-remove-cat").click();
await page.waitForTimeout(150);
state = await readState();
if (state.cats.some((entry) => entry.id === removableCat.id)) throw new Error("cat removal did not finish after confirmation");
if (!state.commandAudit.some((entry) => entry.kind === "remove-cat" && entry.target === removableCat.id && entry.ok)) throw new Error("cat removal was not audited");
if (state.market.openOrders.some((entry) => entry.buyerCatId === removableCat.id || entry.destinationCatId === removableCat.id)) throw new Error("removed cat remains in an open order");
if (state.market.activeContracts.some((entry) => entry.routeCatIds.includes(removableCat.id) || entry.custodianCatId === removableCat.id)) throw new Error("removed cat remains in an active contract");

await rightClick(duplicateTile);
if (await page.getByTestId("create-resource-stone").count() !== 0) throw new Error("spent stone still rendered its creation option");
if (await page.getByTestId("create-landmark-menu").count() !== 1) throw new Error("injected one wood should still render landmark creation");
await page.mouse.click(4, 4);
await page.evaluate(() => {
  const shell = document.querySelector("#game-shell");
  shell?.style.setProperty("--pet-control-scale", "1.8");
  shell?.style.setProperty("--pet-font-scale", "2.2");
});
await rightClick(duplicateTile);
await page.getByTestId("create-landmark-menu").click();
const scaledMenuBox = await page.getByTestId("tile-action-menu").boundingBox();
if (!scaledMenuBox || scaledMenuBox.x < 0 || scaledMenuBox.y < 0
  || scaledMenuBox.x + scaledMenuBox.width > 900 || scaledMenuBox.y + scaledMenuBox.height > 760) {
  throw new Error(`maximum-scale context menu is clipped: ${JSON.stringify(scaledMenuBox)}`);
}
if (!(await page.getByTestId("new-landmark-name").isVisible())) throw new Error("maximum-scale landmark input is not visible");
await page.screenshot({ path: path.join(output, "maximum-scale-landmark-form.png"), omitBackground: true });

const result = {
  marker: { id: marker.id, name: marker.name, position: marker.position },
  removedResourceId: resource.id,
  dismantledBuildingId: building.id,
  removedCatId: removableCat.id,
  remainingWarehouse: state.world.warehouse.inventory,
  maximumScaleMenu: scaledMenuBox,
  errors,
};
fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
await browser.close();
if (errors.length) throw new Error(`browser errors:\n${errors.join("\n")}`);
console.log(JSON.stringify(result, null, 2));
