import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const packageJson = JSON.parse(read("package.json"));
const scripts = packageJson.scripts ?? {};

const stableEntries = {
  "qa:unit": "vitest run --maxWorkers=1",
  "qa:maintenance": "node scripts/qa-maintenance-entrypoints.mjs",
  "qa:browser:readme": "node scripts/qa-readme-schema14.mjs",
  "qa:electron:desktop": "node scripts/qa-electron-desktop-contract.mjs",
  "qa:package:unpacked": "node scripts/qa-fresh-pc-portable.mjs",
  "qa:package:single-exe": "node scripts/qa-fresh-pc-single-exe.mjs",
  "qa:live:deepseek": "node --import tsx scripts/qa-deepseek-api-audit.mts",
  "qa:progression:headless": "node --import tsx scripts/qa-deepseek-to-35-headless.mts --fixture",
  "qa:progression:browser": "node scripts/qa-deepseek-to-35-browser-gate.mjs",
  "qa:economy:extreme-tier-prices": "node --import tsx scripts/qa-extreme-tier-prices.mts",
  "report:progression": "node --import tsx scripts/generate-deepseek-to-35-report.mts",
};

const compatibilityAliases = {
  "test:deepseek:live": "npm run qa:live:deepseek",
  "test:progression:headless": "npm run qa:progression:headless",
  "test:progression:browser": "npm run qa:progression:browser",
  "test:extreme-tier-prices": "npm run qa:economy:extreme-tier-prices",
  "report:deepseek-to-35": "npm run report:progression",
};

const failures = [];
for (const [name, command] of Object.entries({ ...stableEntries, ...compatibilityAliases })) {
  if (scripts[name] !== command) failures.push(`${name} must equal ${JSON.stringify(command)}`);
}

for (const command of Object.values(stableEntries)) {
  const match = command.match(/(?:^|\s)(scripts\/[\w.-]+\.(?:mjs|mts|js|ts|py|ps1|sh))(?:\s|$)/);
  if (match && !fs.existsSync(path.join(root, match[1]))) failures.push(`missing script target: ${match[1]}`);
}

const readme = read("README.md");
const scriptsReadme = read("scripts/README.md");
if (!readme.includes(`当前版本：\`${packageJson.version}\``)) failures.push("README.md version differs from package.json");
if (!readme.includes(`CatWorkshop-${packageJson.version}-portable.exe`)) failures.push("README.md lacks the release portable artifact");
if (!readme.includes("release/win-unpacked/猫咪工坊.exe")) failures.push("README.md lacks the release unpacked artifact");
for (const heading of ["单元与静态门禁", "浏览器 QA", "Electron QA", "打包 QA", "在线与人工 QA", "报告与研究", "历史与废弃状态"]) {
  if (!scriptsReadme.includes(`## ${heading}`)) failures.push(`scripts/README.md lacks section: ${heading}`);
}

if (failures.length > 0) throw new Error(`maintenance entrypoint QA failed:\n- ${failures.join("\n- ")}`);
console.log(JSON.stringify({
  version: packageJson.version,
  stableEntryCount: Object.keys(stableEntries).length,
  compatibilityAliasCount: Object.keys(compatibilityAliases).length,
  documentation: ["README.md", "scripts/README.md"],
}, null, 2));
