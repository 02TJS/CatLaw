import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CATALOG_ANALYSIS, ITEMS, RECIPES } from "../src/game/catalog";
import { difficultySiteRequirements, effectiveRecipeInputs } from "../src/game/difficulty";
import { generateStarterWorld, resourceNodesAtPosition } from "../src/game/world";

const outputPath = process.argv.find((argument) => argument.startsWith("--output="))?.slice("--output=".length)
  ?? "output/price-theory-input.json";
const seedCount = Number(process.argv.find((argument) => argument.startsWith("--seeds="))?.slice("--seeds=".length) ?? "1000");

const seeds = Array.from({ length: seedCount }, (_, index) => index + 1).map((seed) => {
  const world = generateStarterWorld(seed);
  const cats = world.catPositions.map((position, catIndex) => ({
    catIndex,
    position,
    resourceItemIds: resourceNodesAtPosition(world.resourceNodes, position).map((node) => node.itemId).sort(),
  }));
  const directedEdges = cats.flatMap((source) => cats
    .filter((target) => Math.abs(source.position.x - target.position.x) + Math.abs(source.position.y - target.position.y) === 1)
    .map((target) => [source.catIndex, target.catIndex] as const));
  return {
    seed,
    cats,
    directedEdges,
    resourceNodes: world.resourceNodes,
  };
});

const payload = {
  schema: 2,
  actionDurationMs: 5_000,
  items: ITEMS.map((item, index) => ({
    index,
    id: item.id,
    name: item.name,
    emoji: item.emoji,
    tier: item.tier,
    currentCatalogPriceCoins: CATALOG_ANALYSIS.basePrices[item.id],
  })),
  recipes: RECIPES.map((recipe, index) => ({
    index,
    id: recipe.id,
    output: recipe.output,
    baseInputs: recipe.inputs,
    difficulty5Inputs: effectiveRecipeInputs(recipe, 5),
    siteRequirements: recipe.siteRequirements,
    activeSiteRequirementsByDifficulty: Object.fromEntries(
      [1, 2, 3, 4, 5].map((difficulty) => [difficulty, difficultySiteRequirements(recipe, difficulty as 1 | 2 | 3 | 4 | 5)]),
    ),
  })),
  seeds,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, seeds: seeds.length, items: ITEMS.length, recipes: RECIPES.length }));
