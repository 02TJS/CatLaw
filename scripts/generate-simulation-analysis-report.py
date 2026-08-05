from __future__ import annotations

import hashlib
import html
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output"
SUMMARY_PATH = OUTPUT / "simulation-analysis-counterfactual-summary.json"
BASELINE_PATH = OUTPUT / "simulation-analysis-baseline-1000.json"
REPORT_PATH = ROOT / "CatWorkshop-Computer-Simulation-Analysis.html"

summary = json.loads(SUMMARY_PATH.read_text(encoding="utf-8"))
baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))


def e(value: object) -> str:
    return html.escape(str(value))


def pct(value: int, total: int = 1000) -> str:
    return f"{value / total:.1%}"


def money(cents: int | None) -> str:
    return "-" if cents is None else f"{cents / 100:,.2f} 金币"


def table(headers: list[str], rows: list[list[object]], classes: str = "") -> str:
    head = "".join(f"<th>{e(cell)}</th>" for cell in headers)
    body = "".join("<tr>" + "".join(f"<td>{cell if isinstance(cell, Html) else e(cell)}</td>" for cell in row) + "</tr>" for row in rows)
    return f'<div class="table-wrap"><table class="{classes}"><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


class Html(str):
    pass


def status(text: str, kind: str) -> Html:
    return Html(f'<span class="status {e(kind)}">{e(text)}</span>')


def bar(value: int, total: int = 1000, color: str = "teal") -> Html:
    width = max(0, min(100, value / total * 100))
    return Html(
        f'<div class="bar-row"><div class="bar-track"><i class="{e(color)}" style="width:{width:.1f}%"></i></div>'
        f'<b>{value}/{total}</b><span>{pct(value, total)}</span></div>'
    )


experiments = summary["experiments"]
baseline_exp = experiments["baseline"]
credit_exp = experiments["credit5500"]
wood_exp = experiments["supplyWood"]

experiment_labels = {
    "baseline": "当前生产基线",
    "contractPriority": "合同绝对优先",
    "bountyClaim": "悬赏认领预校验",
    "contractBounty": "合同优先 + 悬赏校验",
    "credit5001": "信用 5,001 分",
    "credit5100": "信用 5,100 分",
    "credit5250": "信用 5,250 分",
    "credit5500": "信用 5,500 分",
    "credit6000": "信用 6,000 分",
    "credit6250": "信用 6,250 分",
    "credit7500": "信用 7,500 分",
    "credit10000": "信用 10,000 分",
    "credit12500": "信用 12,500 分",
    "credit15000": "信用 15,000 分",
    "credit25000": "信用 25,000 分",
    "creditOneBillion": "信用 10 亿分",
    "supplyWood": "木材反馈消融",
    "supplyFire": "炉火反馈消融",
    "supplyBoth": "木材 + 炉火反馈",
}

stage_rows = [
    ["初始达到 10", "不进行任何操作", status("通过", "pass"), bar(baseline_exp["stage10StrictStable"], color="green"), "第 11 项观察期产量为 0"],
    ["买图纸后达到 15", "只购买第 11-15 项图纸", status("未通过", "fail"), bar(baseline_exp["stage15StrictStable"], color="red"), "174 个种子未满足完整稳定定义"],
    ["正常解锁后无法达到 20", "先要求阶段 15 通过", status("未进入", "pending"), "-", "顺序门禁阻止后续结论"],
    ["选择性价格稳定到 22", "真实法规，冻结后观察", status("未进入", "pending"), "-", "不能继承旧哈希或 fixture 结论"],
    ["纯价格不能到 30 / 物流法到 30", "四组价格对照与真实统一法规", status("未进入", "pending"), "-", "阶段 15 尚未闭环"],
    ["玩家操作稳定到 35", "只允许公开玩家操作", status("未进入", "pending"), "-", "当前没有可审计的稳定 35 证明"],
]

baseline_failure_kinds = baseline["summary"]["stage15FailureKinds"]
baseline_materials = baseline["summary"]["stage15MaterialFailures"]
baseline_unstable = baseline["summary"]["stage15UnstableItems"]

contract_rows = []
for name in ("contractPriority", "bountyClaim", "contractBounty", "credit5500"):
    item = experiments[name]
    pair = summary["pairedAgainstBaseline"][name]
    contract_rows.append([
        experiment_labels[name],
        item["stage15FirstCrafted"],
        item["stage15StrictStable"],
        item["hardFrozenSeeds"],
        pair["rightOnly"],
        pair["leftOnly"],
        item["materialFailureSeeds"],
    ])

credit_rows = []
credit_values = {
    "baseline": "5,000",
    "credit5001": "5,001",
    "credit5100": "5,100",
    "credit5250": "5,250",
    "credit5500": "5,500",
    "credit6000": "6,000",
    "credit6250": "6,250",
    "credit7500": "7,500",
    "credit10000": "10,000",
    "credit12500": "12,500",
    "credit15000": "15,000",
    "credit25000": "25,000",
    "creditOneBillion": "1,000,000,000",
}
for item in summary["creditSweep"]:
    credit_rows.append([
        credit_values[item["name"]], item["stage15FirstCrafted"], item["stage15StrictStable"],
        item["hardFrozenSeeds"], item["materialFailureSeeds"], money(item["debtCents"]["median"]),
        money(item["debtCents"]["p95"]), money(item["debtCents"]["max"]),
    ])

supply_rows = []
for name in ("credit5500", "supplyWood", "supplyFire", "supplyBoth"):
    item = summary["supplyAblation"][name]
    exp = item["allSeeds"]
    pair = item["pairedAgainstCredit5500"]
    supply_rows.append([
        experiment_labels[name], exp["stage15StrictStable"], item["calibrationStrictPasses"],
        item["validationStrictPasses"], pair["rightOnly"], pair["leftOnly"],
        ", ".join(f"{key} {value}" for key, value in exp["materialFailureItems"].items()) or "无",
    ])

material = summary["materialCalibration"]
material_rows = []
for item_id in ("wood", "fire", "plank", "metal"):
    cal = material["calibration"][item_id]
    val = material["validation"][item_id]
    material_rows.append([
        item_id,
        cal["failures"], cal["craftedMedian"] or "-", cal["consumedMedian"] or "-",
        cal["uncoveredMedian"] or "-", f'{cal["consumptionToCraftRatioP95"]:.6f}' if cal["consumptionToCraftRatioP95"] else "-",
        val["failures"], val["craftedMedian"] or "-", val["consumedMedian"] or "-",
        val["uncoveredMedian"] or "-", f'{val["consumptionToCraftRatioP95"]:.6f}' if val["consumptionToCraftRatioP95"] else "-",
    ])

all_experiment_rows = []
for name, item in experiments.items():
    all_experiment_rows.append([
        experiment_labels[name], item["stage10StrictStable"], item["stage15FirstCrafted"],
        item["stage15ProductionStable"], item["stage15StrictStable"], item["hardFrozenSeeds"],
        item["materialFailureSeeds"], item["intervention"],
    ])

failed_seed_rows = []
for run in baseline["runs"]:
    next_zero = run["stage15"].get("nextItemEvidence", {}).get("craftedDuringObservation", 0) == 0
    if run["stage15"]["passed"] and next_zero:
        continue
    failed_seed_rows.append([
        run["seed"], "是" if run["stage15Ramp"]["reached"] else "否",
        run["stage15"]["stableThrough"], "；".join(run["stage15"]["failureReasons"]),
    ])

hash_rows = []
for name, digest in summary["authority"]["experimentFileSha256"].items():
    hash_rows.append([experiment_labels[name], digest])

artifact_hash = hashlib.sha256(SUMMARY_PATH.read_bytes()).hexdigest()
contracts = summary["stalledContractEvidence"]
feedback = material["testedFeedback"]

document = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>猫咪工坊计算机模拟分析报告</title>
<style>
:root{{--ink:#20231f;--muted:#656b64;--line:#d9ddd7;--soft:#f5f6f4;--green:#247a4b;--teal:#176f78;--amber:#9a6500;--red:#b43b35;--blue:#315d9a}}
*{{box-sizing:border-box}} body{{margin:0;background:#fff;color:var(--ink);font:15px/1.68 "Segoe UI","Microsoft YaHei",sans-serif;letter-spacing:0}}
header{{border-bottom:1px solid var(--line);padding:42px max(24px,calc((100vw - 1180px)/2)) 30px}}
header h1{{font-size:34px;line-height:1.2;margin:0 0 12px;letter-spacing:0}} header p{{max-width:920px;margin:0;color:var(--muted);font-size:16px}}
nav{{position:sticky;top:0;z-index:10;background:rgba(255,255,255,.96);border-bottom:1px solid var(--line);padding:9px max(24px,calc((100vw - 1180px)/2));overflow:auto;white-space:nowrap}}
nav a{{color:var(--ink);text-decoration:none;margin-right:20px;font-size:13px}} nav a:hover{{color:var(--teal)}}
main{{max-width:1180px;margin:auto;padding:30px 24px 70px}} section{{padding:28px 0;border-bottom:1px solid var(--line)}}
h2{{font-size:24px;margin:0 0 14px;letter-spacing:0}} h3{{font-size:17px;margin:24px 0 8px;letter-spacing:0}} p{{margin:9px 0}}
.lead{{font-size:18px;max-width:980px}} .verdict{{border-left:5px solid var(--red);padding:14px 18px;background:#fff7f6;margin:18px 0}}
.facts{{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);margin:20px 0}}
.fact{{background:white;padding:18px}} .fact b{{font-size:26px;display:block}} .fact span{{color:var(--muted);font-size:13px}}
.callout{{border-left:4px solid var(--blue);background:#f5f8fc;padding:12px 16px;margin:14px 0}} .warning{{border-color:var(--amber);background:#fffaf0}}
.table-wrap{{overflow:auto;border:1px solid var(--line);margin:12px 0}} table{{border-collapse:collapse;width:100%;min-width:760px}} th,td{{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}} th{{background:var(--soft);font-size:12px;color:#4b514a;position:sticky;top:0}} tr:last-child td{{border-bottom:0}}
.status{{display:inline-block;padding:2px 7px;border-radius:4px;font-size:12px;font-weight:700}} .status.pass{{color:var(--green);background:#eaf6ef}} .status.fail{{color:var(--red);background:#fff0ef}} .status.pending{{color:var(--amber);background:#fff6df}}
.bar-row{{display:grid;grid-template-columns:minmax(110px,1fr) 72px 54px;gap:8px;align-items:center;min-width:260px}} .bar-track{{height:9px;background:#ecefeb}} .bar-track i{{display:block;height:100%}} .bar-track .green{{background:var(--green)}} .bar-track .red{{background:var(--red)}} .bar-track .teal{{background:var(--teal)}}
code{{font-family:"Cascadia Code",Consolas,monospace;background:#f1f3f0;padding:1px 4px;border-radius:3px}} pre{{white-space:pre-wrap;background:#161a17;color:#eef3ed;padding:16px;overflow:auto;border-radius:4px}}
.flow{{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:15px 0}} .flow div{{border:1px solid var(--line);padding:14px;background:white}} .flow b{{display:block;margin-bottom:5px}} .flow .bad{{border-top:4px solid var(--red)}} .flow .good{{border-top:4px solid var(--green)}} .flow .warn{{border-top:4px solid var(--amber)}}
details{{border:1px solid var(--line);padding:10px 12px;margin:10px 0}} summary{{cursor:pointer;font-weight:700}} .mono{{font-family:"Cascadia Code",Consolas,monospace;font-size:12px;word-break:break-all}}
footer{{max-width:1180px;margin:auto;padding:0 24px 45px;color:var(--muted);font-size:13px}}
@media(max-width:800px){{.facts,.flow{{grid-template-columns:1fr 1fr}} header h1{{font-size:28px}}}}
@media print{{nav{{display:none}} main{{max-width:none}} section{{break-inside:avoid}}}}
</style>
</head>
<body>
<header>
  <h1>猫咪工坊：计算机模拟分析报告</h1>
  <p>目标是验证“初始稳定 10 → 只买图纸稳定 15 → 受控推进到 22/30/35”的严格阶段链。本报告固定当前版本与 1000 个世界种子，使用确定性 5000 倍时钟，不等待真实 5 秒，不调用 DeepSeek，不注入物品、金币或产量。</p>
</header>
<nav><a href="#verdict">结论</a><a href="#protocol">协议</a><a href="#baseline">基线</a><a href="#contracts">合同</a><a href="#credit">信用</a><a href="#supply">补货</a><a href="#decision">决策</a><a href="#appendix">附录</a></nav>
<main>
<section id="verdict">
  <h2>1. 结论先行</h2>
  <div class="verdict"><strong>当前版本未通过完整目标。</strong> 阶段 10 在 1000/1000 种子中通过；阶段 15 当前生产基线只有 826/1000 严格稳定。由于阶段验收是顺序门禁，20、22、30、35 本轮均不得宣称达到。</div>
  <div class="facts">
    <div class="fact"><b>1000/1000</b><span>当前基线：前 10 项严格稳定</span></div>
    <div class="fact"><b>826/1000</b><span>当前基线：前 15 项严格稳定</span></div>
    <div class="fact"><b>37 个</b><span>合同/计划硬停摆种子</span></div>
    <div class="fact"><b>911/1000</b><span>最佳诊断反事实，仍未达标</span></div>
  </div>
  {table(["阶段", "允许操作", "结论", "1000 种子", "解释"], stage_rows)}
</section>

<section id="protocol">
  <h2>2. 试验协议与证据边界</h2>
  <div class="flow">
    <div class="good"><b>首次制作</b>至少完成 1 次，只能证明解锁与可达。</div>
    <div class="warn"><b>重复制作</b>至少完成 3 次，但可能集中在一个窗口。</div>
    <div class="good"><b>生产稳定</b>每项至少 3 次、至少两窗活跃、末窗仍产出。</div>
    <div class="bad"><b>严格稳定</b>再加物料覆盖、无冻结市场、法规与玩家操作冻结。</div>
  </div>
  <p>每个阶段先爬坡至首次完成目标范围，随即清零统计基线但保留库存，再观察三个 5 分钟逻辑窗口。动作仍按 5000ms 逻辑耗时结算，只把引擎时钟加速 5000 倍。4999/5000ms 语义没有被删掉。</p>
  <p>“明显库存下降”的本次操作化规则沿用现有审计器：库存降幅达到 <code>max(3, ceil(期初库存×20%))</code> 且同期制作不能覆盖消耗时失败。这个阈值不是经济常数；报告将其作为验收口径明示，不能与理论价格系数混用。</p>
  <div class="callout"><strong>权威约束：</strong>19 组实验的共享行为哈希均为 <code>{e(summary['authority']['sharedBehaviorHash'])}</code>。所有反事实都单独记录干预名及 <code>localPlanner</code>、解释器、初始法规、目录、市场和引擎哈希；它们不是玩家通关结果。</div>
</section>

<section id="baseline">
  <h2>3. 当前生产基线</h2>
  <p class="lead">前 10 项已经满足目标。只购买第 11-15 项图纸后，前 15 项首次全部完成为 963/1000，商品重复生产口径也为 963/1000，但加入库存与市场守恒后只剩 826/1000。</p>
  {table(["指标", "结果", "含义"], [
      ["前 10 项首次完成", "1000/1000", "无玩家操作"],
      ["前 10 项严格稳定", "1000/1000", "第 11 项观察期为 0"],
      ["第 11-15 项图纸购买", "1000/1000", "生产版国库均支付成功"],
      ["前 15 项首次完成", "963/1000", "37 个种子在爬坡上限内未完成"],
      ["前 15 项生产稳定", "963/1000", "不含物料与冻结市场审计"],
      ["前 15 项严格稳定", "826/1000", "完整口径"],
  ])}
  <h3>失败分层</h3>
  <p>37 个种子同时出现商品不稳定、悬赏/计划停滞和运输合同冻结；另有 137 个种子的商品重复产出本身通过，但依赖库存净消耗。两类失败不能用同一个价格倍率解释。</p>
  {table(["失败证据", "种子/对象数", "分布"], [
      ["硬停摆种子", 37, "齿轮与金属各 37；工具 32；砖/石料各 30；玻璃 23；纸 22"],
      ["冻结合同", 126, "fire 52；wood 52；water 14；plank 8"],
      ["物料覆盖失败种子", 137, ", ".join(f"{k} {v}" for k, v in baseline_materials.items())],
      ["不稳定商品事件", sum(baseline_unstable.values()), ", ".join(f"{k} {v}" for k, v in baseline_unstable.items())],
  ])}
</section>

<section id="contracts">
  <h2>4. 合同冻结的因果消融</h2>
  <p>基线的 126 张冻结合同全部停在 <code>cat-3</code> 或 <code>cat-8</code>，持有猫全部处于 <code>wait</code>。126/126 条决策证据都先记录“履行有偿运输合同”，随后以“动作失效”进入等待。这证明候选排序与最终合法性校验之间存在不一致。</p>
  {table(["反事实", "首次完成 15", "严格稳定 15", "硬冻结种子", "新修复种子", "新回归种子", "物料失败种子"], contract_rows)}
  <h3>为什么不能直接把合同设为绝对优先</h3>
  <p>合同绝对优先确实把冻结合同清零，却把严格稳定率从 826 降到 493：它修复 19 个原失败种子，同时破坏 352 个原通过种子。原因是签约时的承运费估值只覆盖普通资产收益，没有纳入统一法规对制作候选叠加的高额评分，也没有给枢纽猫的多合同占用定价。绝对抢占于是让运输挤占矿石、齿轮和原料补货。</p>
  <h3>悬赏预校验也不充分</h3>
  <p>提前排除已被其他猫认领的悬赏，会消掉冻结合同，但 37 个原硬停摆种子仍卡在齿轮悬赏/计划，严格稳定反而从 826 降到 824。正确修复必须同时做到“候选合法后排序、失效后回退下一候选、签约费覆盖真实机会成本”，而不是只改一个布尔判断。</p>
  <pre>基线失败链：合同动作进入候选
→ 法规评分把另一制作候选推到更高分
→ 该制作候选在最终校验时失效
→ 控制器没有回退至合同候选
→ 枢纽猫进入 wait，托管货物与多个计划一起冻结</pre>
</section>

<section id="credit">
  <h2>5. 信用剂量扫描</h2>
  <p>固定 1000 个种子，只改初始信用法的基础额度。5,001、5,100、5,250 分与 5,000 分逐种子完全相同；5,500 与 6,000 分逐种子相同，并消除全部 37 个硬停摆。阈值因此位于 <strong>(5,250, 5,500]</strong>，不是“信用越多越好”的连续关系。</p>
  {table(["基础额度（分）", "首次完成 15", "严格稳定 15", "硬冻结种子", "物料失败种子", "债务中位数", "债务 P95", "债务最大"], credit_rows)}
  <div class="callout warning"><strong>不能直接把 5,500 写成理论最优值。</strong> 它只是当前 1000 种子、当前订单离散价格和当前法规下第一个被扫描到的无硬冻结点；并且相对基线修复 68 个严格失败种子时，也让 22 个原通过种子回归。6,250 及以上还会再次改变物料轨迹。生产参数应由峰值工作资本缺口与计划准入规则直接计算，而不是按最高通过率挑点。</div>
</section>

<section id="supply">
  <h2>6. 物料守恒与补货反馈</h2>
  <p>先以信用 5,500 分消除硬停摆，再把种子 1-500 作为校准集、501-1000 作为保留验证集。校准集只用于计算一次反馈试值；验证集不参与系数选择。</p>
  {table(["物料", "校准失败", "制作中位数", "消耗中位数", "缺口中位数", "消耗/制作 P95", "验证失败", "制作中位数", "消耗中位数", "缺口中位数", "消耗/制作 P95"], material_rows)}
  <p>木材试值来自 <code>{feedback['woodPrevious']} × {feedback['woodCalibrationRatioP95']:.10f} = {feedback['woodTested']:.10f}</code>；炉火试值来自 <code>{feedback['firePrevious']} × {feedback['fireCalibrationRatioP95']:.10f} = {feedback['fireTested']:.2f}</code>。这是一次经验补偿消融，不是新的理论常数。</p>
  {table(["共同信用 5,500 的变体", "全 1000 严格通过", "校准集通过", "保留集通过", "相对对照修复", "相对对照回归", "剩余物料失败"], supply_rows)}
  <p>木材反馈在保留集从 428/500 提升到 454/500，方向可复现；但炉火失败从 36 增到 66、木板从 10 增到 20。炉火反馈单独则让木材失败增到 128。联合反馈也只有 904/1000。瓶颈会沿共享工位与运输容量移动，因此不能继续独立乘倍数。</p>
</section>

<section id="decision">
  <h2>7. 对生产修改的判定</h2>
  {table(["候选改动", "证据", "判定"], [
      ["合同动作无条件绝对优先", "严格稳定 493/1000，352 个回归", status("拒绝", "fail")],
      ["只过滤已认领悬赏", "冻结清零但齿轮计划仍停，824/1000", status("不足", "pending")],
      ["基础信用直接改 5,500", "消除硬冻结但有 22 个回归；阈值仅由扫描得到", status("先重构准入", "pending")],
      ["木材反馈改为 1.6909", "保留集改善，但瓶颈转移到炉火/木板", status("仅作为方向", "pending")],
      ["炉火反馈改为 2.95", "严格稳定降到 827/1000", status("拒绝", "fail")],
      ["继续阶段 20-35 验收", "阶段 15 尚未 1000/1000", status("暂停", "pending")],
  ])}
  <h3>下一轮应改的层</h3>
  <ol>
    <li><strong>候选原子性：</strong>在同一只读快照上生成并校验所有候选，按分数选择第一个合法候选；若开始动作前状态已变，重新校验并回退，不能直接 wait。</li>
    <li><strong>合同机会成本：</strong>签约时把共享法规后的最高合法替代分数、枢纽现有合同占用和完整路径容量纳入承运费/准入，避免用固定百万分抢占一切。</li>
    <li><strong>工作资本：</strong>记录每个被拒计划的逐时点 <code>requiredWorkingCapital - buyingPower</code>，用峰值缺口定信用，而不是继续扫额度。</li>
    <li><strong>多物料闭环：</strong>把木材、炉火、木板、金属作为一个受容量约束的反馈系统；控制量应包含期初库存、在途、已承诺消耗和每个资源工位的可用动作槽。</li>
    <li><strong>重新验收：</strong>生产修改后先重跑同一 1000 种子阶段 10/15；只有严格 1000/1000 后才解锁阶段 20 分析。</li>
  </ol>
</section>

<section id="appendix">
  <h2>8. 完整实验与可复现材料</h2>
  <p>本轮共汇总 19 组 × 1000 种子。DeepSeek 调用数为 0；真实 5 秒等待次数为 0；玩家操作只有阶段 15 前购买五张图纸。生产源文件没有被本轮诊断覆盖，所有反事实仅存在于隔离分析目录。</p>
  {table(["实验", "稳定 10", "首次 15", "生产稳定 15", "严格稳定 15", "硬冻结", "物料失败", "干预"], all_experiment_rows)}
  <details><summary>当前基线 174 个失败种子</summary>{table(["种子", "首次完成 15", "连续稳定到", "失败原因"], failed_seed_rows)}</details>
  <details><summary>19 个聚合结果 SHA-256</summary>{table(["实验", "SHA-256"], hash_rows, "mono")}</details>
  <details><summary>核心权威哈希说明</summary><p>每个聚合文件的 <code>authority</code> 包含共享行为、<code>lawProgram</code>、<code>localPlanner</code>、法条解释器、初始法规、目录、市场和引擎哈希。汇总 JSON 自身 SHA-256 为：</p><p class="mono">{artifact_hash}</p></details>
  <h3>主要文件</h3>
  <ul>
    <li><code>output/simulation-analysis-baseline-1000.json</code>：当前生产基线逐种子证据。</li>
    <li><code>output/simulation-analysis-counterfactual-summary.json</code>：19 组配对汇总。</li>
    <li><code>scripts/simulation-analysis-worker.mts</code>：确定性阶段审计器。</li>
    <li><code>scripts/analyze-simulation-counterfactuals.mts</code>：哈希校验与配对统计。</li>
    <li><code>scripts/run-simulation-analysis-remote.sh</code>：远端 CPU 分片运行器。</li>
  </ul>
</section>
</main>
<footer>生成时间：{e(summary['generatedAt'])}。结论只对所列版本、源码哈希、1000 个固定种子与验收口径成立；反事实结果不得表述为玩家通关。</footer>
</body>
</html>
"""

REPORT_PATH.write_text(document, encoding="utf-8")
print(json.dumps({
    "report": str(REPORT_PATH),
    "bytes": REPORT_PATH.stat().st_size,
    "sha256": hashlib.sha256(REPORT_PATH.read_bytes()).hexdigest(),
}, ensure_ascii=False, indent=2))
