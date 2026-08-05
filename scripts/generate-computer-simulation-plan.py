#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import html
import json
import re
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PRICE_RESULTS = ROOT / "output" / "price-theory-results.json"
PRICE_MODEL_RESULTS = ROOT / "output" / "price-model-summary.json"
PROGRESSION_RESULTS = ROOT / "output" / "deepseek-to-35-headless.json"
LAW_PROGRAM = ROOT / "src" / "game" / "lawProgram.ts"
OUTPUT = ROOT / "CatWorkshop-Computer-Simulation-Plan.html"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def fmt(value: float, digits: int = 3) -> str:
    return f"{value:.{digits}f}"


def fnv1a(source: str) -> str:
    value = 0x811C9DC5
    for character in source:
        value ^= ord(character)
        value = (value * 0x01000193) & 0xFFFFFFFF
    return f"fnv1a-{value:08x}"


def current_behavior_hash() -> tuple[str, str]:
    source = LAW_PROGRAM.read_text(encoding="utf-8")
    fields = {
        "id": re.search(r'id:\s*"([^"]+)"', source),
        "version": re.search(r"version:\s*(\d+)", source),
        "active": re.search(r'activeStatus:\s*"([^"]+)"', source),
        "quarantined": re.search(r'quarantinedStatus:\s*"([^"]+)"', source),
        "faults": re.search(r"quarantineAfterFaults:\s*(\d+)", source),
        "direct": re.search(r'directActionMode:\s*"([^"]+)"', source),
        "adjustments": re.search(r'adjustmentMode:\s*"([^"]+)"', source),
        "selector": re.search(r'selectorMode:\s*"([^"]+)"', source),
    }
    if any(match is None for match in fields.values()):
        return "unresolved", "协议字段解析失败"
    protocol = (
        f"{fields['id'].group(1)}/v{fields['version'].group(1)}\n"
        f"active-status={fields['active'].group(1)}\n"
        f"quarantined-status={fields['quarantined'].group(1)}\n"
        f"quarantine-after-faults={fields['faults'].group(1)}\n"
        f"direct-action={fields['direct'].group(1)}\n"
        f"adjustments={fields['adjustments'].group(1)}\n"
        f"selector={fields['selector'].group(1)}"
    )
    return fnv1a(protocol), protocol


price = json.loads(PRICE_RESULTS.read_text(encoding="utf-8"))
price_model = json.loads(PRICE_MODEL_RESULTS.read_text(encoding="utf-8"))
progression = json.loads(PROGRESSION_RESULTS.read_text(encoding="utf-8"))
current_hash, current_protocol = current_behavior_hash()
fixture = progression["seedResults"][0]
fixture_hash = fixture["antiCheat"]["sharedBehaviorHash"]
stages = {entry["name"]: entry for entry in fixture["stages"]}
aggregates = {(entry["stage"], entry["mode"]): entry for entry in price["lpAggregates"]}


def lp_row(stage: int, mode: str, label: str) -> str:
    entry = aggregates[(stage, mode)]
    lam = entry["lambdaPerMinute"]
    return (
        "<tr>"
        f"<td>{label}</td><td>{lam['min']:.3f}</td><td>{lam['median']:.3f}</td>"
        f"<td>{lam['p95']:.3f}</td><td>{lam['max']:.3f}</td>"
        f"<td>{entry['maxDualityGap']:.3e}</td><td>{entry['maxKktResidual']:.3e}</td>"
        "</tr>"
    )


lp_rows = "".join([
    lp_row(10, "equal-pieces", "前 10 项，等净件数"),
    lp_row(10, "equal-work", "前 10 项，等包含劳动"),
    lp_row(15, "equal-pieces", "前 15 项，等净件数"),
    lp_row(15, "equal-work", "前 15 项，等包含劳动"),
])


def bottleneck_counts(stage: int, mode: str) -> Counter[str]:
    rows = [entry for entry in price["lpCertificates"] if entry["stage"] == stage and entry["mode"] == mode]
    return Counter(entry["topTargetShadowShares"][0]["itemId"] for entry in rows)


stage10_bottlenecks = bottleneck_counts(10, "equal-pieces")
stage15_piece_bottlenecks = bottleneck_counts(15, "equal-pieces")
stage15_work_bottlenecks = bottleneck_counts(15, "equal-work")


def counter_text(counter: Counter[str], total: int = 1000) -> str:
    return "、".join(f"<code>{esc(item)}</code> {count}/{total}" for item, count in counter.most_common())


spatial = []
for item in price["items"][:15]:
    delivered = item.get("minimumDeliveredActionsDifficulty5InitialWorlds")
    if not delivered:
        continue
    spatial.append({
        "index": item["index"] + 1,
        "name": item["name"],
        "emoji": item["emoji"],
        "id": item["id"],
        "work": item["workDifficulty5"],
        "median": delivered["median"],
        "p95": delivered["p95"],
        "extra": delivered["median"] - item["workDifficulty5"],
        "ratio": delivered["median"] / item["workDifficulty5"],
    })
spatial.sort(key=lambda entry: (-entry["extra"], -entry["ratio"], entry["index"]))
spatial_rows = "".join(
    "<tr>"
    f"<td>{entry['index']}</td><td>{esc(entry['emoji'])} {esc(entry['name'])}</td>"
    f"<td>{entry['work']:.0f}</td><td>{entry['median']:.0f}</td><td>{entry['p95']:.0f}</td>"
    f"<td>{entry['extra']:.0f}</td><td>{entry['ratio']:.2f}×</td>"
    "</tr>"
    for entry in spatial[:9]
)


def stage_stability_row(name: str) -> str:
    entry = stages[name]
    stability = entry.get("stability")
    if not stability:
        return ""
    frozen = stability["frozenEconomy"]
    frozen_count = sum(len(values) for values in frozen.values())
    return (
        "<tr>"
        f"<td>{esc(name)}</td><td>{stability['stableThrough']}</td>"
        f"<td>{stability['observationSimulatedMs'] / 60_000:g} 分钟</td>"
        f"<td>{' / '.join(str(value) for value in stability['windowTargetCraftTotals'])}</td>"
        f"<td>{frozen_count}</td><td>{'通过' if entry['passed'] else '失败'}</td>"
        "</tr>"
    )


stage_rows = "".join(stage_stability_row(name) for name in [
    "开局自然达到10",
    "仅购买11—15图纸后达到15",
    "自然16–19稳定且第20项不能稳定制作",
    "选择性价格推进并稳定制作至22",
])


baseline = price_model["currentBaseline"]
failed_seed_text = "、".join(str(seed) for seed in baseline["failedSeeds"])
hash_status = "一致" if fixture_hash == current_hash else "不一致，必须重跑"


experiment_rows = "".join([
    "<tr><td>E0 守恒与确定性回放</td><td>引擎是否忠实实现规则</td><td>同一存档、同一事件序列重复两次；事件解释器与 Petri 参考模型逐事件比较</td><td>库存/现金/托管物残差、事件顺序、最终状态哈希</td><td>任一残差非零或哈希不同立即停止并判引擎缺陷</td></tr>",
    "<tr><td>E1 连续流 LP</td><td>物理容量是否允许稳定生产</td><td>当前地图；零运输；无限猫容量；移除建筑约束等单因素对照</td><td>最大最小净流率、猫容量租金、商品影子价、路径流量</td><td>最优/不可行证明；对偶间隙与 KKT 残差达到求解容差，超时只记未决</td></tr>",
    "<tr><td>E2 时间展开 CP-SAT/MILP</td><td>是否存在合法整数动作排程</td><td>与 E1 同种子同库存；5 秒动作槽、逐跳合同、真实建筑范围</td><td>稳定谓词、最少动作数、峰值在制品、最大等待时间</td><td>找到满足稳定谓词的排程或证明不可行；求解超时不得写成不可行</td></tr>",
    "<tr><td>E3 理想调度器闭环</td><td>可行排程能否由引擎执行</td><td>研究专用 oracle 按 E2 排程发动作；价格、信用、地图不变</td><td>计划动作与实际动作偏差、守恒、合同结算</td><td>排程完成或第一次引擎拒绝；oracle 只用于诊断，不计玩家验收</td></tr>",
    "<tr><td>E4 当前共享法规闭环</td><td>当前统一程序是否能实现可行流</td><td>同一批种子下对照 E3；冻结法规和玩家操作</td><td>稳定等级、机会损失、候选排名、闲置率、饥饿时间</td><td>稳定通过、进入重复无进展状态、硬违规；时间预算耗尽只记验收失败/未决</td></tr>",
    "<tr><td>E5 资金与信用消融</td><td>失败是否来自流动性而非产能</td><td>当前信用、无限信用、零利息、零保证金、仅提高国库分别成对比较</td><td>信用缺口、保证金占用、债务期限、订单冻结时间、稳定阶段</td><td>首次出现结果分叉后继续完整稳定窗口；所有结果使用相同种子</td></tr>",
    "<tr><td>E6 物流消融</td><td>失败是否来自路径、费用或承运容量</td><td>真实物流；零运费；零运输时长；无限中转合同槽；理想最短路分别比较</td><td>运输动作占比、路径长度、订单到货周期、在途 WIP、瓶颈边</td><td>完成稳定窗口；若物理断路则立即记录最小割而不是继续扫价格</td></tr>",
    "<tr><td>E7 空间与建筑消融</td><td>建筑/地图约束是否造成不可达</td><td>真实布局、oracle 建筑位置、半径逐级覆盖、同资源不同地图重排</td><td>合法工位数、覆盖率、最小割、资源猫租金、额外运输动作</td><td>覆盖集不再变化或稳定结论分叉；保持配方和价格不变</td></tr>",
    "<tr><td>E8 参数敏感性</td><td>哪些参数真正控制结果</td><td>Morris 初筛，随后对高影响项做 Saltelli/Sobol；公共种子成对运行</td><td>基本效应均值/离散度、总效应、交互效应、阶段通过率</td><td>自适应增加样本，直到待修改参数的排名/置信区间不再交叉</td></tr>",
    "<tr><td>E9 多目标仿真优化</td><td>怎样改得最少且跨种子稳健</td><td>保留基线、统一 ×2、选择性价格、法规、信用、物流组合的 Pareto 对照</td><td>最高稳定 N、最差商品裕量、冻结占用、运输动作、库存波动</td><td>Pareto 前沿连续两轮无新增支配解；候选仍须过完整 1000 种子面板</td></tr>",
])


decision_rows = "".join([
    "<tr><td>LP 已不可行</td><td>资源/猫容量/地图/建筑覆盖属于硬瓶颈</td><td><b>地图、猫位、资源覆盖、建筑半径或配方负担</b></td><td>不要调价格或法规；它们不能创造物理容量</td></tr>",
    "<tr><td>LP 可行，整数模型不可行</td><td>批量、逐跳、互斥动作或缓冲导致排程冲突</td><td><b>物流容量、缓冲策略、猫链与建筑布局</b></td><td>先找不可行核/最小割，再决定加中转猫还是改范围</td></tr>",
    "<tr><td>整数模型可行，oracle 失败</td><td>引擎语义、结算顺序或守恒实现错误</td><td><b>引擎/状态机</b></td><td>这是 bug，不是平衡问题</td></tr>",
    "<tr><td>oracle 通过，当前法规失败；目标机会本来为正</td><td>共享法规没有选择正确候选</td><td><b>法规观察量、评分、中间优先级</b></td><td>DeepSeek 法规应改变排序；不应偷偷改共享行为文件</td></tr>",
    "<tr><td>目标候选净资产收益为负，且选择性提价后转正</td><td>相对价格不足以覆盖机会成本</td><td><b>该商品价格/订单出价</b></td><td>按临界差额加最小 1 分，不使用无依据百分比</td></tr>",
    "<tr><td>统一 ×2 前后动作排序完全相同</td><td>纯比例变换不改变相对吸引力</td><td><b>价格结构或法规</b></td><td>停止扫全局倍率；研究选择性相对价或非价格规则</td></tr>",
    "<tr><td>有物理供给但订单长期 credit-blocked</td><td>流动资金/保证金不足</td><td><b>信用额度、保证金、贷款成本</b></td><td>用理想排程的峰值资金缺口定额度，不按商品等级拍数值</td></tr>",
    "<tr><td>订单成交但合同 WIP 高、到货周期长</td><td>承运猫机会成本或路径容量不足</td><td><b>运费、合同槽、路线、猫链</b></td><td>用 Little 定律分解 WIP=吞吐×周期；先定位是流量还是等待</td></tr>",
    "<tr><td>大量 siteFailure，oracle 建筑位置可通过</td><td>建筑覆盖与工位分布不匹配</td><td><b>建筑放置、半径、土地</b></td><td>选择覆盖目标工位的最小半径/位置，不改成全图生效</td></tr>",
    "<tr><td>同参数只在部分资源布局失败，且最小割为 1</td><td>地图对单点资源猫或单条猫链过敏</td><td><b>地图生成、采集覆盖、购地/放猫引导</b></td><td>提高路径冗余或资源覆盖，保留经济规则</td></tr>",
    "<tr><td>gross craft 通过但物料覆盖失败</td><td>依赖历史库存或卖掉关键原料</td><td><b>订单缓冲、出售策略、法规</b></td><td>不能宣称稳定；先修复补货/保留逻辑</td></tr>",
    "<tr><td>报告哈希与当前共享行为哈希不同</td><td>证据来自另一控制器版本</td><td><b>重跑实验</b></td><td>任何参数结论都先暂停，不能跨哈希继承</td></tr>",
])


stage_plan_rows = "".join([
    "<tr><td>10</td><td>不做任何操作</td><td>前 10 项稳定；第 11 项三窗均为 0</td><td>1000 种子价格模型曾为 1000/1000；严格夹具仅种子 1，且哈希已不同</td><td>当前哈希下重跑固定 1000 面板</td></tr>",
    "<tr><td>15</td><td>只购买 11–15 图纸</td><td>前 15 项稳定，禁止其他玩家动作</td><td>严格夹具种子 1 通过；价格模型为 956/1000，44 个 stalled-contract</td><td>把 44 个失败种子全部纳入回归；先做信用/物流消融</td></tr>",
    "<tr><td>20</td><td>正常解锁 16–20</td><td>前 19 稳定，第 20 不能形成稳定重复生产</td><td>种子 1 夹具前 19 三窗 325/312/311；多种子未闭环</td><td>验证这是软经济瓶颈，而不是 LP/建筑硬不可行</td></tr>",
    "<tr><td>22</td><td>只颁布选择性价格法规</td><td>前 22 稳定</td><td>种子 1 fixture 三窗 762/792/776；不是真实 DeepSeek 通关</td><td>真实编译法、当前哈希、成对多种子复验</td></tr>",
    "<tr><td>30</td><td>四种纯价格方案对照物流法规</td><td>纯价格均不能稳定 30；物流法规使 22–30 跨窗重复</td><td>当前机器 JSON 没有 30 阶段结果</td><td>先用 E2/E6 判断缺口，再做真实统一法规候选</td></tr>",
    "<tr><td>35</td><td>允许购配方、法规、买卖、放猫、购地、收购/放建筑</td><td>冻结操作后 31–35 与供应链持续循环，不靠玩家买入原料</td><td>尚无当前版本机器证明</td><td>完整操作账本、来源标签、法规源码/哈希、1000 种子鲁棒性</td></tr>",
])


sources = [
    ("Murata, 1989, Petri nets: Properties, analysis and applications", "并发、可达性、活性、有界性和不变量的经典框架。", "https://doi.org/10.1109/5.24143"),
    ("Ramadge & Wonham, 1987, Supervisory Control of a Class of Discrete Event Processes", "用于区分可控动作、不可控事件和非阻塞监督器。", "https://doi.org/10.1137/0325013"),
    ("Alur & Dill, 1994, A theory of timed automata", "用于动作时钟、截止条件和结算顺序验证。", "https://doi.org/10.1016/0304-3975(94)90010-8"),
    ("Sargent, Verification and validation of simulation models", "支持把概念模型验证、实现校验和操作有效性分开。", "https://doi.org/10.1057/jos.2012.20"),
    ("Heidelberger & Welch, 1983, Simulation Run Length Control in the Presence of an Initial Transient", "为爬坡期、初始瞬态和运行长度控制提供经典依据。", "https://doi.org/10.1287/opre.31.6.1109"),
    ("McKay, Beckman & Conover, 1979, Comparison of Three Methods for Selecting Values of Input Variables", "Latin hypercube 用于覆盖连续参数空间。", "https://doi.org/10.1080/00401706.1979.10489755"),
    ("Morris, 1991, Factorial Sampling Plans for Preliminary Computational Experiments", "低成本筛选高影响参数及非线性/交互。", "https://doi.org/10.1080/00401706.1991.10484804"),
    ("Campolongo, Cariboni & Saltelli, 2007, An effective screening design for sensitivity analysis of large models", "改进 Morris 轨迹设计，适合大参数模型。", "https://doi.org/10.1016/j.envsoft.2006.10.004"),
    ("Sobol, 2001, Global sensitivity indices for nonlinear mathematical models", "用一阶和总效应分解输出方差。", "https://doi.org/10.1016/S0378-4754(00)00270-6"),
    ("Saltelli et al., 2010, Variance based sensitivity analysis of model output", "总效应估计与高效实验设计。", "https://doi.org/10.1016/j.cpc.2009.09.018"),
    ("Fu, 2002, Optimization for simulation: Theory vs. Practice", "仿真优化方法与工程实践边界。", "https://doi.org/10.1287/ijoc.14.3.192.113"),
    ("Chen et al., 2000, Simulation Budget Allocation for Further Enhancing the Efficiency of Ordinal Optimization", "把计算预算更多分配给难以区分的候选。", "https://doi.org/10.1023/A:1008349927281"),
    ("Bertsimas & Sim, 2004, The Price of Robustness", "用于解释名义最优与跨种子鲁棒方案之间的代价。", "https://doi.org/10.1287/opre.1030.0065"),
    ("Little, 1961, A Proof for the Queuing Formula L = λW", "把在途/排队数量、吞吐和周期时间连接起来。", "https://doi.org/10.1287/opre.9.3.383"),
    ("Kleijnen, 2015, Design and Analysis of Simulation Experiments", "仿真实验设计、代理模型和敏感性分析的系统参考。", "https://doi.org/10.1007/978-3-319-18087-8"),
    ("CPN Tools 官方站", "Colored Petri Net 的编辑、仿真与状态空间分析工具。", "https://cpntools.org/"),
    ("UPPAAL 官方站", "timed automata 网络的建模、验证和统计模型检查工具。", "https://www.uppaal.org/"),
    ("Google OR-Tools CP-SAT 官方文档", "有限域整数约束排程求解器，可用于时间展开动作模型。", "https://developers.google.com/optimization/cp/cp_solver"),
]
source_html = "".join(
    f'<div class="source"><b>{esc(title)}</b><small>{esc(note)}</small><a href="{esc(url)}">{esc(url)}</a></div>'
    for title, note, url in sources
)


document = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>猫咪工坊计算机模拟研究计划与本地证据分析</title>
<style>
:root{{--ink:#18211c;--muted:#5d6760;--line:#d9e0da;--soft:#f5f7f5;--green:#176a43;--green-bg:#e9f5ed;--blue:#245f85;--blue-bg:#edf6fb;--amber:#795711;--amber-bg:#fbf4e3;--red:#923c33;--red-bg:#faecea}}*{{box-sizing:border-box}}html{{scroll-behavior:smooth}}body{{margin:0;background:#edf1ed;color:var(--ink);font:15px/1.72 "Segoe UI","Microsoft YaHei",sans-serif;letter-spacing:0}}.shell{{display:grid;grid-template-columns:272px minmax(0,1fr);width:min(1540px,calc(100% - 28px));margin:22px auto 60px;background:#fff;border:1px solid var(--line);box-shadow:0 14px 42px #26382b18}}nav{{position:sticky;top:0;height:100vh;padding:25px 18px;border-right:1px solid var(--line);overflow:auto;background:#fbfcfb}}nav h2{{font-size:17px;margin:0 0 13px}}nav a{{display:block;color:#445149;text-decoration:none;padding:6px 9px;border-radius:6px}}nav a:hover{{background:var(--soft);color:var(--green)}}main{{min-width:0;padding:38px 48px 72px}}header{{padding-bottom:30px}}section{{scroll-margin-top:18px;padding-top:28px;margin-top:12px;border-top:1px solid var(--line)}}h1{{font-size:35px;line-height:1.2;margin:5px 0 14px}}h2{{font-size:24px;margin:0 0 12px}}h3{{font-size:18px;margin:23px 0 8px}}p{{margin:9px 0}}.eyebrow{{color:var(--green);font-weight:750}}.lede{{font-size:18px;color:#39443d;max-width:1080px}}.callout{{padding:14px 17px;border-left:5px solid var(--green);background:var(--green-bg);margin:15px 0}}.info{{border-left-color:var(--blue);background:var(--blue-bg)}}.warn{{border-left-color:var(--amber);background:var(--amber-bg)}}.no{{border-left-color:var(--red);background:var(--red-bg)}}.cards{{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:11px;margin:16px 0}}.card{{border:1px solid var(--line);border-radius:7px;padding:13px;background:#fff}}.card b{{display:block;color:var(--green);font-size:23px}}.card span{{color:var(--muted)}}.table-wrap{{overflow:auto;border:1px solid var(--line);border-radius:7px;margin:13px 0}}table{{border-collapse:collapse;width:100%;min-width:850px}}th,td{{border-bottom:1px solid var(--line);border-right:1px solid var(--line);padding:9px;text-align:left;vertical-align:top}}th{{background:#eef4ef;position:sticky;top:0}}tr:last-child td{{border-bottom:0}}th:last-child,td:last-child{{border-right:0}}code{{font:12px Consolas,monospace;color:#465149;word-break:break-all}}.formula{{font:14px/1.68 Consolas,"Microsoft YaHei",monospace;background:var(--soft);border:1px solid var(--line);border-radius:7px;padding:13px 16px;overflow:auto;white-space:pre-wrap}}.flow{{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin:15px 0}}.flow span{{border:1px solid var(--line);border-radius:6px;padding:8px 10px;background:var(--soft)}}.flow i{{color:var(--muted)}}.source{{padding:12px 0;border-bottom:1px solid var(--line)}}.source:last-child{{border-bottom:0}}.source a{{display:block;color:var(--blue);word-break:break-all}}.source small,.small{{display:block;color:var(--muted)}}ul,ol{{padding-left:24px}}li{{margin:6px 0}}.tag{{display:inline-block;border:1px solid var(--line);border-radius:5px;padding:1px 6px;background:var(--soft);font-size:12px}}@media(max-width:1000px){{.shell{{display:block}}nav{{position:relative;height:auto;border-right:0;border-bottom:1px solid var(--line)}}nav div{{columns:2}}main{{padding:28px}}.cards{{grid-template-columns:repeat(2,1fr)}}}}@media(max-width:640px){{.shell{{width:100%;margin:0;border:0}}main{{padding:22px 16px}}nav div{{columns:1}}.cards{{grid-template-columns:1fr}}h1{{font-size:28px}}}}
</style></head><body><div class="shell"><nav><h2>报告目录</h2><div>
<a href="#verdict">1. 研究结论</a><a href="#evidence">2. 本地证据审计</a><a href="#target">3. 最值得优化的目标</a><a href="#metrics">4. 指标与守恒口径</a><a href="#architecture">5. 模型架构</a><a href="#matrix">6. 实验矩阵</a><a href="#controls">7. 对照与停止条件</a><a href="#stages">8. 10–35 阶段计划</a><a href="#sensitivity">9. 敏感性与优化</a><a href="#mapping">10. 结果如何决定改哪里</a><a href="#parameter">11. 参数定量方法</a><a href="#compute">12. 5090_Lian 执行方案</a><a href="#audit">13. 审计与复现</a><a href="#limits">14. 当前缺口</a><a href="#sources">15. 资料来源</a>
</div></nav><main>
<header><div class="eyebrow">CAT WORKSHOP · COMPUTER SIMULATION RESEARCH</div><h1>计算机模拟研究计划与本地证据分析</h1><p class="lede">这份报告回答的不是“再试一个价格倍率”，而是：应该模拟什么、怎样区分物理瓶颈与控制失败、何时停止、得到什么结果时应改价格、法规、物流、信用、建筑或地图。所有建议都与当前工作区源码和已有机器结果对照。</p>
<div class="callout"><strong>核心建议：</strong>第十项应引入的不是另一条价格公式，而是“离散可行性 + 闭环控制 + 鲁棒仿真优化”三件套：时间展开 CP-SAT/MILP 证明存在合法排程，固定共享法规轨迹检验控制器能否实现排程，跨种子多目标优化决定最小且稳健的参数改动。</div></header>

<section id="verdict"><h2>1. 研究结论</h2><ol>
<li><b>主目标应采用词典序，而不是加权总分：</b>先最大化能严格稳定通过的最高阶段 N；再最大化最弱商品的稳定裕量；再最小化冻结资金、运输动作和库存波动；最后才考虑金币与总产值。</li>
<li><b>价格只是六类控制杆之一：</b>LP 不可行时价格无效；整数排程可行但法规失败时应改统一法规；有供给却 credit-blocked 才改信用；合同 WIP 高才改物流；siteFailure 才改建筑；最小割和资源租金对地图敏感才改地图。</li>
<li><b>稳定必须同时看生产与物料：</b>gross craft 证明机器在动，net inventory 和守恒证明没有吃历史库存，provenance 证明玩家买入没有冒充自主生产。</li>
<li><b>“不能达到”需要证明等级：</b>超时只能说明本次验收未通过；只有整数模型不可行、可达图无目标状态，或进入可证明的无产出重复闭环，才能说结构上不能达到。</li>
<li><b>当前最优先的实验不是继续扫价格：</b>先在当前行为哈希下复现前 15 项的 44 个合同停滞种子，再做信用与物流成对消融；否则会把合同问题错误解释为价格问题。</li>
</ol></section>

<section id="evidence"><h2>2. 本地证据审计</h2><div class="cards"><div class="card"><b>{price['seedCount']:,}</b><span>固定世界种子</span></div><div class="card"><b>{len(price['lpCertificates']):,}</b><span>LP 证书，失败 {len(price['lpFailures'])}</span></div><div class="card"><b>{baseline['stage15Passes']}/{baseline['runs']}</b><span>价格模型前 15 项通过</span></div><div class="card"><b>22/35</b><span>现有严格 fixture 证据上限</span></div></div>
<h3>2.1 连续流上界</h3><div class="table-wrap"><table><thead><tr><th>模型</th><th>最小 λ/分钟</th><th>中位</th><th>P95</th><th>最大</th><th>最大对偶间隙</th><th>最大 KKT 残差</th></tr></thead><tbody>{lp_rows}</tbody></table></div>
<p>4000 个 LP 均成功。整体最大对偶间隙为 <code>5.551e-16</code>，最大 KKT 残差为 <code>1.998e-15</code>。这证明模型在数值上求到了连续最优流，但不证明 5 秒整数动作、逐跳合同和共享法规能实现这些流量。</p>
<h3>2.2 影子价格说明“瓶颈取决于目标”</h3><ul><li>前 10 项等净件数：{counter_text(stage10_bottlenecks)}。</li><li>前 15 项等净件数：{counter_text(stage15_piece_bottlenecks)}；齿轮在 96.9% 种子中是首要目标影子价。</li><li>前 15 项等包含劳动：{counter_text(stage15_work_bottlenecks)}。目标一改，瓶颈从齿轮转向炉火/矿石/水。</li></ul>
<div class="callout warn"><strong>含义：</strong>不能从单一 LP 目标直接推出唯一“合理价格”。等件数强调每件商品公平，等劳动强调每单位产业劳动公平；应先固定游戏想要的稳定目标，再使用对应影子价。</div>
<h3>2.3 空间额外动作</h3><div class="table-wrap"><table><thead><tr><th>#</th><th>商品</th><th>技术劳动 W</th><th>最少到货动作中位</th><th>P95</th><th>空间增量</th><th>到货/技术比</th></tr></thead><tbody>{spatial_rows}</tbody></table></div>
<p>齿轮的中位额外动作是 8，纸、砖、工具、玻璃和金属均为 4。价格只按配方劳动定值会系统性漏掉汇聚和逐跳运输成本。</p>
<h3>2.4 闭环轨迹与版本边界</h3><div class="table-wrap"><table><thead><tr><th>阶段</th><th>稳定至</th><th>观察期</th><th>三窗毛制作总量</th><th>冻结项</th><th>结果</th></tr></thead><tbody>{stage_rows}</tbody></table></div>
<p>价格模型记录前 10 项 <b>{baseline['stage10Passes']}/{baseline['runs']}</b>、前 15 项 <b>{baseline['stage15Passes']}/{baseline['runs']}</b>；44 个失败均标为 <code>stalled-contract</code>。平均采购动作占比 {baseline['procurementShare']['mean']:.1%}，平均融资占比 {baseline['financedShare']['mean']:.1%}，合同平均路径约 {baseline['routeEdges']['meanOfMeans']:.2f} 边，种子内 P95 路径的跨种子 P95 为 {baseline['routeEdges']['p95OfSeedP95']} 边。</p>
<div class="callout no"><strong>不能跨版本继承：</strong>严格 fixture 的行为哈希为 <code>{fixture_hash}</code>，当前工作区统一行为哈希为 <code>{current_hash}</code>，状态为“{hash_status}”。fixture 仍是有价值的历史基线，但不是当前 0.14.4 的验收。44 个失败种子为：<span class="small">{failed_seed_text}</span></div>
</section>

<section id="target"><h2>3. 最值得模拟分析的目标</h2><h3>3.1 词典序主目标</h3><div class="formula">Objective = lexicographic max/min:
1. maximize N_stable
2. maximize γ_N = min over target items of stability margin
3. minimize frozen escrow + frozen debt + stalled obligations
4. minimize transport actions + cycle time + inventory oscillation
5. maximize treasury / total value only after 1–4 tie</div>
<p><code>γ_N</code> 不直接使用“累计制作最多”，而按用户的稳定标准归一化：总制作至少 3、三窗至少 2 窗活跃、末窗仍有目标产出、无连续两窗超过 50% 暴跌。最弱商品决定阶段质量，避免高产木材掩盖齿轮或金属停摆。</p>
<h3>3.2 为什么不把净剩余作为唯一目标</h3><p>中间品会被高级配方消费；要求每种中间品都出现正净剩余，会鼓励无意义囤积。正确做法是：用 gross craft 判断重复生产，用精确物料平衡与同期覆盖排除库存透支，再用终端商品净吸收衡量最终产能。</p>
<h3>3.3 三档结论</h3><div class="table-wrap"><table><thead><tr><th>等级</th><th>判定</th><th>可以声称什么</th></tr></thead><tbody><tr><td>首次制作</td><td>目标累计新增 ≥1</td><td>只证明解锁和一次可达</td></tr><tr><td>重复制作</td><td>新增 ≥3，但窗口分布或物料覆盖未通过</td><td>证明不是纯偶发，不能称稳定</td></tr><tr><td>稳定制作</td><td>完整三窗、末窗、跌幅、物料、冻结、来源和冻结操作全部通过</td><td>指定种子/版本/观察期内的有界稳定证书</td></tr></tbody></table></div></section>

<section id="metrics"><h2>4. 指标与守恒口径</h2><div class="formula">对商品 i、窗口 w：
Gᵢw = 猫自主 craft 完成量（gross craft）
Cᵢw = 作为配料被消耗量
Sᵢw = 外售、部署或不可逆流出量
Bᵢw = 玩家买入量（必须独立 provenance）
Qᵢw = 猫库存 + 自有在途 + 玩家仓库 + 可拆建筑等价库存

守恒残差 εᵢw = Q_end - Q_start - Gᵢw - Bᵢw + Cᵢw + Sᵢw
要求：所有 εᵢw = 0；玩家来源 B 永远不能计入 G。</div>
<div class="table-wrap"><table><thead><tr><th>指标组</th><th>必须记录</th><th>回答的问题</th></tr></thead><tbody>
<tr><td>生产</td><td>逐商品逐窗 craft、消费、出售、部署、库存变化</td><td>是稳定循环还是一次冲榜</td></tr><tr><td>市场</td><td>订单创建/成交/取消、保证金、报价、合同每一跳</td><td>订单为何存在、何时消失、钱卡在哪里</td></tr><tr><td>信用</td><td>现金、债务、信用上限、可用信用、峰值资金缺口</td><td>物理可行却为什么开不了工</td></tr><tr><td>物流</td><td>路径、逐跳等待、承运费、托管 WIP、边利用率</td><td>路太长、运费不足还是中转猫被占用</td></tr><tr><td>控制</td><td>全部候选、基础分、法规调整、最终选择、拒绝原因</td><td>共享法规在哪一步丢失了可行机会</td></tr><tr><td>空间</td><td>资源覆盖、猫图连通分量、最小割、建筑合法工位</td><td>地图或建筑是否形成硬约束</td></tr><tr><td>审计</td><td>共享行为/运行时哈希、配方/价格/存档版本、玩家命令账本</td><td>结果是否来自同一游戏和允许操作</td></tr>
</tbody></table></div></section>

<section id="architecture"><h2>5. 推荐模型架构</h2><div class="flow"><span>配方 DAG / Leontief</span><i>→</i><span>网络流 LP</span><i>→</i><span>有色定时 Petri 网</span><i>→</i><span>CP-SAT/MILP 排程</span><i>→</i><span>共享法规闭环</span><i>→</i><span>时间逻辑监视器</span></div>
<ol><li><b>技术层：</b><code>W_i = 1 + Σ a_ji W_j</code>，只描述内含动作数，不宣称市场价格。</li><li><b>流体层：</b>多商品网络流 LP 给出长期容量上界和影子租金。</li><li><b>离散层：</b>有色定时 Petri 网保留猫、物品、订单、合同、现金和 5 秒动作。</li><li><b>排程层：</b>时间展开整数模型回答“是否存在三窗稳定排程”。</li><li><b>控制层：</b>当前统一 DeepSeek 法规是监督器；经济门槛是不可绕过的安全约束。</li><li><b>性质层：</b>轨迹监视器执行稳定标准、守恒、来源和冻结审计。</li></ol>
<p>这套架构的价值在于定位失败层级：LP 失败是物理问题；CP-SAT 失败是离散排程问题；oracle 成功而共享法规失败是控制问题；都成功但稳定审计失败是统计/库存问题。</p></section>

<section id="matrix"><h2>6. 模拟实验矩阵</h2><div class="table-wrap"><table><thead><tr><th>实验</th><th>核心问题</th><th>对照组</th><th>指标</th><th>停止条件</th></tr></thead><tbody>{experiment_rows}</tbody></table></div></section>

<section id="controls"><h2>7. 对照组、样本设计与停止条件</h2><h3>7.1 公共种子成对比较</h3><p>任何 A/B 都在完全相同的世界种子、图纸、玩家操作和爬坡快照上分叉。二元通过率比较使用配对的 discordant seeds；连续指标报告逐种子差值，而不是比较两个独立均值。这样地图噪声不会吞掉法规或价格的真实效果。</p>
<h3>7.2 两套种子口径</h3><ul><li><b>固定 1000 面板：</b>把现有 1000 种子视为有限回归集合，报告精确通过数，不虚构抽样置信区间。</li><li><b>更广泛世界分布：</b>另抽随机种子并报告 Wilson 区间。若零失败，95% 失败率上界近似为 <code>3/n</code>；要声称低于 1% 约需 300 个零失败样本，低于 0.3% 约需 1000 个。风险阈值必须由产品先声明。</li></ul>
<h3>7.3 停止条件的严格含义</h3><ul><li><b>模拟通过：</b>完成爬坡后清零统计基线，法规和玩家操作冻结，完整观察期通过全部稳定谓词。</li><li><b>模拟失败：</b>硬审计违规可立即失败；固定验收时限内未通过记“验收失败”。</li><li><b>数学不可行：</b>必须有求解器不可行证明、可达图证明或无目标重复 SCC；超时永远只记“未决”。</li><li><b>敏感性停止：</b>分批增加设计点，直到会影响修改决策的参数排名置信区间不再交叉；不用预先拍一个固定样本数。</li><li><b>优化停止：</b>连续两轮预算增加没有新增 Pareto 非支配方案，随后仍需完整面板复验。</li></ul>
<h3>7.4 爬坡期</h3><p>用户定义的“首次完成前 N 项后清零基线”继续保留。若首次完成从不发生，则记录到达失败；若要处理初始瞬态，可用 Heidelberger–Welch 类运行长度诊断作为辅助，但不能替代游戏明确的三窗验收。</p></section>

<section id="stages"><h2>8. 从 10 到 35 的具体实验</h2><div class="table-wrap"><table><thead><tr><th>阶段</th><th>允许操作</th><th>严格目标</th><th>现有本地证据</th><th>下一步</th></tr></thead><tbody>{stage_plan_rows}</tbody></table></div>
<div class="callout info"><strong>顺序不可颠倒：</strong>先证明 10/15 的当前版本鲁棒基线，再证明 20 是软瓶颈，然后证明选择性价格只能到 22，接着证明纯价格无法稳定 30、物流法规可以稳定 30，最后才做玩家操作到 35。每阶段都从冻结快照分叉，避免前一实验污染后一实验。</div></section>

<section id="sensitivity"><h2>9. 敏感性分析与仿真优化</h2><h3>9.1 参数先筛选，再精算</h3><ol><li>将价格层级、单品价格、信用基数/净值系数、贷款率、悬赏倍率、采购摩擦、运费上限、建筑半径、土地成本、猫数和法规评分参数登记为显式输入。</li><li>用 Morris/改进 Morris 筛掉对 <code>N_stable</code>、冻结时间和最弱商品裕量几乎无影响的参数。</li><li>对高影响参数使用 Saltelli/Sobol 总效应，区分主效应和交互。例如“价格只有在信用足够时才有效”会表现为高交互而非高单因素效应。</li><li>再对高影响子空间做多目标仿真优化，输出 Pareto 前沿，不把六种后果压成一个任意权重。</li></ol>
<h3>9.2 需要保留的基准方案</h3><div class="table-wrap"><table><thead><tr><th>方案</th><th>用途</th><th>解释</th></tr></thead><tbody><tr><td>当前参数/当前法规</td><td>唯一生产基线</td><td>绑定版本和哈希</td></tr><tr><td>所有价格 ×2</td><td>尺度不变性对照</td><td>若排序不变，证明不是绝对价格级别问题</td></tr><tr><td>各时代统一倍率</td><td>粗结构价格对照</td><td>检验层级曲线而非单品</td></tr><tr><td>只调目标商品</td><td>局部价格因果</td><td>检查是否造成上游饥饿</td></tr><tr><td>只改法规评分</td><td>控制器因果</td><td>经济参数完全不动</td></tr><tr><td>只改信用/物流/建筑</td><td>结构消融</td><td>定位非价格瓶颈</td></tr><tr><td>oracle 排程</td><td>可实现上界</td><td>不属于玩家验收</td></tr></tbody></table></div></section>

<section id="mapping"><h2>10. 模拟结果如何决定改哪里</h2><div class="table-wrap"><table><thead><tr><th>观测结果</th><th>诊断</th><th>修改位置</th><th>行动</th></tr></thead><tbody>{decision_rows}</tbody></table></div>
<div class="callout"><strong>最重要的决策规则：</strong>先找到失败发生在哪一层，再改该层。价格、法规、物流、信用、建筑和地图不是可互换的六个旋钮；用错旋钮往往能制造一次新品，却不能形成稳定循环。</div></section>

<section id="parameter"><h2>11. 每类参数怎样从模型中定量</h2><h3>11.1 价格</h3><div class="formula">临界不亏价：Pᵢ* = Σ qⱼ · liquidation(j) + craft opportunity cost
                    + expected transport + financing + site scarcity rent
若要求整数分下严格优于替代动作：Pᵢ ≥ ceil(Pᵢ*) + 1 分</div><p>“+1 分”来自整数货币下制造严格偏好的最小离散差，不是百分比。当前目录的 <code>12%</code> 最低加价、分层 premium 和价格 floor 都应作为待检验参数；不能因为写进目录就反向称为理论常数。</p>
<h3>11.2 信用</h3><div class="formula">K_s*(N) = max over time t [active escrow + committed input payments
                               - liquid cash - admissible collateral]</div><p>对每个种子先用可行排程求峰值资金缺口 <code>K_s*</code>。若目标是固定 1000 面板全部通过，信用至少覆盖该面板的最大值；若目标是指定分位风险，则取对应经验分位。这样 2500、5000 或 12500 分都不再是拍出来的。</p>
<h3>11.3 悬赏</h3><p>一次性悬赏的最低有效值是“完成该商品的保守总损失 + 1 分”。如果商品自身已盈利，悬赏只用于首次探索；长期稳定不能依赖一次性奖金，所以观察期必须在悬赏支付后继续。</p>
<h3>11.4 运费与物流容量</h3><p>中转猫的最低运费应覆盖该跳期间最佳可执行替代动作的机会收益；若要严格接受，再加 1 分。合同槽数和猫链数量则由目标吞吐下的边流量决定。使用 Little 定律 <code>L = λW</code>：若 W 高而 λ 不高，问题是等待；若 λ 已贴近容量，问题是工位/边容量。</p>
<h3>11.5 建筑半径</h3><p>对每种建筑计算半径 r 下的合法生产工位集合和目标物流成本。选择满足既定种子成功目标的最小 r；如果 r 增大不改善可行性，原因是供应链或猫图，不再继续扩大范围。</p>
<h3>11.6 地图</h3><p>把猫链视为顶点容量图、相邻运输视为边。记录资源到目标工位的最小割、边介数和 LP 容量租金。如果失败种子的最小割为 1 且同一资源猫持续绑定，应增加路径冗余/资源覆盖或改善放猫引导；不要靠高价让单点瓶颈“更努力”。</p>
<h3>11.7 法规</h3><p>仅当候选行为物理合法、经济非负但未被选中时修改法规。所需调整量应等于“目标候选分数与当前赢家分数的差 + 最小可表示增量”，并在公共种子上验证是否引发其他商品饥饿。每次 DeepSeek 只新增一条统一程序，行为文件哈希不得改变。</p></section>

<section id="compute"><h2>12. 5090_Lian 上的执行方案</h2><div class="cards"><div class="card"><b>128</b><span>逻辑 CPU</span></div><div class="card"><b>503 GiB</b><span>本地记录内存</span></div><div class="card"><b>96</b><span>已有 CPU 进程基线</span></div><div class="card"><b>1.255 s</b><span>4000 个 LP 实测墙钟</span></div></div>
<ol><li><b>确定性事件模拟：</b>按种子多进程，沿用已经验证的 96 进程起点；以实际吞吐而非 CPU 标称数决定是否增减。</li><li><b>LP：</b>继续 96 进程即可，已有 4000 解的数值与性能基线。</li><li><b>CP-SAT/MILP：</b>先在同一代表种子集上测试每个求解 1/2/4/8 线程，令“并发求解数 × 每解线程数”不超过已验证的 96 线程预算，选择单位墙钟完成证书数最多的配置。</li><li><b>GPU：</b>本问题主要是分支密集的离散事件和整数求解，5090 不会自然加速；只有将来训练代理模型时才考虑 GPU。</li><li><b>分片：</b>输出每个种子独立 JSON，带输入哈希；最后只聚合完整分片。中断可续跑，不覆盖已完成证书。</li></ol>
<h3>推荐执行顺序</h3><div class="flow"><span>当前哈希 1000 种子 10/15</span><i>→</i><span>44 失败种子消融</span><i>→</i><span>20/22 成对实验</span><i>→</i><span>30 的 CP-SAT 与物流法规</span><i>→</i><span>35 玩家账本</span><i>→</i><span>完整鲁棒性面板</span></div></section>

<section id="audit"><h2>13. 审计与可复现要求</h2><ul><li>每个实验清单写入：Git 工作树摘要、目录版本、难度、世界种子、存档 schema、共享行为哈希、运行时哈希、法规源码哈希和解释器限制。</li><li>玩家命令只经公开 facade；任何直接修改猫库存、制作统计、金币、配方、建筑、世界或共享行为文件都使整次验收失败。</li><li>oracle、无限信用、零运输等只允许出现在标为 <span class="tag">诊断对照</span> 的分支中，永远不进入玩家通关结果。</li><li>DeepSeek 请求与返回保存脱敏哈希、编译结果、AST 节点/深度/字节数、测试结果；不保存或展示密钥。</li><li>每次观察期内法规、价格和玩家操作不变；中途改法或交易则从新快照重新爬坡、清零基线。</li><li>报告同时给首次、重复、稳定三档，不把 discovery 或累计产量写成稳定。</li></ul>
<h3>本报告读取的本地产物</h3><ul><li><code>output/price-theory-results.json</code> · SHA-256 <code>{sha256(PRICE_RESULTS)}</code></li><li><code>output/price-model-summary.json</code> · SHA-256 <code>{sha256(PRICE_MODEL_RESULTS)}</code></li><li><code>output/deepseek-to-35-headless.json</code> · SHA-256 <code>{sha256(PROGRESSION_RESULTS)}</code></li><li><code>src/game/lawProgram.ts</code> · SHA-256 <code>{sha256(LAW_PROGRAM)}</code></li></ul></section>

<section id="limits"><h2>14. 当前缺口与不应过度声称的内容</h2><ul><li>当前严格稳定机器证据只到 22，且来自 fixture；30/35 没有当前版本证书。</li><li>现有 LP 只覆盖前 10/15 和初始世界；尚未对 20/22/30/35、建筑放置和信用约束做完整时间展开。</li><li>价格模型的 956/1000 与后续小面板测试并非同一证据版本；在当前行为哈希下重跑前不能说问题已经消失。</li><li>现有稳定报告统计 gross craft；虽然已有库存覆盖检查，仍应升级为逐事件精确物料守恒和完整 provenance。</li><li>DeepSeek 真实调用的可用性与法规质量是另一实验层；本报告没有调用模型，也没有声称真实模型已经完成 35。</li><li>没有随机故障和随机产量时，不需要把游戏强行写成 MDP；种子差异是参数不确定性，优先用鲁棒优化和成对实验。</li></ul>
<div class="callout warn"><strong>当前最可信的下一步：</strong>冻结当前 <code>{current_hash}</code>，对固定 1000 种子重跑 10/15；对历史 44 个 stalled-contract 种子做 E5/E6 消融。这个实验会直接告诉我们下一次应该改信用、物流还是统一法规，而不是再猜一条价格曲线。</div></section>

<section id="sources"><h2>15. 调研资料</h2>{source_html}<p class="small">文献元数据通过 Crossref/OpenAlex 和 DOI 落地页复核；模型在本项目中的适用性判断由本地源码、LP 证书和稳定轨迹映射得出。报告日期：2026-08-04。本轮未修改价格、法规、物流、信用、建筑、地图或游戏状态，也未调用真实 DeepSeek。</p></section>
</main></div></body></html>"""


OUTPUT.write_text(document, encoding="utf-8")
print(json.dumps({
    "output": str(OUTPUT),
    "bytes": OUTPUT.stat().st_size,
    "sections": 15,
    "sources": len(sources),
    "fixtureBehaviorHash": fixture_hash,
    "currentBehaviorHash": current_hash,
    "hashesMatch": fixture_hash == current_hash,
}, ensure_ascii=False, indent=2))
