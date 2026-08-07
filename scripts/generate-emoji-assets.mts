import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const SOURCE_ROOTS = ["src", "server"];
const OUTPUT_DIR = path.resolve("public", "emoji");
const TWEMOJI_VERSION = "14.0.2";
const REQUIRED = ["📦", "🏗️", "🏛️", "❔", "🌀", "🔑", "✨"];

const codeFor = (emoji: string) => [...emoji]
  .map((character) => character.codePointAt(0)!)
  .filter((codePoint) => codePoint !== 0xfe0f)
  .map((codePoint) => codePoint.toString(16))
  .join("-");

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(absolute));
    else if (/\.(?:ts|tsx)$/u.test(entry.name)) result.push(absolute);
  }
  return result;
}

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
const emojis = new Set(REQUIRED);
for (const root of SOURCE_ROOTS) {
  for (const file of await sourceFiles(path.resolve(root))) {
    const source = await readFile(file, "utf8");
    for (const { segment } of segmenter.segment(source)) {
      if (/\p{Extended_Pictographic}/u.test(segment)) emojis.add(segment);
    }
  }
}

await mkdir(OUTPUT_DIR, { recursive: true });
const failures: string[] = [];
for (const emoji of [...emojis].sort()) {
  const code = codeFor(emoji);
  const response = await fetch(`https://cdn.jsdelivr.net/gh/twitter/twemoji@v${TWEMOJI_VERSION}/assets/72x72/${code}.png`);
  if (!response.ok) {
    failures.push(`${emoji} (${code}): HTTP ${response.status}`);
    continue;
  }
  await writeFile(path.join(OUTPUT_DIR, `${code}.png`), Buffer.from(await response.arrayBuffer()));
}

await writeFile(path.join(OUTPUT_DIR, "NOTICE.txt"), [
  `Twemoji ${TWEMOJI_VERSION} graphics`,
  "Copyright 2020 Twitter, Inc and other contributors",
  "Licensed under CC-BY 4.0: https://creativecommons.org/licenses/by/4.0/",
  "Source: https://github.com/twitter/twemoji",
  "",
].join("\n"), "utf8");

if (failures.length > 0) throw new Error(`Missing Twemoji assets:\n${failures.join("\n")}`);
console.log(`Generated ${emojis.size} local emoji PNG assets in ${OUTPUT_DIR}`);
