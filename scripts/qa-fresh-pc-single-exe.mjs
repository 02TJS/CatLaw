import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { chromium } from "playwright";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const sourceExecutable = process.env.CAT_WORKSHOP_SINGLE_EXE;
if (!sourceExecutable || !path.isAbsolute(sourceExecutable)) {
  throw new Error("CAT_WORKSHOP_SINGLE_EXE must be an absolute path to the portable executable");
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForJson(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError ?? "no response"}`);
}

const outputRoot = path.resolve("output", "fresh-pc-single-exe", `run-${Date.now()}`);
const appDir = path.join(outputRoot, "Portable App");
const userDataDir = path.join(outputRoot, "Fresh User Data");
const appDataDir = path.join(outputRoot, "AppData");
const localAppDataDir = path.join(outputRoot, "LocalAppData");
const tempDir = path.join(outputRoot, "Temp");
for (const directory of [appDir, userDataDir, appDataDir, localAppDataDir, tempDir]) {
  fs.mkdirSync(directory, { recursive: true });
}

const executable = path.join(appDir, path.basename(sourceExecutable));
fs.copyFileSync(sourceExecutable, executable);
assert(fs.readdirSync(appDir).length === 1, "isolated portable directory must contain exactly one file");

const appPort = await freePort();
const debugPort = await freePort();
const windowsRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
const cleanEnvironment = {
  SystemRoot: windowsRoot,
  WINDIR: windowsRoot,
  COMSPEC: process.env.COMSPEC || path.join(windowsRoot, "System32", "cmd.exe"),
  PATH: path.join(windowsRoot, "System32"),
  PATHEXT: process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD",
  TEMP: tempDir,
  TMP: tempDir,
  APPDATA: appDataDir,
  LOCALAPPDATA: localAppDataDir,
  USERPROFILE: outputRoot,
  HOMEDRIVE: path.parse(outputRoot).root.replace(/[\\/]$/, ""),
  HOMEPATH: outputRoot.slice(path.parse(outputRoot).root.length - 1),
  CAT_WORKSHOP_PORT: String(appPort),
};

const child = spawn(executable, [
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${userDataDir}`,
], {
  cwd: appDir,
  env: cleanEnvironment,
  windowsHide: true,
  stdio: "ignore",
});

let browser = null;
try {
  await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((entry) => entry.url().startsWith("http://127.0.0.1")) ?? context.pages()[0];
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.waitForSelector("[data-testid=game-canvas]", { timeout: 30_000 });

  const health = await page.evaluate(async () => {
    const response = await fetch("/api/health", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  assert(health.status === 200 && health.body.ok === true, `packaged health endpoint failed: ${JSON.stringify(health)}`);
  assert(health.body.configured === false, "clean-machine launch inherited a DeepSeek key");

  const initial = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(initial.cats.length === 11, `fresh portable game did not create 11 starter cats: ${initial.cats.length}`);
  assert(initial.decisionModel.decisionLaws.length === 6, "fresh portable game does not contain the six-law baseline");
  assert(!/activeTaxRate|taxRate|setTax/.test(JSON.stringify(initial)), "fresh portable state still exposes tax settings");
  await page.evaluate(() => window.advanceTime(10_000));
  const advanced = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const planCounts = Object.values(advanced.market.activePlans.reduce((counts, plan) => {
    counts[plan.catId] = (counts[plan.catId] ?? 0) + 1;
    return counts;
  }, {}));
  assert(planCounts.every((count) => count <= 1), "a cat locked more than one active plan");
  assert(advanced.cats.some((cat) => cat.action !== null), "starter cats never entered an action after advancing time");
  await page.screenshot({ path: path.join(outputRoot, "fresh-single-exe-running.png"), omitBackground: true });
  assert(errors.length === 0, `renderer errors: ${errors.join(" | ")}`);

  const result = {
    ok: true,
    sourceExecutable,
    executable,
    executableBytes: fs.statSync(executable).size,
    isolatedDirectoryFiles: fs.readdirSync(appDir),
    appPort,
    debugPort,
    inheritedDeepSeekKey: health.body.configured,
    health,
    initial: {
      simTimeMs: initial.simTimeMs,
      cats: initial.cats.length,
      laws: initial.decisionModel.decisionLaws.map((law) => law.id),
      treasuryCents: initial.treasuryCents,
      unlockedRecipes: initial.unlockedRecipes.length,
    },
    advanced: {
      simTimeMs: advanced.simTimeMs,
      discoveredItems: advanced.discoveredItems,
      activeActions: advanced.cats.filter((cat) => cat.action !== null).length,
      activePlans: advanced.market.activePlans.length,
      maxPlansPerCat: planCounts.length ? Math.max(...planCounts) : 0,
    },
    isolatedDirectories: { userDataDir, appDataDir, localAppDataDir, tempDir },
    environmentKeys: Object.keys(cleanEnvironment).sort(),
    errors,
  };
  fs.writeFileSync(path.join(outputRoot, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close().catch(() => undefined);
  child.kill();
  const stopScript = `$port=${debugPort}; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \"*--remote-debugging-port=$port*\" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", stopScript], { windowsHide: true, stdio: "ignore" });
  } catch {
    // The app may already have exited cleanly.
  }
}
