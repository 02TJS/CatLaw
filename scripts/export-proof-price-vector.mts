import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { CATALOG_ANALYSIS, CATALOG_VERSION, ITEMS } from "../src/game/catalog";

const output = process.argv.find((entry) => entry.startsWith("--output="))?.slice("--output=".length)
  ?? "output/proof-price-vector.json";
const catalogBody = await readFile("src/game/catalog.ts");
const prices = ITEMS.map((item, index) => ({
  index: index + 1,
  itemId: item.id,
  priceCoins: CATALOG_ANALYSIS.basePrices[item.id],
}));
await writeFile(output, `${JSON.stringify({
  schema: "cat-workshop-proof-price-vector-v1",
  catalogVersion: CATALOG_VERSION,
  catalogSha256: createHash("sha256").update(catalogBody).digest("hex"),
  prices,
}, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output, items: prices.length })}\n`);
