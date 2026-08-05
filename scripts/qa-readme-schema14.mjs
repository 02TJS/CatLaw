import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const output = path.resolve("output/readme-schema14");
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(String(error)));
await page.goto(pathToFileURL(path.resolve("README.html")).href, { waitUntil: "load" });

const text = await page.locator("body").innerText();
const section = page.getByRole("heading", { name: "统一法规程序与配方分离" })
  .locator("xpath=following-sibling::div[contains(@class,'grid')][1]");
await section.screenshot({ path: path.join(output, "schema14-market-section.png") });
const achievementSection = page.getByRole("heading", { name: "持久成就与生产稳定图谱" })
  .locator("xpath=following-sibling::div[contains(@class,'grid')][1]");
await achievementSection.screenshot({ path: path.join(output, "achievement-stability-section.png") });
const metrics = await page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
  replacementCharacters: (document.body.innerText.match(/�/g) ?? []).length,
}));
await browser.close();

const required = [
  "schema 14 可靠整包报价",
  "真实供应岗位",
  "事务提交与回滚",
  "直接动作也走市场",
  "价格只影响下一计划",
    "只在主交易后集中回顾",
  "生产关系从开局记录",
  "所选商品专属图",
];
const forbidden = ["凸性传入配料报价", "局部递归自供给"];
const result = {
  required: Object.fromEntries(required.map((entry) => [entry, text.includes(entry)])),
  forbidden: Object.fromEntries(forbidden.map((entry) => [entry, text.includes(entry)])),
  metrics,
  errors,
};
fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
if (required.some((entry) => !text.includes(entry))
  || forbidden.some((entry) => text.includes(entry))
  || metrics.scrollWidth > metrics.clientWidth || metrics.replacementCharacters > 0
  || errors.length > 0) {
  throw new Error(`README schema-14 QA failed:\n${JSON.stringify(result, null, 2)}`);
}
console.log(JSON.stringify(result, null, 2));
