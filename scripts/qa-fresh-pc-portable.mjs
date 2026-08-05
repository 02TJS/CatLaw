import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const executablePath = process.env.CAT_WORKSHOP_PORTABLE_EXE;
if (!executablePath || !path.isAbsolute(executablePath)) {
  throw new Error("CAT_WORKSHOP_PORTABLE_EXE must be an absolute path to the extracted portable executable");
}

const executable = path.resolve(executablePath);
const runtimeRoot = path.dirname(executable);
const requiredRuntimeFiles = [
  path.basename(executable),
  "resources/app.asar",
  "icudtl.dat",
  "libEGL.dll",
  "libGLESv2.dll",
  "resources.pak",
  "snapshot_blob.bin",
  "v8_context_snapshot.bin",
  "vk_swiftshader.dll",
  "vk_swiftshader_icd.json",
  "vulkan-1.dll",
  "locales/zh-CN.pak",
];
for (const relativePath of requiredRuntimeFiles) {
  assert(fs.existsSync(path.join(runtimeRoot, relativePath)), `portable runtime is missing ${relativePath}`);
}
assert(!fs.existsSync(path.join(runtimeRoot, ".env")), "portable runtime unexpectedly contains .env");

const outputRoot = path.resolve("output", "fresh-pc-portable", `run-${Date.now()}`);
const userDataDir = path.join(outputRoot, "Fresh User Data");
const appDataDir = path.join(outputRoot, "AppData");
const localAppDataDir = path.join(outputRoot, "LocalAppData");
const tempDir = path.join(outputRoot, "Temp");
for (const directory of [userDataDir, appDataDir, localAppDataDir, tempDir]) {
  fs.mkdirSync(directory, { recursive: true });
}

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
  CAT_WORKSHOP_PORT: "18826",
};

const app = await electron.launch({
  executablePath: executable,
  args: [`--user-data-dir=${userDataDir}`],
  env: cleanEnvironment,
});

try {
  const page = await app.firstWindow();
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
  assert(initial.treasuryCents === 15_000, `fresh portable game has unexpected treasury: ${initial.treasuryCents}`);
  await page.evaluate(() => window.advanceTime(10_000));
  const advanced = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(advanced.simTimeMs >= 10_000, `deterministic simulation did not advance: ${advanced.simTimeMs}`);
  assert(advanced.cats.some((cat) => cat.action !== null), "starter cats never entered an action after advancing time");

  await page.screenshot({ path: path.join(outputRoot, "fresh-portable-running.png"), omitBackground: true });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("[data-testid=game-canvas]", { timeout: 30_000 });
  const reloaded = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert(reloaded.cats.length === 11, "fresh portable game lost its starter world on reload");
  assert(errors.length === 0, `renderer errors: ${errors.join(" | ")}`);

  const result = {
    ok: true,
    executable,
    runtimeRoot,
    requiredRuntimeFiles,
    inheritedDeepSeekKey: health.body.configured,
    health,
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
    reload: {
      simTimeMs: reloaded.simTimeMs,
      cats: reloaded.cats.length,
    },
    isolatedDirectories: { userDataDir, appDataDir, localAppDataDir, tempDir },
    environmentKeys: Object.keys(cleanEnvironment).sort(),
    errors,
  };
  fs.writeFileSync(path.join(outputRoot, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await app.close().catch(() => undefined);
}
