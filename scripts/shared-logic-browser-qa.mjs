import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outputDir = path.resolve("output/web-game-shared-logic");
fs.mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(error.message));

const sourceCode = `// decide(ctx)：ctx 表示当前猫本次决策可读取的坐标、库存、钱包、附近工位、订单和运输合同等只读信息。
function decide(ctx) {
  // has(item, qty)：item 是稳定商品 ID，qty 是至少需要持有的数量；neighborExists(direction)：direction 是要检查的相邻方向。
  if (has("ore") && neighborExists("east")) return { type: "pass", direction: "east", itemId: "ore" };
  // nearbyCount(item)：item 是要在附近工位库存中统计的稳定商品 ID。
  // adjust(action, item, multiplier, bonus)：action 是动作，item 是商品，multiplier 是评分乘数，bonus 是固定加分。
  if (nearbyCount("wood") >= 2) adjust("pass", "wood", 3, 30);
  // choose()：这个函数无参数，请求共享贪心选择器从全部合法候选中选出最终行动。
  return choose();
}`;

await page.route("**/api/laws/compile", async (route) => {
  const request = route.request().postDataJSON();
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      title: "矿石直送与木材评分",
      playerText: "混合逻辑测试",
      summary: "矿石满足条件时直接东传，否则可在中途提高木材传递候选评分。",
      explanation: "每只猫行动时先检查自己是否至少有一件矿石，以及东边是否有相邻猫；两项都满足就尝试把矿石向东传。否则它查看附近工位的木材数量，达到两件时把传递木材的候选评分乘以三并增加三十分。最后仍由共享选择器比较合法行动，不能绕过运输合同、库存和盈利校验。",
      sourceCode,
      astHash: "browser-worker-will-rehash",
      examples: [],
      warnings: [],
      speechTemplates: [
        "按{law}，因{reason}，{action}能赚{gain}喵！",
        "照{law}算，{reason}；{action}赚{gain}喵。",
        "{law}说明了：{action}有{gain}，因为{reason}喵！",
        "我按{law}算过，{action}赚{gain}，{reason}喵。",
        "因为{reason}，依{law}做{action}，能赚{gain}喵！",
      ],
      program: { version: 2 },
      compileAudit: {
        requestId: "browser-fixture",
        model: "deepseek-v4-flash",
        attempts: 1,
        callCount: 3,
        startedAt: new Date(0).toISOString(),
        durationMs: 1,
        promptSha256: "fixture",
        responseSha256: "fixture",
        usage: {},
        sharedBehaviorHash: request.sharedBehavior.astHash,
      },
      validation: { syntax: true, safety: true, examplesPassed: 0, examplesTotal: 0, messages: [] },
    }),
  });
});

const assert = (condition, message) => { if (!condition) throw new Error(message); };

try {
  await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.waitForFunction(() => typeof window.render_game_to_text === "function");
  await page.evaluate(() => window.__CAT_WORKSHOP__.reset());
  await page.getByRole("button", { name: "混合评分" }).click();
  await page.getByTestId("compile-law").click();
  await page.getByTestId("law-draft").waitFor();
  assert((await page.getByTestId("law-draft").innerText()).includes("全体共享逻辑"), "behavior draft badge is missing");
  assert((await page.locator(".law-source").textContent()).includes("adjust"), "scoring adjustment source is missing");
  await page.getByText("查看安全逻辑").click();
  await page.screenshot({ path: path.join(outputDir, "mixed-scoring-preview.png"), fullPage: true });

  await page.getByTestId("enact-law").click();
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).laws.some((law) => law.title === "矿石直送与木材评分"));
  const targetCatId = await page.evaluate(() => {
    const state = window.__CAT_WORKSHOP__.state();
    for (const cat of state.cats) {
      cat.action = null;
      cat.inventory = {};
    }
    const target = state.cats.find((cat) => state.cats.some((neighbor) => neighbor.position.x === cat.position.x + 1 && neighbor.position.y === cat.position.y));
    if (!target) throw new Error("starter network has no east-facing pair");
    target.inventory.ore = 1;
    state.discoveredItems = ["wood", "stone", "sand", "water", "fiber", "ore", "fire", "plank", "brick"];
    state.dirtyDecisions = true;
    state.paused = false;
    window.advanceTime(1);
    state.paused = true;
    return target.id;
  });
  const state = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(state.decisionModel.visionRadius === 2, "vision radius is not two");
  assert(state.decisionModel.sharedByAllCats === true, "shared policy flag is false");
  assert(state.cats.every((cat) => cat.visibleWorkstations.every((entry) => entry.distance <= 2)), "a cat can observe beyond radius two");
  const targetCat = state.cats.find((cat) => cat.id === targetCatId);
  assert(targetCat?.action?.type === "pass" && targetCat?.action?.itemId === "ore", "direct branch did not run in the game");
  assert(targetCat?.localScoreTrace.some((entry) => entry.includes("共享逻辑")), "shared-law trace is missing");
  fs.writeFileSync(path.join(outputDir, "mixed-scoring-state.json"), JSON.stringify(state, null, 2));
  await page.screenshot({ path: path.join(outputDir, "mixed-scoring-enacted.png"), fullPage: true });
  assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
  console.log(JSON.stringify({ ok: true, sharedBehaviorHash: state.decisionModel.sharedBehaviorHash, targetCatId, targetAction: targetCat.action, errors }));
} finally {
  await browser.close();
}
