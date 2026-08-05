import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "playwright";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const executablePath = process.env.CAT_WORKSHOP_SINGLE_EXE;
if (!executablePath || !path.isAbsolute(executablePath)) {
  throw new Error("CAT_WORKSHOP_SINGLE_EXE must be an absolute path to the portable EXE");
}

const executable = path.resolve(executablePath);
assert(fs.existsSync(executable), `portable EXE does not exist: ${executable}`);

const outputRoot = path.resolve("output", "fresh-pc-single-exe", `run-${Date.now()}`);
const userDataDir = path.join(outputRoot, "Fresh User Data");
const appDataDir = path.join(outputRoot, "AppData");
const localAppDataDir = path.join(outputRoot, "LocalAppData");
const tempDir = path.join(outputRoot, "Temp");
for (const directory of [userDataDir, appDataDir, localAppDataDir, tempDir]) {
  fs.mkdirSync(directory, { recursive: true });
}

const windowsRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
const port = 18_829;
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
  CAT_WORKSHOP_PORT: String(port),
};

const logPath = path.join(outputRoot, "portable-process.log");
const logHandle = fs.openSync(logPath, "w");
const portableProcess = spawn(executable, [`--user-data-dir=${userDataDir}`], {
  cwd: path.dirname(executable),
  env: cleanEnvironment,
  stdio: ["ignore", logHandle, logHandle],
  windowsHide: false,
});
fs.closeSync(logHandle);

const origin = `http://127.0.0.1:${port}`;
const waitForHealth = async () => {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`, { cache: "no-store" });
      if (response.ok) return { status: response.status, body: await response.json() };
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`single-file portable app never became healthy: ${lastError}`);
};

const stopIsolatedProcesses = () => {
  if (portableProcess.exitCode === null) {
    spawnSync("taskkill", ["/PID", String(portableProcess.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  }
  const escapedUserData = userDataDir.replaceAll("'", "''");
  const script = [
    `$needle = '${escapedUserData}'`,
    "$processes = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \"*$needle*\" }",
    "foreach ($process in $processes) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join("; ");
  spawnSync("powershell", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    stdio: "ignore",
  });
};

let browser;
try {
  const health = await waitForHealth();
  assert(health.body?.ok === true, `packaged health endpoint failed: ${JSON.stringify(health)}`);
  assert(health.body?.configured === false, "clean-machine launch inherited a DeepSeek key");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1520, height: 1440 } });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(origin, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForSelector("[data-testid=game-canvas]", { timeout: 30_000 });

  const initial = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(initial.cats.length === 11, `fresh single-file game did not create 11 starter cats: ${initial.cats.length}`);
  assert(initial.treasuryCents === 15_000, `fresh single-file game has unexpected treasury: ${initial.treasuryCents}`);
  await page.evaluate(() => window.advanceTime(10_000));
  const advanced = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(advanced.simTimeMs >= 10_000, `deterministic simulation did not advance: ${advanced.simTimeMs}`);
  assert(advanced.cats.some((cat) => cat.action !== null), "starter cats never entered an action");
  await page.screenshot({ path: path.join(outputRoot, "fresh-single-exe-running.png"), omitBackground: true });
  assert(errors.length === 0, `renderer errors: ${errors.join(" | ")}`);

  const result = {
    ok: true,
    executable,
    executableBytes: fs.statSync(executable).size,
    health,
    inheritedDeepSeekKey: health.body.configured,
    initial: {
      simTimeMs: initial.simTimeMs,
      cats: initial.cats.length,
      treasuryCents: initial.treasuryCents,
      unlockedRecipes: initial.unlockedRecipes.length,
    },
    advanced: {
      simTimeMs: advanced.simTimeMs,
      discoveredItems: advanced.discoveredItems,
      activeActions: advanced.cats.filter((cat) => cat.action !== null).length,
    },
    isolatedDirectories: { userDataDir, appDataDir, localAppDataDir, tempDir },
    environmentKeys: Object.keys(cleanEnvironment).sort(),
    errors,
  };
  fs.writeFileSync(path.join(outputRoot, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close().catch(() => undefined);
  stopIsolatedProcesses();
}
