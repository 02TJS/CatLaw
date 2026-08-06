import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const outputRoot = path.resolve("output", "electron-renderer-recovery", `run-${Date.now()}`);
const userDataDir = path.join(outputRoot, "user-data");
const protectedMarker = path.join(userDataDir, "IndexedDB", "qa-preserve.marker");
const disposableCacheNames = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache"];
const packagedExecutable = process.env.CAT_WORKSHOP_EXECUTABLE;
fs.mkdirSync(path.dirname(protectedMarker), { recursive: true });
fs.writeFileSync(protectedMarker, "preserve", "utf8");
for (const name of disposableCacheNames) {
  const staleFile = path.join(userDataDir, name, "stale-cache-entry");
  fs.mkdirSync(path.dirname(staleFile), { recursive: true });
  fs.writeFileSync(staleFile, "stale", "utf8");
}

const electronApp = await electron.launch({
  ...(packagedExecutable
    ? { executablePath: packagedExecutable, args: [`--user-data-dir=${userDataDir}`] }
    : { args: [`--user-data-dir=${userDataDir}`, path.resolve(".")] }),
  env: {
    ...process.env,
    CAT_WORKSHOP_PORT: "18818",
    CAT_WORKSHOP_QA_CRASH_RENDERER_ONCE: "1",
  },
});

try {
  const firstWindow = await electronApp.firstWindow();
  await firstWindow.waitForSelector("[data-testid=game-canvas]", { timeout: 30_000 });

  const deadline = Date.now() + 30_000;
  let replacementWindow = null;
  while (Date.now() < deadline) {
    replacementWindow = electronApp.windows().find((candidate) => candidate !== firstWindow) ?? null;
    if (replacementWindow) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(replacementWindow, "renderer crash did not create a replacement window");
  await replacementWindow.waitForSelector("[data-testid=game-canvas]", { timeout: 30_000 });
  const state = JSON.parse(await replacementWindow.evaluate(() => window.render_game_to_text()));
  assert(state.cats.length === 11, `replacement renderer lost the game state: ${state.cats.length} cats`);
  assert(fs.readFileSync(protectedMarker, "utf8") === "preserve", "renderer recovery removed IndexedDB data");
  for (const name of disposableCacheNames) {
    assert(!fs.existsSync(path.join(userDataDir, name, "stale-cache-entry")), `${name} was not cleared`);
  }
  await replacementWindow.screenshot({
    path: path.join(outputRoot, "recovered-renderer.png"),
    omitBackground: true,
  });
  console.log(JSON.stringify({
    ok: true,
    outputRoot,
    replacementCats: state.cats.length,
    indexedDbPreserved: true,
    disposableCachesCleared: disposableCacheNames,
  }, null, 2));
} finally {
  await electronApp.close().catch(() => undefined);
}
