import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outputDir = path.resolve("output/speech-law-preview");
const gameUrl = process.env.CAT_WORKSHOP_QA_URL ?? "http://127.0.0.1:5173";
fs.mkdirSync(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(error.message));

await page.route("**/api/laws/compile", async (route) => {
  const request = route.request().postDataJSON();
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      title: "木材订单优先法",
      playerText: request.text,
      summary: "听到木材订单时提高木材制作评分，再交由统一选择器决定。",
      explanation: "每只猫准备行动时，这条法规先用 orderCount 查看它能听到的木材订单数量。只要订单大于零，就用 adjust 把制作木材的候选评分乘以二并额外增加二十分；没有订单时不加分。最后 choose 会让共享贪心选择器比较所有合法候选。它不会凭空制造木材，也不能绕过配方、原料、场地、利润和运输合同校验。",
      sourceCode: [
        "// decide(ctx)：ctx 表示当前猫本次决策可读取的坐标、库存、钱包、订单广播和运输合同等只读信息。",
        "function decide(ctx) {",
        "  // orderCount(item)：item 表示要统计订单的稳定商品 ID，这里只统计木材订单。",
        "  if (orderCount('wood') > 0) {",
        "    // adjust(action, item, multiplier, bonus)：action 是动作，item 是商品，multiplier 是评分乘数，bonus 是固定加分。",
        "    adjust('craft', 'wood', 2, 20);",
        "  }",
        "  // choose()：这个函数无参数，请求共享贪心选择器从所有合法候选中选出最终行动。",
        "  return choose();",
        "}",
      ].join("\n"),
      astHash: "fixture-worker-rehashes-this",
      examples: [],
      warnings: [],
      speechTemplates: [
        "按{law}，因{reason}，{action}能赚{gain}喵！",
        "按{law}，{reason}；{action}赚{gain}喵。",
        "照{law}执行，{action}有{gain}，因为{reason}喵！",
        "我按{law}算过：{action}赚{gain}，{reason}喵。",
        "因为{reason}，依{law}做{action}，能赚{gain}喵！",
      ],
      program: { version: 2 },
      compileAudit: {
        requestId: "speech-preview-fixture",
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
  await page.goto(gameUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /法典/ }).click();
  await page.getByTestId("law-input").fill("听到木材订单时，提高木材制作评分，然后请求统一选择器。");
  await page.getByTestId("compile-law").click();
  const draft = page.getByTestId("law-draft");
  await draft.waitFor();
  const previewLines = await draft.locator(".speech-preview li").allTextContents();
  assert(previewLines.length === 5, `expected five speech templates, received ${previewLines.length}`);
  assert(previewLines.every((line) => line.includes("喵")), "every speech preview must contain 喵");
  assert(previewLines.every((line) => line.includes("{law}")), "every generated speech preview must cite {law}");
  const explanation = await draft.getByTestId("law-explanation").innerText();
  assert(explanation.includes("orderCount") && explanation.includes("adjust") && explanation.length > 100, "full plain-language explanation is missing");
  assert((await draft.innerText()).includes("3 次调用"), "three-call audit label is missing");
  assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
  await draft.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDir, "draft-five-lines.png"), fullPage: true });
  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify({ ok: true, previewLines, explanation, errors }, null, 2));
  console.log(JSON.stringify({ ok: true, previewLines: previewLines.length, errors }));
} finally {
  await browser.close();
}
