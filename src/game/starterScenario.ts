import { difficultyProfile } from "./difficulty";
import {
  hashSource,
  STARTER_FOUNDATION_CYCLE_SOURCE,
  STARTER_LAW_SOURCE,
  STARTER_RESOURCE_SUPPLY_SOURCE,
  STARTER_WORKSHOP_CYCLE_SOURCE,
} from "./lawInterpreter";
import type { CatState, DifficultyLevel, LawSpeechTemplates, LawVersion, Position, ResourceNode } from "./types";
import { generateStarterWorld } from "./world";

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
    lastDecision: "等待入场动作完成",
    decisionTrace: [],
    decisionSerial: 0,
    lastSpeechAt: null,
  };
}

function starterSpeech(theme: string): LawSpeechTemplates {
  return [
    `因{reason}，{action}能赚{gain}喵！`,
    `按{law}，{reason}；{action}赚{gain}喵。`,
    `${theme}算出{action}有{gain}，因为{reason}喵！`,
    `我算过了：{action}赚{gain}，{reason}喵。`,
    `因为{reason}，所以{action}，能赚{gain}喵！`,
  ];
}

function law(
  id: string,
  title: string,
  playerText: string,
  summary: string,
  sourceCode: string,
  locked = false,
): LawVersion {
  return {
    id,
    title,
    playerText,
    summary,
    sourceCode,
    astHash: hashSource(sourceCode),
    program: { version: 2 },
    examples: [],
    warnings: [],
    speechTemplates: starterSpeech(title),
    enactedAt: 0,
    hitCount: 0,
    invalidCount: 0,
    consecutiveFaults: 0,
    status: "active",
    locked,
  };
}

export function createStarterScenario(
  worldSeed: number,
  difficulty: DifficultyLevel = 3,
): { cats: CatState[]; laws: LawVersion[]; resourceNodes: ResourceNode[] } {
  const world = generateStarterWorld(worldSeed);
  const profile = difficultyProfile(difficulty);
  return {
    cats: world.catPositions.map(cat),
    resourceNodes: world.resourceNodes,
    laws: [
      law("starter-law-local-greedy", "资产贪心与广播总则",
        "猫比较所有本地可行生产、悬赏和订单，选择单位作业负担下净资产增益最高的方案。",
        "本法规请求唯一选择器；其他法规的公开评分调整按法典顺序共同生效。", STARTER_LAW_SOURCE),
      law("starter-law-resource-supply", "所在地资源续供法",
        "猫在资源采集范围内时，按该位置实际资源与最近产量动态补产。",
        "不列举商品；只把当前工位可采资源传给统一评分器。", STARTER_RESOURCE_SUPPLY_SOURCE),
      law("starter-law-foundation-cycle", "单计划优先履约法",
        "每只猫最多锁定一个生产计划；计划可执行时优先完成，等待原料时继续处理不占用计划物资的盈利副业。",
        "目标商品只读取本猫唯一计划并获得最高优先级；副业不会建立第二计划，也不能消耗计划保留物。", STARTER_FOUNDATION_CYCLE_SOURCE),
      law("starter-law-workshop-cycle", "全市场短缺轮换法",
        "全体猫用同一市场摘要优先尝试最近产出最少的已解锁商品。",
        "法规只调整可行候选的排序；可靠报价、利润和信用门槛仍不可绕过。", STARTER_WORKSHOP_CYCLE_SOURCE),
      law("starter-law-private-credit", "猫咪信用法",
        "猫可使用有限银行信用完成预计盈利的采购。",
        `难度${difficulty}的基础信用为${profile.baseCreditCents / 100}金币，再加保守净资产；收入优先偿债。`,
        `function decide(ctx) {\n  setCredit(${profile.baseCreditCents}, 1);\n  return null;\n}`, true),
      law("starter-law-discovery-bounty", "全品类首次发现悬赏法",
        "首次制作任意一种商品都可领取一次发现悬赏。",
        `65项商品均按基础售价的${profile.bountyMultiplier}倍悬赏；开工时锁定，完工支付。`,
        `function decide(ctx) {\n  setBounty(${profile.bountyMultiplier});\n  return null;\n}`, true),
    ],
  };
}
