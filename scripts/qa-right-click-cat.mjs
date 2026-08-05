import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const output = path.resolve("output/right-click-cat-qa");
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 760, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(String(error)));

await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
const canvas = page.getByTestId("game-canvas");
await canvas.waitFor();

const readState = () => page.evaluate(() => JSON.parse(window.render_game_to_text?.() ?? "{}"));
const pointForTile = async ({ x, y }) => {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("game canvas has no bounding box");
  const isoX = (x - y) * 64;
  const isoY = (x + y) * 32;
  return {
    x: box.x + box.width / 2 + (isoX - 32) * 1.08,
    y: box.y + box.height / 2 + (isoY - 28) * 1.08,
  };
};

const initial = await readState();
if (initial.cats.length !== 11) throw new Error(`expected 11 starter cats, got ${initial.cats.length}`);
const initiallySelectedCatId = initial.cats.find((cat) => cat.selected)?.id ?? null;

const resourceCenter = initial.world.resourceNodes[0].position;
const emptyTile = Array.from({ length: 9 * 9 }, (_, index) => ({
  x: (index % 9) - 4,
  y: Math.floor(index / 9) - 4,
})).find((tile) => {
  const occupied = initial.cats.some((cat) => cat.position.x === tile.x && cat.position.y === tile.y);
  const blocked = initial.world.resourceNodes.some((node) => {
    if (node.position.x === tile.x && node.position.y === tile.y) return true;
    return node.harvestTiles.some((harvestTile) => harvestTile.x === tile.x && harvestTile.y === tile.y);
  });
  return !occupied && !blocked;
});
if (!emptyTile) throw new Error("could not find a legal empty tile");
const emptyPoint = await pointForTile(emptyTile);
await page.mouse.click(emptyPoint.x, emptyPoint.y, { button: "left" });
await page.waitForTimeout(80);
const afterLeft = await readState();
if (afterLeft.cats.length !== 11) throw new Error("left click must not add a cat");

await canvas.focus();
await page.keyboard.press("Space");
await page.waitForTimeout(80);
const afterSpace = await readState();
if (afterSpace.cats.length !== 11) throw new Error("Space must not add a cat");

const resourceCenterPoint = await pointForTile(resourceCenter);
await page.mouse.click(resourceCenterPoint.x, resourceCenterPoint.y, { button: "right" });
await page.waitForTimeout(80);
const afterResourceCenter = await readState();
if (afterResourceCenter.cats.length !== 11) throw new Error("right click must not add a cat on a resource center");
if (await page.getByTestId("add-cat-menu").count() !== 0) throw new Error("resource center must not expose the add-cat confirmation");

await page.mouse.click(emptyPoint.x, emptyPoint.y, { button: "right" });
await page.waitForTimeout(120);
const afterRight = await readState();
if (afterRight.cats.length !== 11) throw new Error("right click must only open confirmation, not add a cat");
if (await page.getByTestId("add-cat-menu").count() !== 1) throw new Error("legal empty tile did not expose one add-cat confirmation");
await page.evaluate(() => document.documentElement.classList.add("desktop-shell"));
await page.screenshot({ path: path.join(output, "add-cat-confirmation.png"), omitBackground: true });

await page.getByTestId("pause-button").click();
await page.waitForTimeout(80);
if (await page.getByTestId("add-cat-menu").count() !== 0) throw new Error("clicking elsewhere must dismiss the add-cat confirmation");
if ((await readState()).cats.length !== 11) throw new Error("dismissing confirmation must not add a cat");

await page.mouse.click(emptyPoint.x, emptyPoint.y, { button: "right" });
await page.getByTestId("add-cat-menu").click();
await page.waitForTimeout(120);
const afterConfirm = await readState();
const created = afterConfirm.cats.find((cat) => cat.position.x === emptyTile.x && cat.position.y === emptyTile.y);
if (afterConfirm.cats.length !== 12 || !created) throw new Error("confirming the right-click action did not add exactly one cat");
if (created.selected) throw new Error("newly right-clicked cat must not become selected");
if ((afterConfirm.cats.find((cat) => cat.selected)?.id ?? null) !== initiallySelectedCatId) {
  throw new Error("adding a cat changed the current selection");
}
if (await page.getByTestId("drawer-cat").count() !== 0) throw new Error("adding a cat opened its inspector");

await page.screenshot({ path: path.join(output, "right-click-added-cat.png"), omitBackground: true });
const result = {
  initialCats: initial.cats.length,
  afterLeftClick: afterLeft.cats.length,
  afterSpace: afterSpace.cats.length,
  afterResourceCenterRightClick: afterResourceCenter.cats.length,
  afterValidRightClick: afterRight.cats.length,
  afterConfirmedAdd: afterConfirm.cats.length,
  initiallySelectedCatId,
  selectedCatIdAfterAdd: afterConfirm.cats.find((cat) => cat.selected)?.id ?? null,
  createdCat: { id: created.id, position: created.position, selected: created.selected },
  errors,
};
fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
await browser.close();
if (errors.length > 0) throw new Error(`browser errors:\n${errors.join("\n")}`);
console.log(JSON.stringify(result, null, 2));
