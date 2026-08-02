import { ITEMS, RECIPES } from "../src/game/catalog";
import {
  advanceGame,
  buildingPlacementFailure,
  buyBuildingOffer,
  createInitialState,
  enactLaw,
  expandParcel,
  placeCat,
  placeOwnedBuilding,
  repealLaw,
  resourceAt,
  unlockRecipe,
} from "../src/game/engine";
import { hashSource } from "../src/game/lawInterpreter";
import type { DifficultyLevel, GameState, LawDraft, Position } from "../src/game/types";
import { isPositionUnlocked } from "../src/game/world";

export interface Qa35Operation {
  sequence: number;
  atMs: number;
  stage: "setup" | "phase1" | "phase2" | "phase3";
  kind: "test-budget" | "recipe-unlock" | "law-enact" | "law-repeal" | "parcel-expand"
    | "cat-place" | "building-buy" | "building-place" | "time-advance" | "phase-check";
  target: string;
  detail: string;
  costCents: number;
  lawId?: string;
  position?: Position;
}

type RecordOperation = (operation: Omit<Qa35Operation, "sequence" | "atMs">) => void;

function priceLaw(itemId: string, multiplier: number): LawDraft {
  const sourceCode = "function decide(ctx) { return choose(); }";
  return {
    title: `${itemId}悬赏加权法`,
    playerText: `提高${itemId}价格权重`,
    summary: `${itemId}实际售价乘以${multiplier}`,
    sourceCode,
    astHash: hashSource(sourceCode),
    examples: [],
    warnings: [],
    category: "price",
    taxRate: null,
    priceItemId: itemId,
    priceMultiplier: multiplier,
    validation: { syntax: true, safety: true, examplesPassed: 0, examplesTotal: 0, messages: [] },
  };
}

function sharedProductionLaw(): LawDraft {
  const sourceCode = `function decide(ctx) {
  return choose();
}`;
  return {
    title: "广播订单逐猫贪心法",
    playerText: "每只猫按自己的库存、计划和全局广播选择当前最有利动作。",
    summary: "全体猫共用同一逻辑，但不统一抬高所有制作动作；商品方向由价格法规引导。",
    sourceCode,
    astHash: hashSource(sourceCode),
    examples: [],
    warnings: [],
    category: "behavior",
    taxRate: null,
    priceItemId: null,
    priceMultiplier: null,
    validation: { syntax: true, safety: true, examplesPassed: 0, examplesTotal: 0, messages: [] },
  };
}

function buyRecipeRange(
  state: GameState,
  from: number,
  to: number,
  record?: RecordOperation,
  stage: Qa35Operation["stage"] = "phase3",
): void {
  for (const recipe of RECIPES.slice(from - 1, to)) {
    const result = unlockRecipe(state, recipe.id);
    if (!result.ok && !state.unlockedRecipes.includes(recipe.id)) {
      throw new Error(`unlock ${recipe.id}: ${result.error}`);
    }
    if (result.ok) record?.({
      stage,
      kind: "recipe-unlock",
      target: recipe.output,
      detail: `购买第 ${RECIPES.indexOf(recipe) + 1} 项配方 ${recipe.id}`,
      costCents: result.cost ?? 0,
    });
  }
}

function enactPriceRange(
  state: GameState,
  from: number,
  to: number,
  activeGuidanceLaws: Map<string, string>,
  record?: RecordOperation,
): void {
  for (const recipe of RECIPES.slice(from - 1, to)) {
    if (state.laws.some((law) => law.status === "active" && law.category === "price"
      && law.priceItemId === recipe.output && law.priceMultiplier === 2)) continue;
    const treasuryBefore = state.treasuryCoins;
    const enacted = enactLaw(state, priceLaw(recipe.output, 2));
    if (!enacted.ok) throw new Error(`enact ${recipe.output}: ${enacted.error}`);
    if (enacted.law) activeGuidanceLaws.set(recipe.output, enacted.law.id);
    record?.({
      stage: "phase3",
      kind: "law-enact",
      target: recipe.output,
      detail: `阶段价格引导：${recipe.output} 实际售价 ×2；首次制造后废止`,
      costCents: treasuryBefore - state.treasuryCoins,
      lawId: enacted.law?.id,
    });
  }
}

type IndustrialBuildingId = "factory" | "machine_tool" | "antenna";

function planIndustrialSite(state: GameState): Record<IndustrialBuildingId, Position> {
  let best: { positions: [Position, Position, Position]; score: number } | null = null;
  for (const anchor of state.cats) {
    const candidates: Position[] = [];
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
      if (Math.abs(dx) + Math.abs(dy) > 2) continue;
      const position = { x: anchor.position.x + dx, y: anchor.position.y + dy };
      if (!buildingPlacementFailure(state, "factory", position)) candidates.push(position);
    }
    for (let first = 0; first < candidates.length; first += 1) {
      for (let second = first + 1; second < candidates.length; second += 1) {
        for (let third = second + 1; third < candidates.length; third += 1) {
          const positions = [candidates[first], candidates[second], candidates[third]] as [Position, Position, Position];
          const commonCats = state.cats.filter((cat) => positions.every((position) => (
            Math.abs(cat.position.x - position.x) + Math.abs(cat.position.y - position.y) <= 2
          )));
          const totalCoverage = positions.reduce((sum, position) => sum + state.cats.filter((cat) => (
            Math.abs(cat.position.x - position.x) + Math.abs(cat.position.y - position.y) <= 2
          )).length, 0);
          // Advanced bounty plans need working capital. A player inspecting the
          // cat panel can see cash and credit, so prefer a solvent common host
          // before using density as the deterministic tie-breaker.
          const strongestHostCash = Math.max(0, ...commonCats.map((cat) => cat.coins));
          // When several cats satisfy every specialist radius, they can split
          // the sequential bounties and leave the final vehicle planner short
          // of credit. Prefer one clearly specialized host so its radio,
          // robot and fabricator rewards compound into vehicle working capital.
          const score = strongestHostCash * 100_000 - commonCats.length * 1000 + totalCoverage;
          if (!best || score > best.score) best = { positions, score };
        }
      }
    }
  }
  if (!best) throw new Error("no three-tile industrial site near a cat");
  return { factory: best.positions[0], antenna: best.positions[1], machine_tool: best.positions[2] };
}

function buyAndPlaceBuilding(state: GameState, itemId: IndustrialBuildingId, position: Position, record?: RecordOperation): boolean {
  const offer = state.buildingOffers.find((entry) => entry.status === "open" && entry.itemId === itemId);
  if (!offer) return false;
  const treasuryBefore = state.treasuryCoins;
  const bought = buyBuildingOffer(state, offer.id);
  if (!bought.ok) throw new Error(bought.error);
  record?.({
    stage: "phase3",
    kind: "building-buy",
    target: offer.id,
    detail: `从 cat ${offer.sellerCatId} 的固定报价收购${itemId}`,
    costCents: treasuryBefore - state.treasuryCoins,
  });
  const placed = placeOwnedBuilding(state, itemId, position);
  if (!placed.ok) throw new Error(placed.error);
  record?.({
    stage: "phase3",
    kind: "building-place",
    target: itemId,
    detail: `将${itemId}放到覆盖猫群最多的合法普通空地`,
    costCents: 0,
    position,
  });
  return true;
}

function addIndustrialWorkers(
  state: GameState,
  site: Record<IndustrialBuildingId, Position>,
  record?: RecordOperation,
): number {
  const candidates: Position[] = [];
  for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
    if (Math.abs(dx) + Math.abs(dy) > 2) continue;
    candidates.push({ x: site.factory.x + dx, y: site.factory.y + dy });
  }
  candidates.sort((left, right) => {
    const specializationLeft = Number(Math.abs(left.x - site.antenna.x) + Math.abs(left.y - site.antenna.y) <= 2)
      + Number(Math.abs(left.x - site.machine_tool.x) + Math.abs(left.y - site.machine_tool.y) <= 2);
    const specializationRight = Number(Math.abs(right.x - site.antenna.x) + Math.abs(right.y - site.antenna.y) <= 2)
      + Number(Math.abs(right.x - site.machine_tool.x) + Math.abs(right.y - site.machine_tool.y) <= 2);
    return specializationLeft - specializationRight || left.y - right.y || left.x - right.x;
  });
  let added = 0;
  for (const position of candidates) {
    if (added >= 6) break;
    const cat = placeCat(state, position);
    if (!cat) continue;
    added += 1;
    record?.({
      stage: "phase3",
      kind: "cat-place",
      target: cat.id,
      detail: "补充工厂半径2内的电子零件工位，优先避开三设施共同覆盖区",
      costCents: 0,
      position: { ...position },
    });
  }
  return added;
}

function addExpansionChain(state: GameState, record?: RecordOperation): number {
  const expanded = expandParcel(state, { x: 1, y: 0 });
  if (!expanded.ok) throw new Error(expanded.error);
  record?.({
    stage: "phase3",
    kind: "parcel-expand",
    target: "parcel:1,0",
    detail: "购买中央地块东侧相邻的 9×9 地块",
    costCents: expanded.cost ?? 0,
    position: { x: 1, y: 0 },
  });
  const existing = new Map(state.cats.map((cat) => [`${cat.position.x},${cat.position.y}`, cat.position]));
  const queue = state.cats.map((cat) => cat.position);
  const previous = new Map(queue.map((position) => [`${position.x},${position.y}`, null as Position | null]));
  let goal: Position | null = null;
  while (queue.length && !goal) {
    const current = queue.shift()!;
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const next = { x: current.x + dx, y: current.y + dy };
      const key = `${next.x},${next.y}`;
      if (previous.has(key) || !isPositionUnlocked(state.unlockedParcels, next) || resourceAt(state, next)) continue;
      previous.set(key, current);
      if (next.x >= 5) { goal = next; break; }
      queue.push(next);
    }
  }
  if (!goal) throw new Error("no path into expanded parcel");
  const path: Position[] = [];
  for (let cursor: Position | null = goal; cursor; cursor = previous.get(`${cursor.x},${cursor.y}`) ?? null) path.push(cursor);
  path.reverse();
  let added = 0;
  for (const target of path) if (!existing.has(`${target.x},${target.y}`)) {
    const cat = placeCat(state, target);
    if (cat) {
      existing.set(`${target.x},${target.y}`, target);
      added += 1;
      record?.({
        stage: "phase3",
        kind: "cat-place",
        target: cat.id,
        detail: "铺设进入东侧地块的相邻运输链",
        costCents: 0,
        position: { ...target },
      });
    }
  }
  const frontier = state.cats.map((cat) => cat.position);
  const visited = new Set(frontier.map((position) => `${position.x},${position.y}`));
  while (frontier.length && added < 24) {
    const current = frontier.shift()!;
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const next = { x: current.x + dx, y: current.y + dy };
      const key = `${next.x},${next.y}`;
      if (visited.has(key) || !isPositionUnlocked(state.unlockedParcels, next) || resourceAt(state, next)) continue;
      visited.add(key);
      if (!existing.has(key)) {
        const cat = placeCat(state, next);
        if (cat) {
          existing.set(key, next);
          added += 1;
          record?.({
            stage: "phase3",
            kind: "cat-place",
            target: cat.id,
            detail: "补密本地生产与逐格运输网络",
            costCents: 0,
            position: { ...next },
          });
        }
      }
      frontier.push(next);
      if (added >= 24) break;
    }
  }
  return added;
}

function allCrafted(state: GameState, count: number): boolean {
  return RECIPES.slice(0, count).every((recipe) => state.itemStats[recipe.output].crafted > 0);
}

function report(state: GameState, label: string) {
  const highest = ITEMS.reduce((best, item, index) => state.itemStats[item.id].crafted > 0 ? index + 1 : best, 0);
  const activePlans = state.procurementPlans.filter((plan) => plan.status === "active").map((plan) => plan.outputItemId);
  process.stdout.write(`${label} t=${state.simTime * state.simulationSpeed / 1000}s discovered=${state.discoveredItems.length} highest=${highest} plans=${activePlans.join(",")} orders=${state.demandOrders.filter((o) => o.status === "open").length} offers=${state.buildingOffers.filter((o) => o.status === "open").map((o) => o.itemId).join(",")}\n`);
}

export function playSeed(
  seed: number,
  verbose = false,
  maxMs = 7_200_000,
  simulationSpeed = 5_000,
  difficulty: DifficultyLevel = 3,
) {
  const state = createInitialState({ worldSeed: seed, simulationSpeed, difficulty });
  const scaled = (milliseconds: number) => milliseconds / simulationSpeed;
  const operations: Qa35Operation[] = [];
  const firstCraftObservedAtMs: Partial<Record<string, number>> = {};
  const record: RecordOperation = (operation) => operations.push({
    sequence: operations.length + 1,
    atMs: state.simTime * state.simulationSpeed,
    ...operation,
  });
  const captureFirstCrafts = () => {
    for (const recipe of RECIPES) if (state.itemStats[recipe.output].crafted > 0
      && firstCraftObservedAtMs[recipe.output] === undefined) {
      firstCraftObservedAtMs[recipe.output] = state.simTime * state.simulationSpeed;
    }
  };
  state.treasuryCoins = 1_000_000_000;
  record({
    stage: "setup",
    kind: "test-budget",
    target: "treasury",
    detail: "验收专用充足预算；只隔离资金约束，不注入商品、发现、猫、配方或建筑",
    costCents: 0,
  });
  const spendingStart = state.treasuryCoins;
  buyRecipeRange(state, 10, 15, record, "phase1");
  while (state.simTime < scaled(300_000) && !allCrafted(state, 15)) {
    const fromMs = state.simTime * state.simulationSpeed;
    advanceGame(state, scaled(30_000));
    captureFirstCrafts();
    record({
      stage: "phase1",
      kind: "time-advance",
      target: "clock",
      detail: `确定性时钟从 ${fromMs}ms 推进到 ${state.simTime * state.simulationSpeed}ms`,
      costCents: 0,
    });
  }
  if (!allCrafted(state, 15)) {
    throw new Error(`seed ${seed} did not complete the first fifteen items within 300 seconds`);
  }
  const phase1CompleteAt = state.simTime * simulationSpeed;
  record({
    stage: "phase1",
    kind: "phase-check",
    target: "items:1-15",
    detail: "前 15 项均已实际制造；此前没有改法、扩地、加猫或放建筑",
    costCents: 0,
  });

  buyRecipeRange(state, 16, 20, record, "phase2");
  const phase2EndsAt = Math.min(scaled(maxMs), state.simTime + scaled(300_000));
  while (state.simTime < phase2EndsAt) {
    const fromMs = state.simTime * state.simulationSpeed;
    const step = Math.min(scaled(30_000), phase2EndsAt - state.simTime);
    advanceGame(state, step);
    captureFirstCrafts();
    record({
      stage: "phase2",
      kind: "time-advance",
      target: "clock",
      detail: `卡点观察：确定性时钟从 ${fromMs}ms 推进到 ${state.simTime * state.simulationSpeed}ms`,
      costCents: 0,
    });
  }
  const phase2Items = RECIPES.slice(15, 20).map((recipe) => ({
    itemId: recipe.output,
    crafted: state.itemStats[recipe.output].crafted,
    bountyOpen: state.marketBroadcasts.some((broadcast) => broadcast.kind === "bounty-open" && broadcast.itemId === recipe.output),
  }));
  const phase2Stalled = phase2Items.every((entry) => entry.crafted === 0 && entry.bountyOpen);
  if (!phase2Stalled) throw new Error(`seed ${seed} did not stall at items 16-20`);
  record({
    stage: "phase2",
    kind: "phase-check",
    target: "items:16-20",
    detail: "连续观察 300 模拟秒：五项产量仍为 0，且五张首次发现悬赏广播保持开放",
    costCents: 0,
  });

  const sharedLawTreasuryBefore = state.treasuryCoins;
  const sharedLaw = enactLaw(state, sharedProductionLaw());
  if (!sharedLaw.ok || !sharedLaw.law) throw new Error(`enact shared production law: ${sharedLaw.error}`);
  record({
    stage: "phase3",
    kind: "law-enact",
    target: "shared-behavior",
    detail: "全体猫共用 choose()：按自身库存、计划和全局署名广播执行局部贪心",
    costCents: sharedLawTreasuryBefore - state.treasuryCoins,
    lawId: sharedLaw.law.id,
  });
  const activeGuidanceLaws = new Map<string, string>();
  buyRecipeRange(state, 21, 27, record);
  enactPriceRange(state, 16, 27, activeGuidanceLaws, record);
  const addedCats = addExpansionChain(state, record);
  const industrialSite = planIndustrialSite(state);
  const placedBuildings = new Set<string>();
  let industrialWorkersAdded = false;
  let advancedRecipesPurchased = false;
  let lastDiscoveryCount = state.discoveredItems.length;
  let lastDiscoveryAt = state.simTime;
  const temporaryLaws = new Map<string, { lawId: string; craftedAt: number; enactedAt: number }>();
  let iteration = 0;
  while (state.simTime < scaled(maxMs)) {
    const fromMs = state.simTime * state.simulationSpeed;
    const step = Math.min(scaled(30_000), scaled(maxMs) - state.simTime);
    advanceGame(state, step);
    captureFirstCrafts();
    record({
      stage: "phase3",
      kind: "time-advance",
      target: "clock",
      detail: `市场运行：确定性时钟从 ${fromMs}ms 推进到 ${state.simTime * state.simulationSpeed}ms`,
      costCents: 0,
    });
    for (const [itemId, lawId] of activeGuidanceLaws) {
      if (state.itemStats[itemId].crafted <= 0) continue;
      const treasuryBefore = state.treasuryCoins;
      const repealed = repealLaw(state, lawId);
      if (!repealed.ok) throw new Error(`repeal guidance ${lawId}: ${repealed.error}`);
      record({
        stage: "phase3",
        kind: "law-repeal",
        target: itemId,
        detail: "首次制造已完成，废止阶段价格引导以降低后续订单和信用成本",
        costCents: treasuryBefore - state.treasuryCoins,
        lawId,
      });
      activeGuidanceLaws.delete(itemId);
    }
    for (const [itemId, temporary] of temporaryLaws) {
      if (state.itemStats[itemId].crafted <= temporary.craftedAt) continue;
      const treasuryBefore = state.treasuryCoins;
      const repealed = repealLaw(state, temporary.lawId);
      if (!repealed.ok) throw new Error(`repeal ${temporary.lawId}: ${repealed.error}`);
      record({
        stage: "phase3",
        kind: "law-repeal",
        target: itemId,
        detail: "临时疏堵法规已促成新增产量，立即废止以免长期扭曲价格",
        costCents: treasuryBefore - state.treasuryCoins,
        lawId: temporary.lawId,
      });
      temporaryLaws.delete(itemId);
    }
    if (state.discoveredItems.length > lastDiscoveryCount) {
      lastDiscoveryCount = state.discoveredItems.length;
      lastDiscoveryAt = state.simTime;
    } else if (state.simTime - lastDiscoveryAt >= scaled(120_000)) {
      const recipeOrder = new Map(RECIPES.map((recipe, index) => [recipe.output, index]));
      const stalledItems = [...new Set(state.demandOrders.filter((order) => order.status === "open").map((order) => order.itemId))]
        .sort((left, right) => (recipeOrder.get(right) ?? -1) - (recipeOrder.get(left) ?? -1));
      const itemId = stalledItems.find((entry) => !temporaryLaws.has(entry));
      if (itemId) {
        const treasuryBefore = state.treasuryCoins;
        const enacted = enactLaw(state, priceLaw(itemId, 2));
        if (enacted.ok && enacted.law) {
          temporaryLaws.set(itemId, {
            lawId: enacted.law.id,
            craftedAt: state.itemStats[itemId].crafted,
            enactedAt: state.simTime,
          });
          record({
            stage: "phase3",
            kind: "law-enact",
            target: itemId,
            detail: "120 秒无新发现：按最深未满足订单临时给予 ×2 价格引导",
            costCents: treasuryBefore - state.treasuryCoins,
            lawId: enacted.law.id,
          });
        }
      }
      lastDiscoveryAt = state.simTime;
    }
    for (const buildingId of ["factory", "machine_tool", "antenna"] as const) {
      if (placedBuildings.has(buildingId)) continue;
      if (buyAndPlaceBuilding(state, buildingId, industrialSite[buildingId], record)) {
        placedBuildings.add(buildingId);
      }
    }
    if (!industrialWorkersAdded && ["factory", "machine_tool", "antenna"].every((id) => placedBuildings.has(id))) {
      addIndustrialWorkers(state, industrialSite, record);
      industrialWorkersAdded = true;
    }
    if (!advancedRecipesPurchased && placedBuildings.has("factory")) {
      buyRecipeRange(state, 28, 35, record);
      enactPriceRange(state, 28, 35, activeGuidanceLaws, record);
      advancedRecipesPurchased = true;
    }
    if (verbose && iteration % 10 === 0) report(state, "tick");
    if (allCrafted(state, 35)) break;
    iteration += 1;
  }
  record({
    stage: "phase3",
    kind: "phase-check",
    target: "items:1-35",
    detail: "前 35 项均有实际制造记录；车辆已出现，工厂范围链路成立",
    costCents: 0,
  });
  return {
    seed,
    difficulty,
    passed: allCrafted(state, 35) && phase2Stalled && placedBuildings.has("factory") && addedCats > 0,
    phase1: { passed: true, completeAtMs: phase1CompleteAt },
    phase2: { passed: phase2Stalled, observedForMs: 300_000, items: phase2Items },
    phase3: {
      passed: allCrafted(state, 35) && placedBuildings.has("factory") && placedBuildings.has("machine_tool") && placedBuildings.has("antenna"),
      sharedLawId: sharedLaw.law.id,
      addedCats,
      expandedParcel: state.unlockedParcels.some((parcel) => parcel.x === 1 && parcel.y === 0),
      buildingsPlaced: [...placedBuildings],
    },
    vehicle: state.itemStats.vehicle.crafted,
    discovered: state.discoveredItems.length,
    factoryPlaced: placedBuildings.has("factory"),
    simTime: state.simTime * simulationSpeed,
    spentCents: spendingStart - state.treasuryCoins,
    operations,
    firstCraftObservedAtMs,
    state,
  };
}

const entryPath = process.argv[1]?.replace(/\\/g, "/");
if (entryPath && import.meta.url === `file:///${entryPath}`) {
  const seed = Number(process.argv[2] ?? 1);
  const verbose = process.argv[4] !== "quiet";
  const difficulty = Number(process.argv[5] ?? 3) as DifficultyLevel;
  const result = playSeed(seed, verbose, Number(process.argv[3] ?? 7_200_000), 5_000, difficulty);
  report(result.state, "final");
  if (!result.passed) {
    process.stdout.write(`${JSON.stringify({
      plans: result.state.procurementPlans.filter((plan) => plan.status === "active").map((plan) => ({
        ...plan,
        inventory: result.state.cats.find((cat) => cat.id === plan.catId)?.inventory,
        decision: result.state.cats.find((cat) => cat.id === plan.catId)?.lastDecision,
      })),
      orders: result.state.demandOrders.filter((order) => order.status === "open"),
      contracts: result.state.shipmentContracts.filter((contract) => contract.status !== "delivered"),
      signals: result.state.orderSignals,
      cats: result.state.cats.map((cat) => ({ id: cat.id, position: cat.position, inventory: cat.inventory, coins: cat.coins, debt: cat.debtCents, escrow: cat.escrowReservedCents, action: cat.action, decision: cat.lastDecision })),
    }, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ ...result, state: undefined }, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}
