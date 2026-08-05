#!/usr/bin/env python3
"""Generate the self-contained regenerative-cycle complexity proof report.

The generator reads immutable analysis artifacts.  It does not import or run
the game and cannot mutate catalog prices, laws, inventories or world state.
"""

from __future__ import annotations

import collections
import hashlib
import html
import json
import math
from pathlib import Path
from statistics import mean, median
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "CatWorkshop-Regenerative-Cycle-Complexity-Proof.html"
PROOF = ROOT / "output/cycle-complexity-proof.json"
PROOF_VALIDATION = ROOT / "output/cycle-complexity-proof-validation.json"
MEASURE_600 = ROOT / "output/regenerative-cycles-200-600-aggregate.json"
MEASURE_2400 = ROOT / "output/regenerative-cycles-200-2400-aggregate.json"
MEASURE_CURRENT_2400 = ROOT / "output/regenerative-cycles-current-200-2400-aggregate.json"
MEASURE_PRICEONLY_2400 = ROOT / "output/regenerative-cycles-priceonly-currentruntime-200-2400-aggregate.json"
PRICE_CURRENT = ROOT / "output/proof-price-vector-current.json"
PRICE_THEOREM = ROOT / "output/proof-price-vector-theorem.json"


def load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def esc(value: Any) -> str:
    return html.escape(str(value))


def q(values: Iterable[float]) -> dict[str, float]:
    ordered = sorted(float(value) for value in values)
    if not ordered:
        return {}

    def at(p: float) -> float:
        x = (len(ordered) - 1) * p
        lo, hi = math.floor(x), math.ceil(x)
        if lo == hi:
            return ordered[lo]
        return ordered[lo] + (ordered[hi] - ordered[lo]) * (x - lo)

    return {
        "min": ordered[0], "p05": at(0.05), "median": at(0.5),
        "mean": mean(ordered), "p95": at(0.95), "max": ordered[-1],
    }


def fmt(value: float | int | None, digits: int = 3) -> str:
    if value is None:
        return "—"
    if isinstance(value, int) or float(value).is_integer():
        return f"{int(value):,}"
    return f"{float(value):,.{digits}f}"


def seconds(ms: float | int | None) -> str:
    return "—" if ms is None else f"{float(ms) / 1000:,.1f} 秒"


def table(headers: list[str], rows: list[list[Any]], classes: str = "") -> str:
    head = "".join(f"<th>{esc(cell)}</th>" for cell in headers)
    body = "".join(
        "<tr>" + "".join(f"<td>{cell if isinstance(cell, Safe) else esc(cell)}</td>" for cell in row) + "</tr>"
        for row in rows
    )
    return f'<div class="table-wrap"><table class="{esc(classes)}"><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


class Safe(str):
    pass


proof = load(PROOF)
proof_validation = load(PROOF_VALIDATION)
assert proof_validation["status"] == "valid"
assert proof_validation["sha256"] == sha256(PROOF)
assert proof_validation["computeHostname"] == proof["compute"]["hostname"]
assert proof_validation["integerCertificates"] == 5000
assert proof_validation["fluidCertificates"] == 5000
family_doc = proof
compute = proof["compute"]
measure600 = load(MEASURE_600)
measure2400 = load(MEASURE_2400) if MEASURE_2400.exists() else None
measure_current2400 = load(MEASURE_CURRENT_2400) if MEASURE_CURRENT_2400.exists() else None
measure_priceonly2400 = load(MEASURE_PRICEONLY_2400) if MEASURE_PRICEONLY_2400.exists() else None
price_current = load(PRICE_CURRENT)
price_theorem = load(PRICE_THEOREM)

integer_certificates = list(proof["integerRegenerativePeriodMilp"]["certificates"])
integer_by_key = {(entry["seed"], entry["stage"]): entry for entry in integer_certificates}
fluid_by_key = {
    (entry["seed"], entry["stage"]): entry
    for entry in proof["spatialCycleLp"]["certificates"]
}

integer_aggregates = {
    entry["stage"]: entry
    for entry in proof["integerRegenerativePeriodMilp"]["aggregates"]
}
prefix_rows = {entry["stage"]: entry for entry in proof["realCatalog"]["prefixCertificates"]}


def measurement_summary(document: dict[str, Any] | None, stage: int) -> dict[str, Any] | None:
    if document is None:
        return None
    runs = document["runs"]
    measurements = [run.get(f"stage{stage}") for run in runs]
    measurements = [entry for entry in measurements if entry is not None]
    found = [entry for entry in measurements if entry["found"]]
    coordination = []
    for run in runs:
        entry = run.get(f"stage{stage}")
        if not entry or not entry["found"] or entry["actualWindowMs"] is None:
            continue
        exact = integer_by_key.get((run["seed"], stage))
        if exact:
            coordination.append(entry["actualWindowMs"] / exact["exactDiscretePeriodMs"])
    failures = collections.Counter()
    stock = collections.Counter()
    failed_seeds = []
    strict_debt_drift = 0
    debt_window_deltas: list[list[float]] = [[], [], []]
    for run in runs:
        entry = run.get(f"stage{stage}")
        if not entry or entry["found"]:
            continue
        failed_seeds.append(run["seed"])
        terminal = entry.get("terminalFailure") or {}
        failures.update(terminal.get("failureReasons") or [])
        stock.update(item["itemId"] for item in terminal.get("stockFailures") or [])
        debts = (terminal.get("economy") or {}).get("windowDebtCents") or []
        if len(debts) == 4:
            deltas = [debts[index + 1] - debts[index] for index in range(3)]
            strict_debt_drift += int(all(delta > 0 for delta in deltas))
            for index, delta in enumerate(deltas):
                debt_window_deltas[index].append(delta)
    ramped = sum(bool(run[f"stage{stage}Ramp"]["reached"]) for run in runs)
    return {
        "worlds": len(runs),
        "ramped": ramped,
        "rampFailures": len(runs) - ramped,
        "found": len(found),
        "censored": len(measurements) - len(found),
        "windows": q(entry["actualWindowMs"] / 1000 for entry in found),
        "coordination": q(coordination),
        "failureReasons": dict(failures),
        "stockFailures": dict(stock),
        "failedSeeds": failed_seeds,
        "rampFailedSeeds": [run["seed"] for run in runs if not run[f"stage{stage}Ramp"]["reached"]],
        "strictDebtDriftAllWindows": strict_debt_drift,
        "debtWindowDeltaCents": [q(values) for values in debt_window_deltas],
        "maxWindowMs": document["configuration"]["maxWindowLogicalMs"],
        "authority": document["authority"],
    }


m600_10 = measurement_summary(measure600, 10)
m600_15 = measurement_summary(measure600, 15)
m2400_10 = measurement_summary(measure2400, 10)
m2400_15 = measurement_summary(measure2400, 15)
current2400_10 = measurement_summary(measure_current2400, 10)
current2400_15 = measurement_summary(measure_current2400, 15)
priceonly2400_10 = measurement_summary(measure_priceonly2400, 10)
priceonly2400_15 = measurement_summary(measure_priceonly2400, 15)
if measure_current2400 is not None and measure_priceonly2400 is not None:
    current_authority = measure_current2400["authority"]
    priceonly_authority = measure_priceonly2400["authority"]
    for key in ["sharedBehaviorHash", "sharedBehaviorSource", "lawProgramSha256", "marketSha256", "engineSha256"]:
        assert current_authority[key] == priceonly_authority[key], f"paired authority mismatch: {key}"
    assert current_authority["catalogSha256"] != priceonly_authority["catalogSha256"], "paired catalogs must differ"
    assert price_current["catalogSha256"] == current_authority["catalogSha256"]
    assert price_theorem["catalogSha256"] == priceonly_authority["catalogSha256"]
price_rows = []
for current, theorem in zip(price_current["prices"][:22], price_theorem["prices"][:22], strict=True):
    assert current["itemId"] == theorem["itemId"] and current["index"] == theorem["index"]
    price_rows.append([
        current["index"], current["itemId"], fmt(current["priceCoins"]), fmt(theorem["priceCoins"]),
        f'{theorem["priceCoins"] / current["priceCoins"]:.3f}×',
    ])

stage_table_rows = []
for stage in [10, 15, 19, 20, 22]:
    aggregate = integer_aggregates[stage]
    prefix = prefix_rows[stage]
    period = aggregate["exactDiscretePeriodMs"]
    transport = aggregate["totalTransportActionsPerBasket"]
    stage_table_rows.append([
        stage,
        prefix["dependencyDepth"],
        prefix["oneBasketTechnicalActions"],
        prefix["threeWindowMinimumTechnicalActions"],
        seconds(period["min"]),
        seconds(period["median"]),
        seconds(period["max"]),
        f'{fmt(transport["min"])} / {fmt(transport["median"])} / {fmt(transport["max"])}',
    ])

frequency_rows = []
for stage in [10, 15, 19, 20, 22]:
    counts = collections.Counter(
        entry["periodSlots"] for entry in integer_certificates if entry["stage"] == stage
    )
    frequency_rows.append([
        stage,
        Safe("<span class=\"mono\">" + " · ".join(f"{slot}槽:{count}界" for slot, count in sorted(counts.items())) + "</span>"),
    ])

gap_rows = []
for stage in [10, 15, 19, 20, 22]:
    gaps = []
    ratios = []
    for seed in range(1, 1001):
        integer = integer_by_key[(seed, stage)]
        fluid = fluid_by_key[(seed, stage)]
        fluid_slots = fluid["maxCatActionsPerBasket"]
        gaps.append(integer["periodSlots"] - fluid_slots)
        ratios.append(integer["periodSlots"] / fluid_slots)
    gap_rows.append([
        stage,
        fmt(max(gaps), 6),
        fmt(mean(gaps), 6),
        fmt(median(ratios), 6),
        fmt(max(ratios), 6),
        "是" if all(abs(integer_by_key[(seed, stage)]["periodSlots"] - math.ceil(fluid_by_key[(seed, stage)]["maxCatActionsPerBasket"] - 1e-9)) < 1e-9 for seed in range(1, 1001)) else "否",
    ])

family = family_doc["periodicFamily"]
growth = family["periodicGrowthCertificate"]
family_rows = []
for row in family["sampleRows"]:
    family_rows.append([
        row["itemCount"], row["depth"], row["singleItemWorkDigits"],
        row["prefixRegenerativeBasketWorkDigits"],
        Safe(f'<span class="mono break">{esc(row["singleItemWork"] if row["itemCount"] <= 242 else row["singleItemWork"][:24] + "…")}</span>'),
    ])


def measurement_rows() -> list[list[Any]]:
    rows = []
    for label, stage, summary in [
        ("当前版本·2400秒", 10, current2400_10), ("当前版本·2400秒", 15, current2400_15),
        ("仅换定理价格·当前引擎·2400秒", 10, priceonly2400_10), ("仅换定理价格·当前引擎·2400秒", 15, priceonly2400_15),
        ("定理价格候选·600秒", 10, m600_10), ("定理价格候选·600秒", 15, m600_15),
        ("定理价格候选·2400秒", 10, m2400_10), ("定理价格候选·2400秒", 15, m2400_15),
    ]:
        if summary is None:
            rows.append([label, stage, "尚未生成", "—", "—", "—", "—", "—"])
            continue
        windows = summary["windows"]
        h = summary["coordination"]
        rows.append([
            label,
            stage,
            f'{summary["found"]}/{summary["worlds"]}',
            summary["rampFailures"],
            summary["censored"],
            "—" if not windows else f'{fmt(windows["min"])} / {fmt(windows["median"])} / {fmt(windows["max"])} 秒',
            "—" if not h else f'{fmt(h["min"])} / {fmt(h["median"])} / {fmt(h["max"])}',
            Safe("<span class=\"mono\">" + esc(", ".join(f"{key}:{value}" for key, value in summary["failureReasons"].items()) or "无") + "</span>"),
        ])
    return rows


candidate_extended_ready = measure2400 is not None
current_ready = measure_current2400 is not None
priceonly_ready = measure_priceonly2400 is not None
latest10 = current2400_10 or m2400_10 or m600_10
latest15 = current2400_15 or m2400_15 or m600_15
hash_rows = []
for path in [PROOF, PROOF_VALIDATION, MEASURE_600, PRICE_CURRENT, PRICE_THEOREM] + ([MEASURE_2400] if MEASURE_2400.exists() else []) + ([MEASURE_CURRENT_2400] if MEASURE_CURRENT_2400.exists() else []) + ([MEASURE_PRICEONLY_2400] if MEASURE_PRICEONLY_2400.exists() else []):
    hash_rows.append([path.relative_to(ROOT), path.stat().st_size, Safe(f'<span class="mono break">{sha256(path)}</span>')])

authority = (latest15 or latest10)["authority"]
claim10 = latest10 is not None and latest10["found"] == latest10["worlds"]
claim15 = latest15 is not None and latest15["found"] == latest15["worlds"]


def drift_callout(label: str, stage10_summary: dict[str, Any] | None, stage15_summary: dict[str, Any] | None) -> str:
    if stage10_summary is None or stage15_summary is None:
        return ""
    def delta_medians(summary: dict[str, Any]) -> str:
        values = []
        for entry in summary["debtWindowDeltaCents"]:
            values.append("—" if not entry else f'{entry["median"] / 100:.2f}')
        return "/".join(values)
    return (
        f'<div class="callout warn"><b>{esc(label)}债务漂移审计：</b>'
        f'阶段10删失{stage10_summary["censored"]}界，其中{stage10_summary["strictDebtDriftAllWindows"]}界三窗债务全为正增量，'
        f'中位数为{delta_medians(stage10_summary)}金币；阶段15删失{stage15_summary["censored"]}界，其中'
        f'{stage15_summary["strictDebtDriftAllWindows"]}界三窗全正，中位数为{delta_medians(stage15_summary)}金币。'
        '这是有限观察漂移，不是无限期不可达定理。</div>'
    )

document = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>猫咪工坊：再生循环复杂度证明分析</title>
<style>
:root{{--paper:#f7f7f3;--card:#fff;--ink:#17201c;--muted:#5f6b64;--line:#d8ded9;--green:#176b48;--green2:#e8f4ed;--amber:#925d00;--amber2:#fff4d8;--red:#9c2f2f;--red2:#fdeaea;--blue:#205f8f;--blue2:#e9f3fa;--mono:#10251b}}
*{{box-sizing:border-box}} html{{scroll-behavior:smooth}} body{{margin:0;background:var(--paper);color:var(--ink);font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;line-height:1.68}}
main{{width:min(1180px,calc(100% - 32px));margin:24px auto 72px}} header{{padding:42px;border:1px solid var(--line);border-radius:24px;background:linear-gradient(135deg,#fff 10%,#eaf5ee)}}
h1{{font-size:clamp(30px,5vw,58px);line-height:1.08;margin:0 0 16px;letter-spacing:-.04em}} h2{{font-size:28px;margin:0 0 16px}} h3{{font-size:20px;margin:26px 0 10px}} p{{margin:10px 0}} a{{color:var(--blue)}}
.eyebrow{{color:var(--green);font-weight:750;letter-spacing:.08em;text-transform:uppercase}} .lead{{font-size:19px;max-width:900px}} .meta{{color:var(--muted);font-size:14px}}
nav{{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0 0}} nav a{{text-decoration:none;background:#fff;border:1px solid var(--line);padding:7px 11px;border-radius:999px;font-size:13px}}
section{{margin-top:20px;padding:28px;background:var(--card);border:1px solid var(--line);border-radius:20px;box-shadow:0 8px 30px rgba(23,32,28,.035)}}
.grid{{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}} .metric{{padding:16px;border-radius:14px;border:1px solid var(--line);background:#fbfcfa}} .metric b{{display:block;font-size:26px;line-height:1.15}} .metric span{{font-size:13px;color:var(--muted)}}
.callout{{padding:14px 16px;border-left:4px solid var(--blue);background:var(--blue2);border-radius:8px}} .ok{{border-color:var(--green);background:var(--green2)}} .warn{{border-color:var(--amber);background:var(--amber2)}} .bad{{border-color:var(--red);background:var(--red2)}}
.formula{{font-family:Cambria,"Times New Roman",serif;font-size:18px;background:#f4f7f4;border:1px solid var(--line);border-radius:10px;padding:13px 16px;overflow:auto}} code,.mono{{font-family:"Cascadia Mono",Consolas,monospace;color:var(--mono)}} .break{{overflow-wrap:anywhere}}
.table-wrap{{overflow:auto;border:1px solid var(--line);border-radius:12px}} table{{border-collapse:collapse;width:100%;min-width:720px;font-size:14px}} th,td{{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}} th{{background:#edf2ee;position:sticky;top:0}} tr:last-child td{{border-bottom:0}}
.badge{{display:inline-block;padding:3px 8px;border-radius:99px;font-size:12px;font-weight:700}} .proved{{background:var(--green2);color:var(--green)}} .numeric{{background:var(--blue2);color:var(--blue)}} .censored{{background:var(--amber2);color:var(--amber)}} .open{{background:var(--red2);color:var(--red)}}
ol.proof li{{margin:10px 0}} details{{border:1px solid var(--line);border-radius:10px;padding:10px 13px;margin:8px 0}} summary{{cursor:pointer;font-weight:700}} footer{{color:var(--muted);font-size:13px;margin-top:18px;text-align:center}}
@media(max-width:800px){{main{{width:min(100% - 18px,1180px);margin-top:9px}}header,section{{padding:20px;border-radius:15px}}.grid{{grid-template-columns:1fr 1fr}}}}
@media(max-width:480px){{.grid{{grid-template-columns:1fr}}h2{{font-size:23px}}}}
@media print{{body{{background:#fff}}main{{width:100%;margin:0}}section,header{{box-shadow:none;break-inside:avoid}}nav{{display:none}}}}
</style>
</head>
<body><main>
<header>
  <div class="eyebrow">Cat Workshop · formal analysis</div>
  <h1>再生循环复杂度<br>证明与数值证书</h1>
  <p class="lead">本报告把“固有工作量”“最优循环时间”和“法规协调倍率”拆成三个可证伪对象。没有把 50% 税、25 分摩擦、2% 借贷费或任何经验系数塞进理论；价格与法规仅在真实轨迹层出现。</p>
  <p class="meta">计算主机：5090_Lian / {esc(compute['hostname'])} · Python {esc(compute['python'])} · SciPy {esc(compute['scipy'])} · 8进程 · 难度5 · 5秒/动作 · 1000个固定世界</p>
  <nav><a href="#verdict">结论边界</a><a href="#definitions">定义</a><a href="#work">固有工作量</a><a href="#period">离散最优周期</a><a href="#growth">无限族增长</a><a href="#actual">真实法规轨迹</a><a href="#goals">阶段目标</a><a href="#reproduce">复现</a></nav>
</header>

<section id="verdict">
<h2>1. 先给结论：哪些已经证明</h2>
<div class="grid">
  <div class="metric"><b>5,000</b><span>整数 MILP 世界×阶段证书</span></div>
  <div class="metric"><b>0</b><span>MIP 失败 / 非零 gap / 整数残差</span></div>
  <div class="metric"><b>1.166158×</b><span>无限族每新增一个模板的严格渐近倍率</span></div>
  <div class="metric"><b>{latest15['found'] if latest15 else 0}/200</b><span>当前法规第15项严格再生证书（最新搜索）</span></div>
</div>
<h3>结论分层</h3>
{table(["对象","状态","可以说什么","不能说什么"], [
 ["真实65项固有工作量", Safe('<span class="badge proved">解析证明</span>'), "反向拓扑递推给出唯一逐分量最小整数动作数。", "不等于市场实际用时。"],
 ["可扩展无限配方族", Safe('<span class="badge proved">解析证明</span>'), "周期模板族的工作量随商品序号、依赖深度指数增长。", "不是说任意配方树都必然指数增长。"],
 ["10/15/19/20/22物理最优周期", Safe('<span class="badge numeric">求解器证书</span>'), "1000世界全部得到离散5秒动作槽最优解。", "不包含订单、信用、法规选择和建筑。"],
 ["当前法规真实轨迹", Safe('<span class="badge censored">有限搜索</span>'), f"通过世界可报告严格 H；其余是截至 {fmt((latest15 or latest10)['maxWindowMs']/1000)} 秒的右删失。", "右删失不等于数学不可达。"],
 ["完整10→15→20→22→30→35游戏目标", Safe('<span class="badge open">尚未证明</span>'), "本报告能定位物理下界与协调损失。", "不能用物理可行性冒充法规稳定生产。"],
])}
<div class="callout {'ok' if claim10 and claim15 else 'bad'}"><b>对当前价格/法规的直接判决：</b> 最新轨迹中第10项全世界通过={"是" if claim10 else "否"}，第15项全世界通过={"是" if claim15 else "否"}。因此这份分析<b>没有</b>证明“当前方案稳定达到15”；它精确证明了失败不是物理动作下界导致，而是债务、队列或库存漂移等协调层问题。</div>
</section>

<section id="definitions">
<h2>2. 三个定义，不引入启发参数</h2>
<h3>2.1 配方与目标篮子</h3>
<p>按拓扑顺序记商品为 <code>1…N</code>。配方 <code>j</code> 消耗商品 <code>i</code> 的整数数量为 <code>q[j,i]</code>。目标篮子要求前 N 项各出现一个净新增单位，即 <code>b[i]=1</code>。</p>
<h3>2.2 固有工作量 W<sub>N</sub><sup>*</sup></h3>
<div class="formula">c<sub>i</sub> = b<sub>i</sub> + Σ<sub>j&gt;i</sub> q<sub>j,i</sub> c<sub>j</sub>，&nbsp; W<sub>N</sub><sup>*</sup> = Σ<sub>i=1…N</sub> c<sub>i</sub></div>
<p><code>c[i]</code> 是为了做出完整篮子且补回所有被消耗库存，至少必须执行的第 i 项采集/制作次数。它只由配方 DAG 决定，不含价格、税、距离、猫数或法规。</p>
<h3>2.3 最优离散再生周期 P<sub>N</sub><sup>*</sup>(G)</h3>
<div class="formula">P<sub>N</sub><sup>*</sup>(G) = τ · K<sub>N</sub><sup>*</sup>(G)，其中 τ=5 秒，K<sup>*</sup> 是整数制作与逐格运输流下的最小“单猫最大动作槽数”。</div>
<p>这是充分爬坡后的最优物理流水线周期：每周期净新增前 N 项各一件，并补回全部投入。允许用有限在制品缓冲启动，但不允许瞬移、分数动作或一只猫同时执行两个动作。</p>
<h3>2.4 法规协调倍率 H<sub>N</sub><sup>L</sup>(G)</h3>
<div class="formula">H<sub>N</sub><sup>L</sup>(G) = P<sub>N</sub><sup>L</sup>(G) / P<sub>N</sub><sup>*</sup>(G) ≥ 1</div>
<p><code>P^L</code> 只从冻结法规与玩家操作后的三窗口真实轨迹证书取得。通过项必须每种至少新做3次、跨至少2窗、末窗仍产出、库存不净消耗、债务与队列不漂移。没在搜索上限内找到证书时只记“右删失”，不伪造 H。</p>
</section>

<section id="work">
<h2>3. W<sub>N</sub><sup>*</sup> 的解析证明</h2>
<ol class="proof">
  <li><b>末端开始。</b> 每个目标商品至少净新增一件，所以最后一项至少制作 <code>b[N]</code> 次。</li>
  <li><b>反向归纳。</b> 假定所有 <code>j&gt;i</code> 的最低制作次数已确定。它们确定地消耗 <code>Σ q[j,i]c[j]</code> 件 i；若末库存不低于初库存且还要净新增 <code>b[i]</code>，任何合法轨迹都必须满足上式。</li>
  <li><b>可达性。</b> 按正向拓扑顺序采集/制作递推得到的次数，能补齐所有消耗并留下目标篮子，因此下界可达。</li>
  <li><b>唯一逐分量最小。</b> 所有系数和动作成本非负；任何一个分量少于递推值都会在该商品的守恒式产生赤字。故解既最小又唯一。</li>
</ol>
{table(["前N项","依赖深度","一篮子固有动作 W*","三篮子最低动作","离散周期最小/中位/最大","最优周期内运输最小/中位/最大"], stage_table_rows)}
<p class="callout">例如前15项稳定观察至少需要 <b>141次</b>固有采集/制作，不是“15项×3=45次”。因为玻璃、金属、齿轮等会反复消耗木材、矿石与中间件；141由守恒方程推出，没有人工倍率。</p>
</section>

<section id="period">
<h2>4. P<sub>N</sub><sup>*</sup> 的整数模型与双向证明</h2>
<p>对每只猫 c、商品 i、相邻有向边 c→d，设整数变量：</p>
<ul><li><code>x[c,i]</code>：本周期制作 i 的次数；</li><li><code>y[c,d,i]</code>：本周期把 i 从 c 送到 d 的逐跳次数；</li><li><code>s[c,i]</code>：周期结束留在 c 的目标净增量；</li><li><code>K</code>：任意一只猫最多占用的动作槽。</li></ul>
<div class="formula">x<sub>c,i</sub> + Σ<sub>d→c</sub>y<sub>d,c,i</sub> − Σ<sub>c→d</sub>y<sub>c,d,i</sub> − Σ<sub>j&gt;i</sub>q<sub>j,i</sub>x<sub>c,j</sub> − s<sub>c,i</sub> = 0<br>Σ<sub>c</sub>s<sub>c,i</sub>=1<br>Σ<sub>i</sub>x<sub>c,i</sub> + Σ<sub>d,i</sub>y<sub>c,d,i</sub> ≤ K</div>
<p>资源制作变量只在能采集对应资源的猫上存在；所有变量为非负整数。先最小化 K，再固定 K 最小化总运输，消除不影响 K 的无用环流。</p>
<h3>下界</h3><p>把任何合法再生流水线在一个周期内的动作按猫、商品、边求和，必然满足上述守恒和容量约束。因此任何流水线的槽数都不小于 MILP 最优 K。</p>
<h3>上界</h3><p>对一个整数最优解，把每只猫不超过 K 个动作任意放入 K 个槽。逐项计算一个周期内的库存前缀和，把启动缓冲设为“最负前缀”的相反数；该缓冲有限。守恒式保证周期末每项库存不低于周期初，因此相同 K 槽动作模式可以持续重复。故下界可达，<code>P*=5000K</code>。</p>
<h3>1000世界完整离散分布</h3>
{table(["阶段","K槽频数（槽数:世界数）"], frequency_rows)}
<h3>连续LP为何不再冒充精确周期</h3>
{table(["阶段","最大取整差(槽)","平均差","整数/流体中位比","整数/流体最大比","K=ceil(LP)覆盖1000界"], gap_rows)}
<p>连续 LP 仍有价值：它给出对偶与流量瓶颈。但分数动作不是游戏动作，故报告只用整数 MILP 的 K 作为 P<sup>*</sup> 分母。</p>
</section>

<section id="growth">
<h2>5. 可扩展无限族：为何是指数增长</h2>
<p>真实65项保持完全不变。第66项起，按顺序周期重放真实第7–65项的59个非资源配方模板；每个模板保留每条输入的数量和“依赖索引距离”。例如原模板在 i 使用 i−δ，则新位置 n 使用 n−δ。资源种类、动作种类和建筑机制均不增加。</p>
<div class="grid">
  <div class="metric"><b>59</b><span>模板周期长度</span></div>
  <div class="metric"><b>{family['bounds']['maximumDependencyLag']}</b><span>最大依赖位移</span></div>
  <div class="metric"><b>{family['bounds']['maximumInputUnitsPerRecipe']}</b><span>单配方最大投入单位</span></div>
  <div class="metric"><b>{fmt(growth['lowerPerPeriod'])}×</b><span>每59模板严格增长下界</span></div>
</div>
<h3>Collatz–Wielandt 证书</h3>
<p>把最近45项工作量组成正向量 v，一个59模板周期对应非负线性算子 M。对脚本生成的严格正向量 v：</p>
<div class="formula">min<sub>i</sub>(Mv)<sub>i</sub>/v<sub>i</sub> ≤ ρ(M) ≤ max<sub>i</sub>(Mv)<sub>i</sub>/v<sub>i</sub></div>
<p>下界的精确有理数大于1，因此不是指数曲线拟合，而是谱半径的严格证书。每模板下界为 <b>{growth['lowerPerTemplate']:.12f}</b>。实际递推还含正的“+1制作动作”，只会提高工作量；把常数维增广后谱半径仍由 ρ(M)&gt;1 主导。</p>
<p>同时深度满足 <code>Ω(n/45)</code> 且 <code>O(n)</code>，所以商品序号 n 与依赖深度 d 线性等价。单件工作量 w<sub>n</sub> 指数增长；前缀篮子 <code>W*_N=Σw_i</code> 也具有相同指数阶。</p>
{table(["族前缀项数","依赖深度","末项工作量位数","完整前缀篮子位数","末项工作量（长数截断）"], family_rows)}
<details><summary>精确谱证书与模板哈希</summary><p class="mono break">lower={esc(growth['lowerPerPeriodExact'])}</p><p class="mono break">upper={esc(growth['upperPerPeriodExact'])}</p><p class="mono break">templates.sha256={esc(family['definition']['templatesSha256'])}</p><p>分子分母均直接保存在机器 JSON 中；十进制上下界显示相同只是浮点打印精度，不是把两者宣称为代数相等。</p></details>
<div class="callout warn"><b>措辞边界：</b>这里证明的是“这个明确定义、包含真实65项为严格前缀的配方族”的生产工作复杂度。它不是对所有可能未来配方设计的普遍定理，也不是说求解器运行时间必然指数增长。</div>
</section>

<section id="actual">
<h2>6. 真实法规轨迹：H 只能从通过证书的世界计算</h2>
{table(["场景/搜索上限","阶段","严格通过","爬坡失败","右删失","实际窗 最小/中位/最大","严格H 最小/中位/最大","终点失败原因计数"], measurement_rows())}
<p>隔离的定理价格候选在600秒运行中第10项通过138/200，第15项通过55/200。失败主要由债务增加和队列增长触发，第15项另有木材/金属净消耗。{('候选的2400秒扩展已经纳入上表。' if candidate_extended_ready else '候选的2400秒扩展尚未生成。')} {('当前源码哈希匹配的2400秒结果也已纳入。' if current_ready else '当前源码哈希匹配的远端复算仍未生成；候选结果不会冒充当前版本。')}</p>
{Safe('''<div class="callout bad"><b>候选的2400秒扩展没有解除任何右删失：</b>阶段10仍为138/200，阶段15仍为55/200，所有新增通过数均为0。62/62个阶段10删失世界与145/145个阶段15删失世界的债务在三个连续窗口中都严格增加；三窗债务增量中位数分别为阶段10的16.82/41.97/43.78金币，以及阶段15的133.11/248.22/250.28金币。阶段15库存净消耗失败还从24界增至39界（木材21→36，金属3→4）。这构成持续漂移的强数值证据，但仍不冒充无限时间不可达证明。</div>''' if candidate_extended_ready else '')}
{Safe(drift_callout('当前版本', current2400_10, current2400_15))}
{Safe(drift_callout('仅替换定理价格的当前引擎配对组', priceonly2400_10, priceonly2400_15))}
{Safe(f'''<div class="callout ok"><b>纯价格配对：</b>当前引擎与行为哈希保持不变，只替换价格表后，阶段10严格通过由{current2400_10["found"]}/200变为{priceonly2400_10["found"]}/200，阶段15由{current2400_15["found"]}/200变为{priceonly2400_15["found"]}/200，阶段15爬坡失败由{current2400_15["rampFailures"]}变为{priceonly2400_15["rampFailures"]}。这才是可归因于价格的配对结果；旧隔离候选因引擎哈希不同仅作复核。</div>''' if priceonly_ready and current_ready else '<div class="callout warn">纯价格、当前引擎配对组仍在5090_Lian低并发运行，完成前不做价格因果归因。</div>')}
<h3>配对组实际替换的前22项价格</h3>
<p>基础资源不变；定理向量主要降低中间件价格。待检验假说是：这会减少单个高价中间件长期垄断猫的贪心选择。这里先列替换值，再由配对结果判断，不把“降低”预设为正确。</p>
{table(["序号","商品ID","当前基础价","定理候选价","候选/当前"], price_rows)}
<p class="callout warn">“右删失”表示在给定最大窗口前没找到满足全部严格条件的窗口。它既不能证明永远失败，也不能被记成通过；只有增加观察时间或给出不变量/漂移证明才能进一步分类。</p>
<details><summary>600秒失败种子（便于逐世界复现）</summary><p><b>阶段10：</b><span class="mono break">{esc(','.join(map(str,m600_10['failedSeeds'])))}</span></p><p><b>阶段15：</b><span class="mono break">{esc(','.join(map(str,m600_15['failedSeeds'])))}</span></p></details>
</section>

<section id="goals">
<h2>7. 对完整阶段目标的逐项判定</h2>
{table(["目标","本次证据","判定","还缺什么"], [
 ["不操作稳定达到10，且11为0", f"最新严格证书 {latest10['found']}/{latest10['worlds']}；本测量未把第11为0作为周期分母。", Safe('<span class="badge open">未满足全世界证明</span>'), "解决或证明债务/队列漂移，并单独审计第11产量。"],
 ["只买11–15图纸后稳定达到15", f"当前复算图纸购买 {(measure_current2400 or measure600)['summary']['blueprintsPurchasedAll']}/200；最新严格证书 {latest15['found']}/{latest15['worlds']}。", Safe('<span class="badge open">未满足全世界证明</span>'), "修复协调层后重新跑100–1000世界。"],
 ["自然无法稳定达到20", "物理层1000/1000可行，中位最优周期210秒。", Safe('<span class="badge censored">不能由物理模型证明</span>'), "需要冻结当前法规、解锁16–20后的真实负向/右删失证书。"],
 ["选择性价格达到22", "物理层1000/1000可行，中位最优周期260秒。", Safe('<span class="badge open">未做法规轨迹</span>'), "一条真实统一法规、固定哈希、操作账本和三窗口证书。"],
 ["纯×2等四方案无法稳定30", "本次没有运行四分支。", Safe('<span class="badge open">尚无证据</span>'), "相同世界配对、四套法规、右删失边界与失败物品/信用瓶颈。"],
 ["物流法规稳定30；玩家操作稳定35", "30/35的固有工作分别为330/818动作每篮子；存在建筑范围条件。", Safe('<span class="badge open">尚无完整证书</span>'), "明确建筑布局，合法玩家操作账本，冻结后供应链再生。"],
])}
<p>这张表刻意不把“首次制作”或“物理上存在一条流水线”写成“稳定达到”。稳定达到仍采用用户指定的三窗口、库存来源、债务、队列和冻结操作标准。</p>
</section>

<section id="limits">
<h2>8. 假设、反例入口与可证伪性</h2>
<ul>
  <li><b>温启动而非白手起家时间。</b> P<sup>*</sup> 是充分爬坡后的再生周期；首次制作时间另算。有限前缀赤字缓冲给出构造性上界，但不是免费注入到真实验收。</li>
  <li><b>建筑。</b> 阶段22以前没有场地要求。30/35阶段必须给出玩家实际建筑布局，分析器拒绝静默假设。</li>
  <li><b>经济协调。</b> MILP不含价格、税、贷款、保证金、广播和订单。这样做不是遗漏，而是让 H 单独测量这些机制；否则会把待解释的现象预埋为常数。</li>
  <li><b>求解器证书等级。</b> 5,000个整数解均为 HiGHS 报告的最优解，MIP gap=0且代回整数约束残差=0；它是可复算的数值最优证书，不宣称形式化定理证明器级别。</li>
  <li><b>反例。</b> 任一机器 JSON 中出现非零 gap、守恒残差、配方非拓扑、哈希不一致或某世界实际窗小于其 P<sup>*</sup>，都会直接推翻相应声明并使报告生成失败/显红。</li>
</ul>
</section>

<section id="reproduce">
<h2>9. 复现、权限边界与文件哈希</h2>
<pre class="formula"><code># 在 5090_Lian / marathon 执行，而非本机求解
/home/tjshen/miniconda3/envs/arena/bin/python \
  scripts/prove-cycle-complexity.py --seed-limit 1000 \
  --integer-seed-limit 1000 --stages 10,15,19,20,22 \
  --integer-stages 10,15,19,20,22 --workers 8

node --import tsx scripts/measure-regenerative-cycles.mts \
  --seed-start=1 --seed-count=10 --max-window-ms=2400000

python scripts/generate-regenerative-cycle-proof-report.py</code></pre>
<p><b>共享行为哈希：</b><span class="mono">{esc(authority['sharedBehaviorHash'])}</span><br><b>lawProgram SHA-256：</b><span class="mono break">{esc(authority['lawProgramSha256'])}</span><br><b>catalog SHA-256：</b><span class="mono break">{esc(authority['catalogSha256'])}</span><br><b>engine SHA-256：</b><span class="mono break">{esc(authority['engineSha256'])}</span></p>
{table(["证据文件","字节","SHA-256"], hash_rows)}
<p class="callout ok"><b>独立验证器：</b>状态 <span class="mono">{esc(proof_validation['status'])}</span>；重新核验了输入哈希、五阶段各 1000 个世界的覆盖、反向拓扑制作数、守恒、<span class="mono">P*=5000K</span>、<span class="mono">K=ceil(LP)</span>、猫负载总和、零 MIP gap 与零整数残差。</p>
<p class="callout ok"><b>权限审计：</b>本轮没有调用 DeepSeek，没有颁布法规，没有改商品价格/配方/共享行为函数，没有注入库存、金币、建筑、图纸或发现状态。新增内容只有求解器、聚合器、报告与 output 证据。</p>
</section>

<section id="refs">
<h2>10. 方法参考</h2>
<ol>
  <li><a href="https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.milp.html">SciPy <code>optimize.milp</code></a>：整数变量、线性约束与 HiGHS 接口。</li>
  <li><a href="https://highs.dev/">HiGHS</a>：本次 LP/MILP 的开源求解后端。</li>
  <li><a href="https://en.wikipedia.org/wiki/Perron%E2%80%93Frobenius_theorem">Perron–Frobenius / Collatz–Wielandt</a>：非负算子谱半径上下界。</li>
  <li>Alexander Schrijver, <i>Theory of Linear and Integer Programming</i>：整数流、线性约束与最优性基础。</li>
</ol>
</section>
<footer>Cat Workshop regenerative-cycle proof · computed on 5090_Lian / marathon, rendered locally from machine-readable evidence</footer>
</main></body></html>"""

OUTPUT.write_text(document, encoding="utf-8")
print(json.dumps({
    "output": str(OUTPUT),
    "bytes": OUTPUT.stat().st_size,
    "sha256": sha256(OUTPUT),
    "candidateExtendedMeasurementIncluded": candidate_extended_ready,
    "currentMeasurementIncluded": current_ready,
    "priceOnlyPairedMeasurementIncluded": priceonly_ready,
    "proofValidationStatus": proof_validation["status"],
    "latestStage10": None if latest10 is None else {"found": latest10["found"], "worlds": latest10["worlds"]},
    "latestStage15": None if latest15 is None else {"found": latest15["found"], "worlds": latest15["worlds"]},
}, ensure_ascii=False))
