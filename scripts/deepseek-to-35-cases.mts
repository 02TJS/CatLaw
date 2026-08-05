import { decisionCapabilities } from "../src/game/lawProgram";
import type { LawDraft } from "../src/game/types";

const RESOURCE_CLEARING_INSTRUCTION = "在chip、memory或display悬赏开放的清场阶段，若本猫不是订单计划，则建立有界战略库存。所有资源猫在ctx.site.resourceItemId库存小于2时，对该零输入资源连续四次+1000000。第一供应锚点(-1,0)或横向布局(0,-1)只在cable不足时先补到metal一件再补到cable一件，并压低cable外售评分；第二供应锚点(1,0)或横向布局(0,1)只补到chemical一件，并压低chemical外售评分。两个锚点的当前目标连续五次+1000000，中央(0,0)只在三项现货可形成有限报价后生产chip。真实订单计划仍按原有四层加权优先，不得取消。不得创建物品、订单、信用或合同。";

export interface DeepSeekAcceptanceCase {
  id: string;
  purpose: string;
  playerText: string;
  mode: "price-only" | "price-balancing" | "logistics" | "advanced";
  expectedPrices?: Array<{ itemId: string; multiplier: number }>;
  requiredSourceTerms?: string[];
}

export const ITEMS_22_TO_30 = [
  "magnet", "wheel", "fuel", "coolant", "antenna", "machine_tool", "chip", "memory", "display",
] as const;

export const DEEPSEEK_ACCEPTANCE_CASES: DeepSeekAcceptanceCase[] = [
  {
    id: "global-x2",
    purpose: "验证最简单的全商品×2价格法能够编译，但不能伪装成动作或物流法",
    mode: "price-only",
    playerText: "制定一条纯价格法规：全部商品的实际价格都设为各自基础价格的2倍。不得返回制作或传递动作，不得调用adjust、choose、weighted、earnCoins，不得改变信用、悬赏、税收、库存或物流。",
    expectedPrices: [{ itemId: "*", multiplier: 2 }],
  },
  {
    id: "items-22-30-x2",
    purpose: "验证第22—30项逐项×2仍然只是价格效果",
    mode: "price-only",
    playerText: `制定一条纯价格法规，只把以下九项各自设为基础价格的2倍：magnet、wheel、fuel、coolant、antenna、machine_tool、chip、memory、display。统一源码中为每个稳定ID分别调用setPrice。不得含动作、评分、choose、信用、悬赏或税收调用。`,
    expectedPrices: ITEMS_22_TO_30.map((itemId) => ({ itemId, multiplier: 2 })),
  },
  {
    id: "global-x10",
    purpose: "验证高倍全局价格不能携带隐藏协调逻辑",
    mode: "price-only",
    playerText: "制定一条纯价格法规：全部商品价格设为基础价格的10倍。源码必须仅返回null；不得调用任何选择器或评分助手，不得改变信用、悬赏、税收、库存、订单或物流。",
    expectedPrices: [{ itemId: "*", multiplier: 10 }],
  },
  {
    id: "adaptive-price-only",
    purpose: "验证自适应价格方案仍被限制在价格IR，不获得物流权限",
    mode: "price-only",
    playerText: `制定一条只允许price effects的自适应价格优化法规。针对第22—30项的软瓶颈，使用温和且不同的固定倍率：magnet 1.5、wheel 1.4、fuel 1.3、coolant 1.4、antenna 1.5、machine_tool 1.5、chip 1.3、memory 1.2、display 1.2。这里“自适应”只表示按商品差异化定价，不允许decision effect、动作、adjust、choose、信用、悬赏、税收或订单修改。`,
    expectedPrices: [1.5, 1.4, 1.3, 1.4, 1.5, 1.5, 1.3, 1.2, 1.2]
      .map((multiplier, index) => ({ itemId: ITEMS_22_TO_30[index], multiplier })),
  },
  {
    id: "selective-factory-ramp",
    purpose: "先用选择性价格让第20项工厂从偶产进入持续生产",
    mode: "price-only",
    playerText: "制定一条纯价格法规：factory 4倍、fire 0.1倍。factory温和溢价用于完成价格优化阶段的首次工厂爬坡；降低fire外售机会成本，让木材能继续流入木板、工具和工厂供应链。统一源码只调用这两个setPrice并返回null。不得包含动作、adjust、choose、信用、悬赏、税收、库存或物流调用。",
    expectedPrices: [
      { itemId: "factory", multiplier: 4 },
      { itemId: "fire", multiplier: 0.1 },
    ],
  },
  {
    id: "selective-price-to-22",
    purpose: "在工厂价格法之上把连续制作推进到第22项",
    mode: "price-balancing",
    playerText: "在合法水资源资本化交易完成后新增一条统一价格优化法规：factory 2倍、lamp 1.5倍、magnet 1.5倍、chassis 4.5倍，把water、cable、battery恢复为1倍。底盘溢价用于让其普通金属订单竞争过末端订单；降低线缆和电池机会成本后，灯和磁铁在50%销售税下仍保持正收益。同一法规按公开坐标分工：(0,0)维持factory；(1,-2)的资本化工位比较lamp、magnet、chassis累计真实制作量，其中chassis比较值减4以扣除进入本阶段前的历史产量，每次只对比较值最小的一项调用一次adjust，使三者轮换并保持在静态沙箱上限内。不得直接返回craft/pass/sell动作，不得注入商品、金币、信用、悬赏、订单或物流；必须继续由统一choose流程及正常订单、配方和非亏损校验执行。",
    expectedPrices: [
      { itemId: "factory", multiplier: 2 },
      { itemId: "lamp", multiplier: 2 },
      { itemId: "magnet", multiplier: 2 },
      { itemId: "water", multiplier: 1 },
      { itemId: "cable", multiplier: 1 },
      { itemId: "battery", multiplier: 1 },
      { itemId: "chassis", multiplier: 1 },
    ],
    requiredSourceTerms: ["at(0, 0)", "onResource(\"sand\")", "onResource(\"water\")", "onResource(\"wood\")", "recentCrafted(\"plank\")", "orderCount(\"glass\")", "orderCount(\"battery\")", "adjust"],
  },
  {
    id: "water-capitalization",
    purpose: "通过公开高价收购窗口把玩家国库资金合法转为生产猫现金，交易后由最终法规恢复水价",
    mode: "price-only",
    playerText: "制定一条临时纯价格法规，只把water设为基础价格的100倍，供玩家通过公开收购和仓库转售为水资源工位补充现金。源码只返回null；不得包含动作、评分、choose、信用、悬赏、税收、库存或物流效果。",
    expectedPrices: [{ itemId: "water", multiplier: 100 }],
  },
  {
    id: "rotation-capitalization",
    purpose: "在稳态观察前通过公开收购把终端库存变现给责任猫",
    mode: "price-only",
    playerText: "制定一条临时纯价格法规：全部商品按各自基础价格8倍计价，仅供玩家在稳态观察开始前从两只责任猫各收购一件未预留自有库存并转售。源码只返回null，不得调整评分、信用、库存、订单或运输；交易完成后立即废止。",
    expectedPrices: [{ itemId: "*", multiplier: 8 }],
  },
  {
    id: "terminal-discipline-23-30",
    purpose: "约束第23—30项的非中央终端投机，让其他猫专注有偿原料订单",
    mode: "logistics",
    playerText: "制定一条终端投机约束法规：所有猫仍运行同一程序；坐标不是(0,0)的猫将wheel、fuel、coolant、antenna、machine_tool、chip、memory、display的自愿制作评分压为负，但不禁止这些商品的原料制作、订单和合同运输。最后调用choose()，不得注入商品、金币、信用、订单或建筑。",
    requiredSourceTerms: ["adjust", "choose"],
  },
  {
    id: "stable-rotation-23-30",
    purpose: "在首次完成第30项后由两个工位并行轮换第23—30项",
    mode: "logistics",
    playerText: "制定一条稳态轮换法规：所有猫运行同一程序，使用所有固定种子都有的公开坐标，把工厂两格内的(-1,-1)工位分配wheel/fuel/coolant/antenna，把(0,0)工位分配machine_tool/chip/memory/display。不要使用crafted，因为生产总量广播可能离开短期窗口；必须在两个坐标分支内分别把marketNeed(0)一直到marketNeed(29)存入局部常量，再按排名从0到29用if/else寻找最先出现且属于本组的商品，对该商品连续调用两次adjust（第一次multiplier为0、bonus为1000000，第二次multiplier为1、bonus为1000000），最后调用choose()。不得使用循环，不得注入物品、金币、订单、信用或建筑。",
    requiredSourceTerms: ["at(-1, -1)", "at(0, 0)", "marketNeed", "adjust", "choose"],
  },
  {
    id: "logistics-22-30",
    purpose: "使用订单、悬赏、补料与留存评分突破第22—30项",
    mode: "logistics",
    // These coordination-heavy outputs can fall below the mandatory non-loss
    // gate at 2x once their real ingredient opportunity costs are included.
    // A bounded 4x premium keeps the rotating terminal jobs voluntary; unlike
    // the failed price-only controls, the same law must still coordinate paid
    // orders and physical contracts.
    expectedPrices: ITEMS_22_TO_30.slice(1).map((itemId) => ({
      itemId,
      multiplier: itemId === "display"
        ? 2.1
        : ["fuel", "coolant"].includes(itemId) ? 3 : 2,
    })),
    playerText: "制定一条22—30物流协调法规。先依次setPrice：wheel 2、fuel 3、coolant 3、antenna 2、machine_tool 2、chip 2、memory 2、display 2.1。若ctx.carrying非空，立即返回其pass动作。chip、memory、display任一悬赏开放时，读取ownPlan的outputItemId和reason：对全部craft连续施加三次-1000000；订单计划对自身商品连续加四次1000000；非订单旧计划若是paper则把brick加1000000，否则把paper加1000000，使旧投机被更高但仍为负的候选替换且不建立新计划；display开放时坐标(-1,-1)对display连续加八次1000000，否则坐标(0,0)按开放悬赏对chip或memory连续加八次1000000，然后return choose()。其他阶段：有任何订单时提高pass；有chip订单时强推chip；(-1,-1)按wheel、fuel、coolant、antenna尚未领取的悬赏顺序只推第一项，(0,0)按machine_tool、chip、memory、display顺序只推第一项，最后choose()。不得使用循环；总源码必须处于4096个AST节点与64层深度以内。不得注入商品或金币，不得改信用，不得绕过配方、场地、合同和非亏损校验，不得sell。",
    requiredSourceTerms: ["ctx.carrying", "adjust", "orderCount", "bounty", "choose"],
  },
  {
    id: "advanced-31-35",
    purpose: "在正常部署工厂、机床和天线后协调第31—35项高级制造",
    mode: "advanced",
    playerText: "制定一条第31—35项高级制造与稳态轮换法规。ctx.carrying非空时先返回对应pass。controller/radio/robot/fabricator/vehicle任一悬赏开放时，像物流法一样连续三次压低全部craft，连续四次保留order计划，使用paper/brick高于旧计划但仍为负的候选清退非订单投机；在(-1,-1)依次装配controller/fabricator，在(0,0)装配radio/robot/vehicle，对当前开放悬赏的目标连续加八次1000000，然后choose。全部悬赏关闭后，在函数中只声明一次marketNeed(0)到marketNeed(34)，将(0,0)组设为factory/machine_tool/chip/memory/display/radio/robot/vehicle，(-1,-1)组设为wheel/fuel/coolant/antenna/controller/fabricator；先把本坐标组全部候选压到-1000000，再按0到34的排名用单一if/else链找到最先属于当前坐标组的商品，连续调用两次adjust（0,+1000000后1,+1000000），最后choose。有订单时提高pass。不得使用循环；源码必须低于4096个AST节点、24576字节和64层深度。不得注入商品、金币或建筑，不得绕过工厂/机床/天线场地、信用、配方或合同，不得sell。",
    requiredSourceTerms: ["ctx.carrying", "adjust", "orderCount", "bounty", "marketNeed", "at(0, 0)", "at(-1, -1)", "choose"],
  },
];

const logisticsEntry = DEEPSEEK_ACCEPTANCE_CASES.find((candidate) => candidate.id === "logistics-22-30");
if (logisticsEntry) logisticsEntry.playerText = `${logisticsEntry.playerText}${RESOURCE_CLEARING_INSTRUCTION}`;

const stableWorkstationInstruction = "最终稳态必须保留reason为order的ownPlan并连续四次提高该商品；只清退专用装配工位上不属于其分组的旧非订单计划。所有y<0且不是(1,-1)或(-1,-1)的工位轮换wheel/fuel；所有y>=0且不是(0,0)、(1,1)、(-1,0)的工位轮换coolant/antenna；(0,0)轮换machine_tool/chip；(-1,-1)轮换memory/display；(1,-1)持续factory；(1,1)持续magnet；若存在(-1,0)则持续metal。对前30供应链中存在真实订单的基础品和中间品各追加一次3000000履约评分。木资源工位按最近60秒的fire、两倍plank及paper产量补齐wood并保留一个离散批次；水资源工位按brick、paper、battery、chemical及两倍coolant产量补齐water并保留一个离散批次；矿资源工位按lamp、两倍antenna及chip产量补齐cable并保留一个离散批次。recentCrafted('chassis')小于1时补料。marketNeed(0)到marketNeed(29)只声明一次并由各分支共享。只提高真实候选评分，不得创建物品或订单。";
const advancedSupplyInstruction = "高级稳态仍须保留reason为order的ownPlan。最终分组覆盖前文旧分组：(0,0)只包含machine_tool/chip/radio/robot/vehicle，(-1,-1)只包含memory/display/controller/fabricator；按marketNeed选中后先adjust(0,1000000)再adjust(1,2000000)，使高级目标高于既有二层稳态分数。对water、fiber、ore、gear、battery、lamp的真实订单追加一次900000履约评分，并在recentCrafted('chassis')小于1时补料，不得反向压制既有前30项稳态法规。";
const materialFlowInstruction = "补充同一法规中的60秒流量守恒：对前30项中会被继续消耗的每种原料，按recentCrafted读取直接下游商品最近60秒完成量并乘配方数量。只在需求大于0且不低于该原料同期产量时，在对应资源工位连续两次adjust('craft', item, 1, 1000000)。必须至少覆盖wood=fire+2*plank+paper、stone=2*brick+tools、sand=2*glass+chip、water=brick+paper+battery+chemical+2*coolant、fiber=2*thread+chemical、ore=2*metal，以及fire、plank、brick、thread、tools、glass、metal、gear、cable、battery、chemical、chassis、lamp、chip的直接下游消耗。不得创建商品、订单、信用或合同。";
DEEPSEEK_ACCEPTANCE_CASES.push({
  id: "flow-balance-1-30",
  purpose: "首次完成第30项后维持前30项直接物料流量守恒",
  mode: "logistics",
  playerText: materialFlowInstruction,
  requiredSourceTerms: ["recentCrafted", "ctx.site", "at(-1, 0)", "at(1, 0)", "adjust", "choose"],
});
const flowEntry = DEEPSEEK_ACCEPTANCE_CASES.find((candidate) => candidate.id === "flow-balance-1-30");
if (flowEntry) flowEntry.playerText = `${flowEntry.playerText}最终条件使用严格反馈：只有最近60秒下游需求量真正大于该原料同期产量时才补产，需求等于产量时不额外建立安全库存。基础资源只在ctx.site.resourceItemId等于该资源时补产并保持两层评分；中间品只分配给地图朝向无关的两座供应锚点：第一组(-1,0)或(0,-1)，第二组(1,0)或(0,1)。一般中间品使用两层评分，只有已观测到净流出的metal、chemical、chip使用三层评分；chip也由第二供应锚点补产。不得让其余终端轮换工位执行流量补产。`;
const stableEntry = DEEPSEEK_ACCEPTANCE_CASES.find((candidate) => candidate.id === "stable-rotation-23-30");
if (stableEntry) stableEntry.playerText = `${stableEntry.playerText}${stableWorkstationInstruction}`;
if (stableEntry) stableEntry.playerText = `${stableEntry.playerText}最终显式终端分工覆盖旧的marketNeed轮换：上半区非供应锚点按x<0固定wheel、x>0固定fuel；下半区非供应锚点按x<0固定coolant、x>0固定antenna，各连续两次adjust。这样两只冷却剂猫可吸收其中一只承担运输合同的占用。`;
if (stableEntry) stableEntry.playerText = `${stableEntry.playerText}下半区最终改为一只固定加一只补缺：(-1,1)固定coolant，x>0固定antenna，剩余第三只比较recentCrafted('coolant')和recentCrafted('antenna')并补较少者，各连续两次adjust。`;
if (flowEntry) {
  flowEntry.playerText = "首次完成第30项后制定一条七项边界原料守恒法规。只用recentCrafted的最近60秒全局制作广播：木资源工位令wood追踪fire+2*plank+paper、plank追踪tools+chassis、fire追踪glass+metal+fuel；水资源工位令water追踪brick+paper+battery+chemical+2*coolant；纤维资源工位令fiber追踪2*thread+chemical；矿资源工位以及存在时的(-1,0)/(0,-1)工位令metal追踪2*gear+cable+battery+chassis+magnet+coolant+antenna+machine_tool+memory，令cable追踪lamp+2*antenna+chip。各多保留一个离散批次。普通流量项的bonus为(需求+1-recentCrafted(本项))*900000，避免抢占终端责任工位；只有单独说明的ore上游缺口使用3000000。最后choose。不得调整价格、税、信用或悬赏，不得创建物品、订单或合同。";
  flowEntry.requiredSourceTerms = ["recentCrafted", "onResource", "at(-1, 0)", "adjust", "choose"];
}
if (stableEntry) stableEntry.playerText = "首次完成第30项后制定稳态轮换法规。保留reason为order的ownPlan并连续四次提高自身商品；对前30供应链存在真实订单的基础品和中间品追加3000000履约评分。只声明一次marketNeed(0)到marketNeed(29)：所有y<0且不是(1,-1)/(-1,-1)的工位按排名轮换wheel/fuel；所有y>=0且不是(0,0)/(1,1)/(-1,0)的工位按排名轮换coolant/antenna；(0,0)轮换machine_tool/chip；(-1,-1)轮换memory/display；(1,-1)持续factory；(1,1)持续magnet；若(-1,0)存在则持续metal。专用装配工位只清退不属于本组的旧非订单计划。recentCrafted('chassis')小于1时补料，最后choose。不得创建物品、订单或合同。";
if (stableEntry) stableEntry.playerText = `${stableEntry.playerText}严格稳态观察还要求第20项factory跨窗口重复生产：保持(1,-1)为factory专用装配位，(0,0)只轮换machine_tool/chip并不保留factory旧计划，避免factory的60秒反馈抢占machine_tool。`;
if (stableEntry) stableEntry.playerText = `${stableEntry.playerText}若recentCrafted("factory")小于1，只在factory专用的(1,-1)连续四次追加1000000；不得在(0,0)追加factory。`;
if (stableEntry) stableEntry.playerText = `${stableEntry.playerText}把第二供应锚点(1,0)或横向地图的(0,1)从coolant/antenna终端轮换组排除，该锚点只保留glass旧计划并对glass连续两层1000000；其余下半区工位继续承担coolant/antenna。`;
if (flowEntry) flowEntry.playerText = `${flowEntry.playerText}补齐第20项工厂的直接BOM流量：stone资源位令brick追逐2*factory、tools追逐factory+machine_tool；sand资源位令glass追逐factory+lamp+display；ore资源位令gear追逐factory+wheel+machine_tool。每式保留1个离散批次。玩家若公开收购一件plank留在仓库，则warehouseCount('plank')是玩家颁布的最低库存数：每个wood资源猫在count('plank')低于该数时为plank追加3000000。仓库购入品不进入猫库存，不计入自主产量。`;
if (flowEntry) flowEntry.playerText = `${flowEntry.playerText}只补齐已观测的最上游矿石守恒：仅在onResource('ore')时令ore需求等于2*recentCrafted('metal')，系数2来自metal配方。玩家公开收购两件ore留在仓库，因为一批metal恰好需要2 ore；用warehouseCount('ore')作为每ore资源猫的count('ore')最低库存，低于该数时追加3000000。不要为stone或sand增加高优先级上游调度；购入品仍不进入猫库存或自主产量。`;
if (flowEntry) flowEntry.playerText = `${flowEntry.playerText}将仓库下限同时写入流量目标：plank的目标为plankDemand+1+warehouseCount('plank')，ore的目标为oreDemand+1+warehouseCount('ore')。其中1是离散批次边界，warehouseCount是玩家实际收购的公开下限，不得用固定2替代这两项的代数和。`;
if (flowEntry) flowEntry.playerText = `${flowEntry.playerText}严格分离矿区采集与中间品加工：onResource('ore')分支只调整ore，不得在该分支调整metal/cable/gear；metal/cable/gear只在供应锚点(-1,0)或横向地图的(0,-1)调整。这避免同一资源猫在采矿与加工之间分时。`;
if (flowEntry) flowEntry.playerText = `${flowEntry.playerText}对沙区使用同样的空间分工：onResource('sand')只按2*recentCrafted('glass')+recentCrafted('chip')追加sand，不在沙区直接调整glass；glass只在第二供应锚点(1,0)或横向地图的(0,1)按factory+lamp+display流量调整。`;
if (flowEntry) flowEntry.playerText = `${flowEntry.playerText}供应锚点的metal目标为metalDemand+2-recentCrafted('metal')，边界批次为2的依据是一批gear直接消耗2件metal。不要为metal另外收购仓库品，避免改变最终法颁布前的市场相位。`;
if (flowEntry) flowEntry.playerText = `${flowEntry.playerText}fire的流量目标使用fireDemand+2-recentCrafted('fire')；两批边界储备对应每只猫最多两个未完成运输段的最大并发合同负担。不调整其他流量项。`;
if (flowEntry) flowEntry.playerText = `${flowEntry.playerText}cable的流量目标使用cableDemand+1-recentCrafted('cable')，只保留一个离散边界批次。其他流量项不变。`;
if (stableEntry) stableEntry.playerText = `${stableEntry.playerText}最终终端分工不得再调用marketNeed：上半区专用工位按x<0固定wheel、否则固定fuel；下半区(-1,1)固定lamp，其余x<0固定coolant、否则固定antenna。五类各先用multiplier 0重置再连续三次追加1000000，并清退专用工位上不属于本组的旧非订单计划。reason为order的计划仍按前述四层评分优先。`;
if (flowEntry) flowEntry.playerText = `${flowEntry.playerText}玩家若分别公开收购一件water和一件fire留在仓库，则warehouseCount('water')与warehouseCount('fire')也是对应资源猫的最低库存信号：分别加入waterDemand+1与fireDemand+2的目标，并在本猫对应库存低于仓库数量时追加3000000。购入品不进入猫库存，也不得计入自主制作。`;
if (flowEntry) flowEntry.playerText = `${flowEntry.playerText}最终公开库存信号为water两件、fire一件、metal一件；water的2来自一批coolant直接消耗2件water。把warehouseCount('metal')也加入metalDemand+2的目标，并在供应锚点metal库存低于该真实仓库数时追加3000000。所有仓库品仍不得进入猫库存或自主产量。`;
if (stableEntry) stableEntry.playerText = `${stableEntry.playerText}为消除共享轮换的相位空窗，(-1,-1)最终固定memory并用一层重置加三层追加；(0,0)在recentCrafted('display')小于1时先以同样四层补display，否则才在machine_tool/chip间轮换；(1,1)的magnet也提升为四层。第二供应锚点在recentCrafted('antenna')小于1时四层补antenna，否则两层维持glass。不得改变仓库下限或价格。`;
if (stableEntry) stableEntry.playerText = `${stableEntry.playerText}(0,0)最终使用明确三段轮转而非marketNeed：recentCrafted('machine_tool')小于1时四层补machine_tool，否则recentCrafted('display')小于1时四层补display，否则四层补chip。这个顺序必须覆盖前一句中央分工，避免display零脉冲饿死machine_tool。`;
if (flowEntry) flowEntry.playerText = `${flowEntry.playerText}为antenna一批直接消耗2件cable，玩家再公开收购两件cable留仓；把真实warehouseCount('cable')加入cableDemand+1，并在供应锚点cable库存低于该数时追加3000000。不得把仓库cable作为猫库存或自主产量。`;
if (stableEntry) stableEntry.playerText = `${stableEntry.playerText}(-1,-1)最终不再纯做memory，并优先消除display空窗：recentCrafted('display')小于1时先压低非订单memory旧计划再四层补display，否则recentCrafted('memory')小于1时先压低非订单display旧计划再四层补memory，否则四层补display；两者都属于该专岗允许组，订单计划不可取消。中央display脉冲保持不变，以形成第二个显示器装配通道。`;
if (stableEntry) stableEntry.playerText = `${stableEntry.playerText}display的外部直接BOM底仓只来自两项公开交易：warehouseCount('glass')=1、warehouseCount('lamp')=1；chip不要求玩家收购，因为完成第30项后其现货可能全部被生产计划预留。(0,0)压低chip外售，并在本地count('chip')小于1时优先四层补chip，随后才执行machine_tool/display/chip周期。第二供应锚点在本地glass低于真实仓库数时四层补glass并压低外售；(-1,1)持续四层补lamp并压低外售。`;
if (stableEntry) stableEntry.playerText = `${stableEntry.playerText}避免(-1,-1)专用装配猫在memory/display短暂缺料时签入无关的长期原料订单：前30供应链的通用orderCount三百万履约加分不作用于该坐标；已有reason为order的合同仍按开头四层规则不可撤销。该猫在目标暂不可融资时，把ctx.site.resourceItemId作为四层可行等待工作，memory/display目标则各用六层，目标一旦可融资就严格高于等待工作。不得拒绝或取消已经签入的合同。`;
if (stableEntry) stableEntry.playerText = `${stableEntry.playerText}同样避免(0,0)中心芯片猫在chip/machine_tool短暂缺料时签入gear等无关长期订单：通用orderCount三百万履约加分也不作用于(0,0)，但已有订单合同仍不可撤销。中心为paper、brick、thread各设置两层简单等待候选，chip/machine_tool/display仍保持四层，因而目标可融资时必定高于等待候选；等待候选又高于未加分的无关订单。`;
if (flowEntry) flowEntry.playerText = `${flowEntry.playerText}把真实warehouseCount('glass')加入glassDemand+1，并在第二供应锚点glass库存低于该数时追加3000000；该仓库品不进入猫库存或自主产量。`;
const advancedEntry = DEEPSEEK_ACCEPTANCE_CASES.find((candidate) => candidate.id === "advanced-31-35");
if (advancedEntry) advancedEntry.playerText = `${advancedEntry.playerText}${advancedSupplyInstruction}`;

export function priceCalls(draft: LawDraft): Array<{ itemId: string; multiplier: number }> {
  return [...draft.sourceCode.matchAll(/\bsetPrice\s*\(\s*["']([^"']+)["']\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g)]
    .map((match) => ({ itemId: match[1], multiplier: Number(match[2]) }));
}

export function validateAcceptanceDraft(testCase: DeepSeekAcceptanceCase, draft: LawDraft): string[] {
  const failures: string[] = [];
  if (!draft.validation.syntax || !draft.validation.safety) failures.push("统一语法/安全校验未通过");
  if (draft.validation.examplesPassed !== draft.validation.examplesTotal || draft.validation.examplesTotal < 1) {
    failures.push(`固定/随机样例未全部通过：${draft.validation.examplesPassed}/${draft.validation.examplesTotal}`);
  }
  if (!draft.sourceCode.trim() || !draft.astHash) failures.push("源码或AST哈希为空");
  const capabilities = new Set(decisionCapabilities(draft.sourceCode));
  if (testCase.mode === "price-only" || testCase.mode === "price-balancing") {
    if (testCase.mode === "price-balancing") {
      if (!capabilities.has("score-adjustment")) failures.push("价格优化法规缺少评分调整能力");
      for (const term of testCase.requiredSourceTerms ?? []) if (!draft.sourceCode.includes(term)) failures.push(`源码缺少 ${term}`);
      if (/\btype\s*:\s*["'](?:craft|pass|sell)["']/.test(draft.sourceCode)) failures.push("价格优化法规包含直接动作");
      if (/\b(?:setTax|setCredit|setBounty)\s*\(/.test(draft.sourceCode)) failures.push("价格优化法规包含价格/评分以外能力");
    }
    if (testCase.mode === "price-only" && /\b(?:adjust|choose|weighted|earnCoins)\s*\(|\btype\s*:\s*["'](?:craft|pass|sell)["']/.test(draft.sourceCode)) {
      failures.push("纯价格法规包含动作、评分或选择器能力");
    }
    if (testCase.mode === "price-only" && /\b(?:setTax|setCredit|setBounty)\s*\(/.test(draft.sourceCode)) failures.push("纯价格法规包含非价格经济能力");
    const actual = priceCalls(draft);
    for (const expected of testCase.expectedPrices ?? []) {
      if (!actual.some((effect) => effect.itemId === expected.itemId && effect.multiplier === expected.multiplier)) {
        failures.push(`缺少价格效果 ${expected.itemId}×${expected.multiplier}`);
      }
    }
  } else {
    if (!capabilities.has("direct-action") && !capabilities.has("score-adjustment") && !capabilities.has("selector")) failures.push("物流/高级法规缺少行为能力");
    for (const term of testCase.requiredSourceTerms ?? []) if (!draft.sourceCode.includes(term)) failures.push(`源码缺少 ${term}`);
    if (/\btype\s*:\s*["']sell["']/.test(draft.sourceCode)) failures.push("法规包含被禁止的sell动作");
    if (/\b(?:setCredit|setBounty)\s*\(/.test(draft.sourceCode)) {
      failures.push("物流法规试图修改信用或悬赏资金");
    }
  }
  return failures;
}
