import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outputDir = path.resolve("output/speech-law-preview");
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
      sourceCode: "function decide(ctx) { if (orderCount('wood') > 0) adjust('craft', 'wood', 2, 20); return choose(); }",
      astHash: "fixture-worker-rehashes-this",
      examples: [],
      warnings: [],
      speechTemplates: [
        "因{reason}，{action}能赚{gain}喵！",
        "按{law}，{reason}；{action}赚{gain}喵。",
        "这次{action}有{gain}收益，因为{reason}喵！",
        "我算过了：{action}赚{gain}，{reason}喵。",
        "因为{reason}，所以{action}，能赚{gain}喵！",
      ],
      program: { version: 2 },
      compileAudit: {
        requestId: "speech-preview-fixture",
        model: "deepseek-v4-flash",
        attempts: 1,
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
  await page.getByRole("button", { name: /法典/ }).click();
  await page.getByTestId("law-input").fill("听到木材订单时，提高木材制作评分，然后请求统一选择器。");
  await page.getByTestId("compile-law").click();
  const draft = page.getByTestId("law-draft");
  await draft.waitFor();
  const previewLines = await draft.locator(".speech-preview li").allTextContents();
  assert(previewLines.length === 5, `expected five speech templates, received ${previewLines.length}`);
  assert(previewLines.every((line) => line.includes("喵")), "every speech preview must contain 喵");
  assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
  await draft.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDir, "draft-five-lines.png"), fullPage: true });
  fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify({ ok: true, previewLines, errors }, null, 2));
  console.log(JSON.stringify({ ok: true, previewLines: previewLines.length, errors }));
} finally {
  await browser.close();
}
