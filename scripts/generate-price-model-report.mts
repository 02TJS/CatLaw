import { readFile, writeFile } from "node:fs/promises";
import { CATALOG_ANALYSIS, ITEMS } from "../src/game/catalog";

type ReferenceModel = {
  runs: number;
  stage10Passes: number;
  blueprintPasses: number;
  stage15Passes: number;
  blueprintTotalCents: number;
  stargatePriceCents: number;
  failureReasons: Record<string, number>;
  unstableItems: Record<string, number>;
  meanEndingDebtCents: number;
  pricesCents: Record<string, number>;
};

type ModelSummary = {
  generatedAt: string;
  host: {
    alias: string;
    hostname: string;
    cpuThreads: number;
    memoryGiB: number;
    gpus: Array<{ name: string; memoryMiB: number; count: number }>;
    node: string;
    python: string;
    executionChoice: string;
  };
  simulation: Record<string, unknown> & { totalScenarioRuns: number };
  currentBaseline: {
    runs: number;
    stage10Passes: number;
    blueprintPasses: number;
    stage15Passes: number;
    failureReasons: Record<string, number>;
    unstableItems: Record<string, number>;
    procurementShare: { mean: number; median: number; p90: number; p95: number };
    financedShare: { mean: number; median: number; p90: number; p95: number };
    routeEdges: { meanOfMeans: number; medianOfMeans: number; p95OfSeedP95: number };
    endingDebtCents: { mean: number; p95: number };
    blueprintTotalCents: number;
    stargatePriceCents: number;
  };
  referenceModels: Record<string, ReferenceModel>;
  grid: Array<Record<string, number | string>>;
  fundedGrid: Array<Record<string, number | string>>;
};

const inputPath = process.argv.find((argument) => argument.startsWith("--input="))?.slice(8)
  ?? "output/price-model-summary.json";
const outputPath = process.argv.find((argument) => argument.startsWith("--output="))?.slice(9)
  ?? "CatWorkshop-Price-Model-Report.html";
const summary = JSON.parse(await readFile(inputPath, "utf8")) as ModelSummary;

const itemNames: Record<string, string> = {
  wood: "木材", stone: "石料", sand: "沙", water: "水", fiber: "纤维", ore: "矿石",
  fire: "炉火", plank: "木板", brick: "砖", thread: "线", paper: "纸", tools: "工具", glass: "玻璃",
  metal: "金属", gear: "齿轮", cable: "线缆", battery: "电池", chemical: "化学品", chassis: "底盘", factory: "工厂",
  lamp: "灯", magnet: "磁铁", wheel: "车轮", fuel: "燃料", coolant: "冷却剂", antenna: "天线", machine_tool: "机床",
  chip: "芯片", memory: "存储器", display: "显示器", controller: "控制器", radio: "无线电", robot: "机器人",
  fabricator: "制造机", vehicle: "车辆", computer: "计算机", server: "服务器", network: "网络", ai_core: "AI 核心",
  lab: "实验室", atom_core: "原子核心", reactor: "反应堆", solar_array: "太阳能阵列", telescope: "望远镜",
  rocket: "火箭", satellite: "卫星", life_support: "生命维持", lunar_base: "月球基地", star_map: "星图",
  starship: "星际飞船", superconductor: "超导体", quantum_field: "量子场", quantum_sensor: "量子传感器",
  spacetime_clock: "时空钟", quantum_computer: "量子计算机", spacetime_map: "时空图", singularity: "奇点",
  gate_key: "星门密钥", gate_ring: "门环", stabilizer: "稳定器", exotic_crystal: "奇异晶体",
  address_core: "坐标核心", containment: "约束场", energy_matrix: "能量矩阵", stargate: "星门",
};

const money = (cents: number) => (cents / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
const ratio = (numerator: number, denominator: number) => `${numerator}/${denominator} (${percent(numerator / denominator)})`;
const currentPrices = Object.fromEntries(ITEMS.map((item) => [item.id, CATALOG_ANALYSIS.basePrices[item.id] * 100]));
const economic = summary.referenceModels.embodiedWorkValue;
const selector = summary.referenceModels.clean;
const compatible = summary.referenceModels.compatible;
const transition = summary.referenceModels.transition;

function referenceRow(label: string, description: string, model: ReferenceModel | null, current = false): string {
  const data = current ? summary.currentBaseline : model!;
  return `<tr>
    <th>${label}<small>${description}</small></th>
    <td>${ratio(data.stage10Passes, data.runs)}</td>
    <td>${ratio(data.stage15Passes, data.runs)}</td>
    <td>${money(data.blueprintTotalCents)}</td>
    <td>${money(data.stargatePriceCents)}</td>
    <td>${money(current ? summary.currentBaseline.endingDebtCents.mean : model!.meanEndingDebtCents)}</td>
  </tr>`;
}

const priceRows = ITEMS.map((item, index) => {
  const id = item.id;
  const work = CATALOG_ANALYSIS.workUnits[id];
  const current = currentPrices[id];
  const fair = economic.pricesCents[id];
  const delta = current - fair;
  return `<tr>
    <td>${index + 1}</td>
    <th><code>${id}</code><span>${itemNames[id]}</span></th>
    <td>${item.tier}</td>
    <td>${work.toLocaleString("zh-CN")}</td>
    <td class="recommended">${money(fair)}</td>
    <td>${money(current)}</td>
    <td class="${delta > 0 ? "up" : delta < 0 ? "down" : ""}">${delta > 0 ? "+" : ""}${money(delta)}</td>
    <td>${money(selector.pricesCents[id])}</td>
    <td>${money(compatible.pricesCents[id])}</td>
    <td>${money(transition.pricesCents[id])}</td>
  </tr>`;
}).join("\n");

const unstableRows = Object.entries(summary.currentBaseline.unstableItems)
  .sort((left, right) => right[1] - left[1])
  .map(([id, count]) => `<tr><th>${itemNames[id] ?? id} <code>${id}</code></th><td>${count}</td><td>${percent(count / summary.currentBaseline.runs)}</td></tr>`)
  .join("\n");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>猫咪工坊基础价格数学模型与并行模拟报告</title>
<style>
:root{--ink:#202421;--muted:#606862;--line:#d9ded9;--paper:#fff;--soft:#f4f6f4;--green:#176a43;--green-soft:#e8f4ed;--red:#a43a32;--blue:#315a84;--gold:#8b6417}
*{box-sizing:border-box} body{margin:0;background:#eef1ee;color:var(--ink);font:15px/1.72 "Segoe UI","Microsoft YaHei",sans-serif}
main{width:min(1240px,calc(100% - 32px));margin:24px auto 72px;background:var(--paper);border:1px solid var(--line);box-shadow:0 14px 42px #1d2a2120}
header{padding:48px 54px 36px;border-bottom:1px solid var(--line);background:linear-gradient(135deg,#fff 0,#f4f8f5 100%)}
h1{font-size:34px;line-height:1.22;margin:0 0 14px;letter-spacing:-.02em} h2{font-size:23px;margin:0 0 14px} h3{font-size:18px;margin:26px 0 10px}
p{margin:9px 0} section{padding:34px 54px;border-bottom:1px solid var(--line)}
.eyebrow{color:var(--green);font-weight:700;letter-spacing:.08em}.lede{font-size:18px;max-width:920px;color:#3c443e}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:22px 0}.card{background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:15px}.card b{display:block;font-size:22px}.card span{color:var(--muted);font-size:13px}
.verdict{border-left:5px solid var(--green);background:var(--green-soft);padding:17px 20px;margin:18px 0}.warning{border-left-color:var(--gold);background:#fbf5e8}.danger{border-left-color:var(--red);background:#faecea}
.formula{font:16px/1.7 Consolas,"Segoe UI",monospace;background:#f5f7f5;border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:12px 0;overflow:auto}
ol.steps{padding-left:22px}.steps li{margin:13px 0}.steps strong{color:#183f2c}
.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:8px;margin:16px 0}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:9px 11px;border-bottom:1px solid #e4e8e4;text-align:right;white-space:nowrap}thead th{position:sticky;top:0;background:#edf2ee;z-index:1;color:#364039}tbody th{text-align:left}tbody th small{display:block;font-weight:400;color:var(--muted)}tbody th span{display:block;color:var(--muted);font-weight:400}code{font-family:Consolas,monospace;font-size:12px}td.recommended{background:#edf7f1;color:var(--green);font-weight:700}.up{color:var(--red)}.down{color:var(--blue)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:22px}.note{color:var(--muted);font-size:13px}.tag{display:inline-block;border:1px solid #b8c7bc;border-radius:99px;padding:2px 9px;margin:2px;color:#31523c;background:#f4faf6}
footer{padding:25px 54px;color:var(--muted);font-size:13px}@media(max-width:850px){header,section,footer{padding-left:24px;padding-right:24px}.cards,.two{grid-template-columns:1fr 1fr}}@media(max-width:560px){.cards,.two{grid-template-columns:1fr}main{width:100%;margin:0;border:0}h1{font-size:28px}}
@media print{body{background:#fff}main{margin:0;width:100%;box-shadow:none}.table-wrap{overflow:visible}thead th{position:static}}
</style>
</head>
<body><main>
<header>
  <div class="eyebrow">CAT WORKSHOP · PRICE MODEL · 2026-08-04</div>
  <h1>猫咪工坊基础价格数学模型与并行模拟报告</h1>
  <p class="lede">结论先行：<strong>基础价格应表示商品在工厂门口的内含生产工作量，令 1 次五秒动作值 1 金币，则第 i 项基础价就是 W<sub>i</sub> 金币。</strong>运输、借贷和建筑区位是订单自身的增量成本，应在成交时结算；它们不应以固定百分比永久烙进商品目录。现有 12% 原料加价没有可识别的经济依据。</p>
  <div class="cards">
    <div class="card"><b>${summary.simulation.totalScenarioRuns.toLocaleString("zh-CN")}</b><span>5090_Lian 确定性场景运行</span></div>
    <div class="card"><b>1,000 / 1,000</b><span>内含工作量价：初始 10 项</span></div>
    <div class="card"><b>${economic.stage15Passes} / 1,000</b><span>内含工作量价：购图纸后 15 项</span></div>
    <div class="card"><b>${money(economic.stargatePriceCents)}</b><span>建议星门基础价（金币）</span></div>
  </div>
  <div class="verdict"><strong>推荐：</strong>把 <code>basePrice(item)</code> 定义为 <code>workUnits(item)</code>。如果暂时不改当前评分器，不应伪称另一个高价表是“成本价”；它只能叫行为补贴价。上线前必须把价格与七条法规的控制增益一起重标定。</div>
</header>

<section id="definitions">
  <h2>1. 先分清三个概念</h2>
  <div class="two">
    <div><h3>基础价值 V</h3><p>制造地点交货、不含运输和融资的可重复生产成本。它回答“这件东西凝结了多少五秒动作”。本报告推荐它成为目录基础价。</p></div>
    <div><h3>到货价 D</h3><p>某一笔真实订单的基础价值，加实际路线、实际借款和可验证的临时风险。它随合同变化，不能写死在目录。</p></div>
    <div><h3>行为激励价 P</h3><p>为了抵消当前评分器的全链负担分母或推动关卡而人为提高的信号。它是控制器参数，不是商品成本。</p></div>
    <div><h3>玩家零售价 R</h3><p>仓库出售给外部市场的价格。零售倍率用于财政节奏和金币回收，可与基础价值分开设计。</p></div>
  </div>
  <p class="note">当前实现把 V、D、P 混在同一个 <code>basePrices</code> 中，因此“调价格”同时改变净资产、信用、订单报价、悬赏、图纸费和行为排序，任何单一百分比都必然承担互相冲突的职责。</p>
</section>

<section id="derivation">
  <h2>2. 从零开始推导合理基础价</h2>
  <ol class="steps">
    <li><strong>先固定计价单位，而不是假装绝对价格能从数学中凭空出现。</strong>只有相对价格可识别。现有六种基础资源目录价都是 1 金币，所以继续把“一次五秒采集动作”的毛价值定义为 1 金币。这是货币尺子的定义，不是经验参数。</li>
    <li><strong>税率不创造加工价值。</strong>现行销售税 τ=50%。基础资源一次动作税后得到 0.5 金币，因此净动作工资 w<sub>net</sub>=(1−0.5)×1=0.5 金币。若原料与成品使用同一税率，比较机会成本时 (1−τ) 同时乘在两边并抵消。</li>
    <li><strong>竞争性生产的零超额利润条件。</strong>一件成品消耗原料 q<sub>ij</sub> 和一次新的制作动作。于是：</li>
  </ol>
  <div class="formula">Vᵢ = Σⱼ qᵢⱼ · Vⱼ + 1<br>基础资源：Vᵣ = 1</div>
  <p>按配方拓扑归纳，上式恰好等于内含工作量：</p>
  <div class="formula">Wᵣ = 1；Wᵢ = 1 + Σⱼ qᵢⱼ · Wⱼ；因此 Vᵢ = Wᵢ（金钱单位：金币）</div>
  <ol class="steps" start="4">
    <li><strong>利润不是“原料越贵就自动抽成越多”。</strong>每一级已经为新增的一次动作增加 1 金币。再对全部原料乘 12%，会重复对祖先节点收取复利，无法对应任何新增动作。</li>
    <li><strong>运输按实际跳数结算。</strong>内部交易免税，而一次采集动作的税后替代收益是 0.5 金币，所以承运一跳的机会成本是 0.5 金币。若卖家只需比外售多得到最小货币单位 1 分，则一件物品走 h 跳的内部到货现金成本应为 <code>D=0.5V+0.01+0.5h</code>。平均路线不能写入 V，否则零跳生产者获得横财、六跳生产者仍可能亏损。</li>
    <li><strong>融资按真实借款结算。</strong>当前贷款费率是 2%，所以某订单实际借入 B 分时，融资费就是 <code>ceil(0.02B)</code> 分。没有借款的商品不应预付融资补贴。</li>
    <li><strong>永久建筑当前没有可推导的单位折旧。</strong>建筑无限寿命、无维护、可无限复用，长期边际折旧趋近 0。建筑价格可以形成一次性资本支出或区位租金，但在没有使用寿命 N 前不能伪造 <code>C/N</code>。</li>
    <li><strong>确定性世界没有外生报废风险。</strong>合同堵塞来自路径、承运能力和控制逻辑，不是商品随机消失。用商品基础价补偿软件控制失配会把故障永久资本化，因此基础风险加成为 0。</li>
  </ol>
</section>

<section id="twelve">
  <h2>3. 为什么 12% 不能成立</h2>
  <div class="verdict danger"><strong>12% 不是从税、利息、运输、建筑或稳定性目标推出来的。</strong>它只是旧实现中的递归下限：<code>ceil(原料目录价×1.12)+1</code>。由于每一层都再次作用于祖先原料，它会随依赖深度复利。</div>
  <div class="two">
    <div><h3>不是贷款成本</h3><p>实测前 15 项合同额的平均融资比例是 ${percent(summary.currentBaseline.financedShare.mean)}；乘 2% 贷款费，只相当于合同额约 <strong>${percent(summary.currentBaseline.financedShare.mean * 0.02)}</strong>，不是 12%。95 分位融资比例 ${percent(summary.currentBaseline.financedShare.p95)} 也只对应 ${percent(summary.currentBaseline.financedShare.p95 * 0.02)}。</p></div>
    <div><h3>不是运输成本</h3><p>平均路线 ${summary.currentBaseline.routeEdges.meanOfMeans.toFixed(3)} 跳，种子内 95 分位的再取 95 分位是 ${summary.currentBaseline.routeEdges.p95OfSeedP95} 跳。运输是“每件、每路线”的加法成本，不是原料总价的固定百分比。</p></div>
    <div><h3>不是税收补偿</h3><p>同一 50% 税率在成品与原料的机会成本比较中抵消。若把 12% 说成税补偿，会重复计算税。</p></div>
    <div><h3>不是稳定性阈值</h3><p>90×2 个参数组合没有显示 12% 附近存在相变点；价格隔离实验最高只有 12/20，而现价 19/20。早期稳定主要来自木板、纸、工具与齿轮的特定相对价格和法规评分，而非统一百分比。</p></div>
  </div>
</section>

<section id="planner">
  <h2>4. 当前评分器为什么会要求另一张“激励价”</h2>
  <p>当前生产机会把整件商品的内含工作量 W<sub>i</sub> 放进最终组装猫的负担分母，即使原料劳动已经由上游完成并计价。若忽略实际采购和融资，为了让每种商品都达到基础资源的 50 分/工作单位收益率，必须满足：</p>
  <div class="formula">(1−τ)·(Pᵢ−ΣqPⱼ) − 15·max(0,Wᵢ−10) = 50·Wᵢ</div>
  <div class="formula">τ=0.5 ⇒ Pᵢ = ΣqPⱼ + Wᵢ + 0.30·max(0,Wᵢ−10)</div>
  <p>这里的 <strong>0.30 不是新拍出的比例</strong>，而是现有引擎的 15 分协调扣款除以基础资源的 50 分净动作工资：15/50=0.30。规划视野 10 也来自现有常量。它只能证明“如何中和当前代码”，不能反过来证明 15 分本身合理。</p>
  <div class="verdict warning"><strong>可识别性结论：</strong>本次 0–40% 协调系数扫描没有给出 15 分的经验依据；在前 15 项里，改变该系数主要只影响 W=11 的齿轮。若坚持每个数字必须有来源，应删除这项固定扣款，或等未来有真实随机失败后用观测损失率逐商品估计，而不是让价格替它背书。</div>
  <h3>价格之外还存在三处量纲不一致</h3>
  <ol>
    <li>卖家当前要求 <code>外售净值 + 100 分</code>。让内部成交严格优于外售只需要最小整数单位 <strong>1 分</strong>；多出的 99 分没有对应动作。</li>
    <li>承运费当前封顶 25 分，但一跳占用完整五秒动作，税后替代收益是 <strong>50 分</strong>。强制合同优先级掩盖了这项亏损，和“猫只做利己动作”冲突。</li>
    <li>机会评估另扣每缺一件原料 25 分采购摩擦，但广播与下单不占动作，真实运输费又在合同中单独支付。这 25 分目前既不是时间也不是现金，属于重复的影子成本。</li>
  </ol>
  <p>这三项解释了为什么单独替换基础价格不能自动得到完整稳定市场。它们必须与评分分母一起校正，否则只能继续把控制误差塞进高级商品价格。</p>
</section>

<section id="compute">
  <h2>5. 5090_Lian 并行计算方法与证据</h2>
  <div class="cards">
    <div class="card"><b>${summary.host.cpuThreads}</b><span>CPU 逻辑线程</span></div>
    <div class="card"><b>${summary.host.memoryGiB} GiB</b><span>系统内存</span></div>
    <div class="card"><b>${summary.host.gpus[0].count}× RTX 5090</b><span>GPU 可用但未强行使用</span></div>
    <div class="card"><b>96</b><span>主要并发进程数</span></div>
  </div>
  <p>离散事件模拟包含大量分支、Map/Set、对象状态和事件队列，GPU 的 SIMD 批处理优势很小；CPU 多进程能直接运行真实 TypeScript 引擎。因此选择 96 路 CPU 并行，而不是把模型改写成一个失真的 GPU 近似。</p>
  <p><span class="tag">主基线 1,000 种子</span><span class="tag">90 组参数×20 种子</span><span class="tag">图纸隔离 90×20</span><span class="tag">4 个参考模型×1,000</span><span class="tag">总计 ${summary.simulation.totalScenarioRuns.toLocaleString("zh-CN")}</span></p>
  <p>动作逻辑仍是 5,000ms；引擎用 5,000×确定性时钟推进，不等待真实五秒。每阶段先爬坡 5 分钟，再观察三个各 5 分钟窗口。价格压力判据要求每项目标至少 3 次、至少两个窗口出现、末窗仍有总产出、无连续两窗超过 50% 崩落、无长期信用冻结或运输合同。它用于价格比较，不冒充此前约定的完整 35 项库存覆盖验收。</p>
  <div class="table-wrap"><table id="reference-models">
    <thead><tr><th>价格体系</th><th>10 项</th><th>15 项</th><th>11–15 图纸</th><th>星门基础价</th><th>期末猫债务均值</th></tr></thead>
    <tbody>
      ${referenceRow("现行目录", "层级溢价 + 12% 递归下限 + 个别早期底价", null, true)}
      ${referenceRow("内含工作量价（推荐价值）", "V=W；运输与融资另结", economic)}
      ${referenceRow("评分平价价", "抵消 W 分母，不含固定协调扣款", selector)}
      ${referenceRow("引擎兼容激励价", "再抵消现有 15 分/超视野工作扣款", compatible)}
      ${referenceRow("过渡价", "1–15 保持现价；16–65 用兼容方程", transition)}
    </tbody>
  </table></div>
  <p>最重要的反事实是：内含工作量价在 1,000 种子上为 ${economic.stage15Passes}/1000，略高于现价 ${summary.currentBaseline.stage15Passes}/1000；所以 12% 复利不是前 15 项运行的必要条件。剩余失败集中在同一条矿石→金属→齿轮物流链，属于控制与承运瓶颈。</p>
  <div class="table-wrap"><table><thead><tr><th>现价下失稳物品</th><th>失败种子数</th><th>占 1,000 种子</th></tr></thead><tbody>${unstableRows}</tbody></table></div>
</section>

<section id="examples">
  <h2>6. 四个完整算例</h2>
  <h3>木材</h3><div class="formula">W(木材)=1 ⇒ V(木材)=1 金币</div>
  <h3>木板</h3><div class="formula">W(木板)=1+2·W(木材)=3<br>V(木板)=2·1+1=3 金币</div>
  <p>现价 11 金币不是生产成本；它是为了让木材工位持续为下游补板而留下的历史控制增益。</p>
  <h3>齿轮</h3><div class="formula">W(金属)=5；W(齿轮)=1+2·5=11<br>V(齿轮)=11 金币</div>
  <p>评分平价方程会给齿轮 31 金币，引擎兼容方程向上取整为 32 金币；现价反而只有 24 金币。1,000 种子对照表明，提高到 31/32 会吸住唯一矿石工位，金属合同更容易堵塞。这证明“激励价”必须由法规控制，而不应冒充成本。</p>
  <h3>星门</h3><div class="formula">W(星门)=28,078 ⇒ 建议基础价值=28,078 金币<br>现价=383,668 金币（为内含工作量的 ${(summary.currentBaseline.stargatePriceCents / economic.stargatePriceCents).toFixed(2)} 倍）<br>评分平价价=${money(selector.stargatePriceCents)}；引擎兼容激励价=${money(compatible.stargatePriceCents)}</div>
</section>

<section id="prices">
  <h2>7. 65 项完整价格表</h2>
  <p><strong>绿色列是推荐的经济基础价值。</strong>“评分平价”和“引擎兼容”仅供诊断当前选择器；“过渡价”是在暂不重调前 15 项法规时可用的兼容表，但不应对外宣称为成本价。</p>
  <div class="table-wrap"><table>
    <thead><tr><th>#</th><th>物品</th><th>层级</th><th>W</th><th>推荐 V=W</th><th>现价</th><th>现价−V</th><th>评分平价</th><th>引擎兼容</th><th>过渡价</th></tr></thead>
    <tbody>${priceRows}</tbody>
  </table></div>
</section>

<section id="decision">
  <h2>8. 最终决策与实施边界</h2>
  <div class="verdict"><strong>经济上合理的答案：</strong>商品目录基础价等于内含工作量 W；运输每跳加 1 金币的劳动价值并按合同实际路线结算；贷款只收真实借款的 2%；当前永久建筑不摊入商品边际成本；不存在可测随机损失时风险加成为 0；不使用 12% 或任何统一原料百分比。</div>
  <p>但不能只替换价格表就宣布完成。下一次实施应作为一个原子改造：</p>
  <ol>
    <li>把目录价格改为 <code>workUnits</code>，删除层级溢价、早期价格底线和 12% 递归下限。</li>
    <li>把内部卖家严格优先差价从 100 分改成最小货币单位 1 分；把每跳承运费定为 50 分，即一次五秒动作的税后替代收益；删除无真实动作或现金对应的 25 分影子采购摩擦。</li>
    <li>把生产评分分母改成本猫剩余动作与已签合同负担，不再把已由上游完成的全部 W 重算给最终组装猫。</li>
    <li>把图纸费从商品基础价解耦；本次模拟已证明合理的订单准备金会轻易把 11–15 图纸推过初始 150 金币预算。</li>
    <li>在同一套七条法规内显式承担供需控制：木板/纸/工具的补货增益和齿轮限流不能继续藏在商品价格里。</li>
    <li>重新跑用户定义的完整稳定性验收（含库存覆盖）以及 10/15/20/22/30/35 阶段，不把本报告的价格压力测试冒充通关。</li>
  </ol>
  <div class="verdict warning"><strong>本轮没有修改游戏价格。</strong>原因是单改目录会同时改变悬赏、信用、订单、图纸和法规排序，违反“每个数字有来源”的目标。报告给出了可实施方程和风险边界，下一步应先确认是否同意连同评分分母、图纸费一起原子重构。</div>
</section>

<footer>数据：<code>${inputPath}</code> · 远端：${summary.host.alias}/${summary.host.hostname} · Node ${summary.host.node} · Python ${summary.host.python} · 生成时间 ${new Date(summary.generatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</footer>
</main></body></html>`;

await writeFile(outputPath, html, "utf8");
console.log(JSON.stringify({ outputPath, rows: ITEMS.length, scenarioRuns: summary.simulation.totalScenarioRuns }));
