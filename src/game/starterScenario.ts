import { hashSource, STARTER_LAW_SOURCE } from "./lawInterpreter";
import { difficultyProfile } from "./difficulty";
import type { CatState, DifficultyLevel, LawVersion, Position, ResourceNode } from "./types";
import { generateStarterWorld } from "./world";

const PASSIVE_SOURCE = "function decide(ctx) { return null; }";

function cat(position: Position, createdIndex: number): CatState {
  return {
    id: `cat-${createdIndex}`,
    createdIndex,
    position: { ...position },
    inventory: {},
    coins: 0,
    debtCents: 0,
    escrowReservedCents: 0,
    action: null,
    lastDecision: "准备自主学习前十五项配方",
    decisionTrace: [],
  };
}

function law(
  id: string,
  title: string,
  playerText: string,
  summary: string,
  category: "behavior" | "price" | "tax" | "system",
  options: { taxRate?: number; priceItemId?: string | "*"; priceMultiplier?: number; locked?: boolean },
): LawVersion {
  return {
    id,
    title,
    playerText,
    summary,
    sourceCode: category === "behavior" ? STARTER_LAW_SOURCE : PASSIVE_SOURCE,
    astHash: hashSource(category === "behavior" ? STARTER_LAW_SOURCE : PASSIVE_SOURCE),
    examples: [],
    warnings: [],
    enactedAt: 0,
    category,
    taxRate: category === "tax" ? options.taxRate ?? 0 : null,
    priceItemId: category === "price" ? options.priceItemId ?? "*" : null,
    priceMultiplier: category === "price" ? options.priceMultiplier ?? 1 : null,
    hitCount: 0,
    invalidCount: 0,
    consecutiveFaults: 0,
    status: "active",
    locked: options.locked ?? false,
  };
}

export function createStarterScenario(worldSeed: number, difficulty: DifficultyLevel = 3): { cats: CatState[]; laws: LawVersion[]; resourceNodes: ResourceNode[] } {
  const world = generateStarterWorld(worldSeed);
  const profile = difficultyProfile(difficulty);
  return {
    cats: world.catPositions.map(cat),
    resourceNodes: world.resourceNodes,
    laws: [
      law("starter-law-local-greedy", "两格观察与广播总则", "猫只观察曼哈顿距离2内的工位；订单、悬赏、报价与结案由猫署名后即时广播给全体猫。", "全体猫共享同一份决策逻辑。广播不受距离限制，只有实物运输必须沿相邻猫链逐格完成。", "behavior", {}),
      law("starter-law-cent-settlement", "分币结算法", "所有价格、税款、货款和运费均以整数分结算。", "一金币等于100分；结算只使用整数分，界面再换算成金币。", "system", { locked: true }),
      law("starter-law-private-credit", "猫咪信用法", "猫可使用有限银行信用完成预计盈利的采购。", `难度${difficulty}的基础信用为${profile.baseCreditCents / 100}金币，再加保守净资产；借款费率2%且至少1分，收入优先偿债。`, "system", { locked: true }),
      law("starter-law-discovery-bounty", "全品类首次发现悬赏法", "首次制作任意一种商品都可领取一次发现悬赏。", `65项商品均按基础售价的${profile.bountyMultiplier}倍悬赏；开工时锁定，完工支付且不消耗商品。`, "system", { locked: true }),
      law("starter-law-wood-lines", "齿轮溢价条例", "将齿轮售价提高 50%。", "齿轮实际售价为基础价格的 150%。", "price", { priceItemId: "gear", priceMultiplier: 1.5 }),
      law("starter-law-brick-line", "金属溢价条例", "将金属售价提高 25%。", "金属实际售价为基础价格的 125%。", "price", { priceItemId: "metal", priceMultiplier: 1.25 }),
      law("starter-law-sales-tax", "工坊五成销售税", "对每笔销售征收 50% 的税，税款进入国库。", "售价确定后征收 50% 销售税，其余收入归卖方猫咪。", "tax", { taxRate: 0.5 }),
    ],
  };
}
