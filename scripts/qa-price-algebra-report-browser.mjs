import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const reportPath = path.resolve("CatWorkshop-Parametric-Price-Algebra.html");
const outputDir = path.resolve("output/price-algebra-report-browser");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const errors = [];
const inspectPage = async (viewport, prefix) => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${prefix} console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`${prefix} pageerror: ${error.message}`));
  await page.goto(pathToFileURL(reportPath).href, { waitUntil: "load" });
  await page.screenshot({ path: path.join(outputDir, `${prefix}-top.png`) });
  for (const selector of ["#discrete", "#substitute", "#all65", "#sensitivity"]) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(outputDir, `${prefix}-${selector.slice(1)}.png`) });
  }
  const result = await page.evaluate(() => ({
    title: document.title,
    h1: document.querySelector("h1")?.textContent?.trim(),
    sectionCount: document.querySelectorAll("main > section").length,
    parameterRows: document.querySelectorAll("#symbols tbody tr").length,
    priceRows: document.querySelectorAll("#substitute table tbody tr").length,
    laterPriceRows: document.querySelectorAll("#later-prices tbody tr").length,
    tierRows: document.querySelectorAll("#tier-summary tbody tr").length,
    bodyText: document.body.innerText,
    overflowPx: Math.max(0, document.body.scrollWidth - window.innerWidth),
  }));
  await page.close();
  return result;
};

const desktop = await inspectPage({ width: 1600, height: 1000 }, "desktop");
const mobile = await inspectPage({ width: 430, height: 900 }, "mobile");

for (const [name, result] of Object.entries({ desktop, mobile })) {
  if (result.title !== "猫咪工坊：参数化价格代数") errors.push(`${name} title: ${result.title}`);
  if (result.sectionCount !== 11) errors.push(`${name} sections: ${result.sectionCount}`);
  if (result.parameterRows !== 15) errors.push(`${name} parameter rows: ${result.parameterRows}`);
  if (result.priceRows !== 20) errors.push(`${name} combined price rows: ${result.priceRows}`);
  if (result.laterPriceRows !== 50) errors.push(`${name} later price rows: ${result.laterPriceRows}`);
  if (result.tierRows !== 9) errors.push(`${name} tier rows: ${result.tierRows}`);
  if (!result.bodyText.includes("先保留参数，再代入规则")) errors.push(`${name} missing derivation policy`);
  if (!result.bodyText.includes("逐单融资")) errors.push(`${name} missing per-order financing`);
  if (!result.bodyText.includes("92.00 金币")) errors.push(`${name} missing final budget substitution`);
  if (!result.bodyText.includes("∂S/∂B=0")) errors.push(`${name} missing budget independence`);
  if (!result.bodyText.includes("147,959") || !result.bodyText.includes("星门")) errors.push(`${name} missing stargate result`);
  if (result.bodyText.includes("�")) errors.push(`${name} replacement character`);
  if (/sk-[A-Za-z0-9_-]{12,}/.test(result.bodyText)) errors.push(`${name} secret-like text`);
  if (result.overflowPx !== 0) errors.push(`${name} horizontal overflow ${result.overflowPx}px`);
}

const payload = {
  desktop: { ...desktop, bodyText: undefined },
  mobile: { ...mobile, bodyText: undefined },
  errors,
};
await writeFile(path.join(outputDir, "result.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
await browser.close();
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
if (errors.length) process.exitCode = 1;
