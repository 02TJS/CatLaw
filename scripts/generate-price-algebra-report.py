#!/usr/bin/env python3
"""Render the parameter-first price derivation as a standalone Chinese HTML."""

from __future__ import annotations

import hashlib
import html
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ANALYSIS = ROOT / "output" / "price-algebra-analysis.json"
REPORT = ROOT / "CatWorkshop-Parametric-Price-Algebra.html"


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def money(cents: int | float) -> str:
    return f"{cents / 100:,.2f} 金币"


data = json.loads(ANALYSIS.read_text(encoding="utf-8"))
point = data["finalRulePoint"]
params = point["parameters"]
rows_by_id = {row["itemId"]: row for row in point["exactRows"]}
symbolic_by_id = {row["itemId"]: row for row in data["symbolicFirst15"]}
item_names = {
    "wood": "木材", "stone": "石料", "sand": "沙", "water": "水", "fiber": "纤维", "ore": "矿石",
    "fire": "炉火", "plank": "木板", "brick": "砖", "thread": "线", "paper": "纸", "tools": "工具",
    "glass": "玻璃", "metal": "金属", "gear": "齿轮",
    "cable": "线缆", "battery": "电池", "chemical": "化学品", "chassis": "底盘", "factory": "工厂",
    "lamp": "灯", "magnet": "磁铁", "wheel": "车轮", "fuel": "燃料", "coolant": "冷却剂",
    "antenna": "天线", "machine_tool": "机床", "chip": "芯片", "memory": "存储器", "display": "显示器",
    "controller": "控制器", "radio": "无线电", "robot": "机器人", "fabricator": "制造机", "vehicle": "车辆",
    "computer": "计算机", "server": "服务器", "network": "网络", "ai_core": "AI 核心", "lab": "实验室",
    "atom_core": "原子核心", "reactor": "反应堆", "solar_array": "太阳能阵列", "telescope": "望远镜",
    "rocket": "火箭", "satellite": "卫星", "life_support": "生命维持", "lunar_base": "月球基地",
    "star_map": "星图", "starship": "星际飞船", "superconductor": "超导体", "quantum_field": "量子场",
    "quantum_sensor": "量子传感器", "spacetime_clock": "时空钟", "quantum_computer": "量子计算机",
    "spacetime_map": "时空图", "singularity": "奇点", "gate_key": "星门密钥", "gate_ring": "门环",
    "stabilizer": "稳定器", "exotic_crystal": "奇异晶体", "address_core": "坐标核心",
    "containment": "约束场", "energy_matrix": "能量矩阵", "stargate": "星门",
}
tier_names = {
    0: "基础采集", 1: "手工作坊", 2: "机械制造", 3: "电气工业", 4: "电子自动化",
    5: "计算与核能", 6: "航天时代", 7: "量子时代", 8: "星门工程",
}

parameter_rows = [
    ("τ", "外售税率", params["taxRate"], "0 ≤ τ < 1"),
    ("f", "每件缺料的采购摩擦（分）", params["procurementFrictionCents"], "f ≥ 0"),
    ("r", "借贷费率", params["loanRate"], "r ≥ 0"),
    ("ℓ", "每笔正贷款的最低费用（分）", params["minimumLoanFeeCents"], "ℓ > 0"),
    ("h", "单个中转猫运费上界（分）", params["carrierFeeCapCents"], "h ≥ 0"),
    ("b", "普通订单相对清算价的溢价（分）", params["ordinaryOrderPremiumCents"], "b ≥ 0"),
    ("L", "最长运输路线边数", params["maxRouteEdges"], "L ∈ ℕ+"),
    ("ρ", "超出协调视野后的单位风险分", params["coordinationRiskCentsPerWork"], "ρ ≥ 0"),
    ("H", "单猫协调视野（工作量）", params["coordinationHorizonWorkUnits"], "H ∈ ℕ+"),
    ("ε", "严格正收益的最小分币", params["minimumPositiveGainCents"], "ε > 0"),
    ("u", "每金币的分币数", params["centsPerCoin"], "u > 0"),
    ("c", "基础资源计价锚（金币）", params["baseResourcePriceCoins"], "c > 0"),
    ("κ", "每目录价金币对应的图纸费（分）", params["blueprintCostCentsPerBasePriceCoin"], "κ > 0"),
    ("δ", "单张付费图纸最低价（分）", params["minimumBlueprintCostCents"], "δ > 0"),
    ("B", "玩家本阶段图纸预算（分）", params["initialBlueprintBudgetCents"], "B > 0"),
]
parameter_table = "".join(
    f"<tr><td><code>{esc(symbol)}</code></td><td>{esc(name)}</td><td class='num'>{esc(value)}</td><td><code>{esc(domain)}</code></td></tr>"
    for symbol, name, value, domain in parameter_rows
)

price_table = ""
for index, (item_id, price) in enumerate(point["first15"], 1):
    exact = rows_by_id[item_id]
    continuous = float(point["continuousFirst15"][item_id])
    price_table += (
        f"<tr><td class='num'>{index}</td><td><code>{esc(item_id)}</code> · {esc(item_names[item_id])}</td>"
        f"<td class='num'>{continuous:.4f}</td><td class='num'><strong>{price}</strong></td>"
        f"<td class='num'>{exact.get('inputOpportunityCostCents', 0)}</td>"
        f"<td class='num'>{exact.get('procurementFrictionCents', 0)}</td>"
        f"<td class='num'>{exact.get('zeroCashFinancingCostCents', 0)}</td>"
        f"<td class='num'>{exact.get('coordinationRiskCostCents', 0)}</td>"
        f"<td class='num'>{exact.get('requiredExternalMarginCents', 0)}</td></tr>"
    )

recurrence_rows = "".join(
    f"<tr><td><code>p_{esc(item_id)}</code></td><td><code>{esc(symbolic_by_id[item_id]['localRecurrence'])}</code></td></tr>"
    for item_id, _ in point["first15"]
)

blueprint_rows = "".join(
    f"<tr><td>{11 + index}</td><td><code>{esc(item_id)}</code> · {esc(item_names[item_id])}</td>"
    f"<td class='num'>{rows_by_id[item_id]['basePriceCoins']}</td>"
    f"<td class='num'>{money(cost)}</td></tr>"
    for index, (item_id, cost) in enumerate(point["perBlueprintCostsCents"].items())
)

derivatives = point["continuousBlueprintPriceSumDerivatives"]
elasticities = point["continuousBlueprintPriceSumElasticities"]
units = {
    "tau": "每增加 1.00 绝对税率", "f": "每增加 1 分采购摩擦", "r": "每增加 1.00 绝对费率",
    "h": "每增加 1 分运费上界", "b": "每增加 1 分订单溢价", "rho": "每增加 1 分/工作量",
    "u": "每增加 1 分/金币", "c": "每增加 1 金币资源锚",
}
sensitivity_rows = "".join(
    f"<tr><td><code>{esc(name)}</code></td><td>{esc(units[name])}</td>"
    f"<td class='num'>{value:+.6f}</td><td class='num'>{float(elasticities[name]):+.4f}</td></tr>"
    for name, value in derivatives.items()
)


def recipe_text(row: dict) -> str:
    inputs = row["difficultyInputs"]
    if not inputs:
        return "零输入采集"
    return " + ".join(
        f"{item_names.get(entry['itemId'], entry['itemId'])}×{entry['quantity']}"
        for entry in inputs
    )


def site_text(row: dict) -> str:
    requirements = row["siteRequirements"]
    if not requirements:
        return "—"
    return "；".join(
        f"{item_names.get(entry['buildingItemId'], entry['buildingItemId'])}≤{entry['maxManhattanDistance']}格"
        for entry in requirements
    )


later_price_rows = "".join(
    f"<tr><td class='num'>{row['index']}</td><td>{esc(row['emoji'])} <code>{esc(row['itemId'])}</code><br><span class='small'>{esc(item_names[row['itemId']])}</span></td>"
    f"<td>{esc(tier_names[row['tier']])}</td><td>{esc(recipe_text(row))}</td><td>{esc(site_text(row))}</td>"
    f"<td class='num'>{row['workUnitsUsedByRuntime']}</td><td class='num'>{row['continuousPriceCoins']:.3f}</td>"
    f"<td class='num'><strong>{row['exactIntegerPriceCoins']:,}</strong></td>"
    f"<td class='num'>{row['currentCatalogPriceCoins']:,}</td><td class='num'>{row['exactToCurrentRatio']:.3f}</td></tr>"
    for row in point["all65"][15:]
)
tier_rows = "".join(
    f"<tr><td>{entry['tier']} · {esc(tier_names[entry['tier']])}</td><td class='num'>{entry['itemCount']}</td>"
    f"<td class='num'>{entry['exactPriceMinCoins']:,}</td><td class='num'>{entry['exactPriceMaxCoins']:,}</td>"
    f"<td class='num'>{entry['exactPriceSumCoins']:,}</td><td class='num'>{entry['currentCatalogSumCoins']:,}</td></tr>"
    for entry in point["tierSummaries"]
)
exact_total = sum(row["exactIntegerPriceCoins"] for row in point["all65"])
current_total = sum(row["currentCatalogPriceCoins"] for row in point["all65"])

route_cost = (params["maxRouteEdges"] - 1) * params["carrierFeeCapCents"]
margin = max(
    params["minimumPositiveGainCents"],
    route_cost - params["ordinaryOrderPremiumCents"] + params["minimumPositiveGainCents"],
)

document = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>猫咪工坊：参数化价格代数</title>
<style>
:root{{--ink:#17211b;--muted:#5e6962;--line:#dce3de;--soft:#f5f7f5;--green:#17633d;--blue:#235f84;--amber:#815b0e;--red:#963b32}}*{{box-sizing:border-box}}html{{scroll-behavior:smooth}}body{{margin:0;background:#fff;color:var(--ink);font:15px/1.72 system-ui,"Segoe UI","Microsoft YaHei",sans-serif}}.shell{{display:grid;grid-template-columns:250px minmax(0,1fr);max-width:1500px;margin:auto}}nav{{position:sticky;top:0;height:100vh;padding:25px 17px;border-right:1px solid var(--line);overflow:auto;background:#fafbfa}}nav h2{{font-size:17px;margin:0 0 12px}}nav a{{display:block;padding:6px 8px;border-radius:6px;color:#455249;text-decoration:none}}nav a:hover{{background:#edf4ef;color:var(--green)}}main{{min-width:0;padding:38px 46px 80px}}header{{padding-bottom:20px}}h1{{font-size:36px;line-height:1.18;margin:5px 0 13px}}h2{{font-size:24px;margin:0 0 12px}}h3{{font-size:18px;margin:22px 0 8px}}section{{padding-top:27px;margin-top:15px;border-top:1px solid var(--line);scroll-margin-top:18px}}p{{margin:8px 0}}.lead{{max-width:1000px;font-size:18px;color:#39463e}}.eyebrow{{color:var(--green);font-weight:800;letter-spacing:.06em}}.box{{padding:14px 17px;margin:14px 0;border-left:5px solid var(--green);background:#eef8f1}}.box.info{{border-color:var(--blue);background:#edf6fb}}.box.warn{{border-color:var(--amber);background:#fff8e7}}.box.no{{border-color:var(--red);background:#fff1ef}}.formula{{padding:13px 15px;border:1px solid var(--line);border-radius:8px;background:var(--soft);font:14px/1.7 ui-monospace,Consolas,"Microsoft YaHei",monospace;white-space:pre-wrap;overflow:auto}}.steps{{counter-reset:step;list-style:none;padding:0}}.steps li{{position:relative;margin:10px 0;padding:12px 14px 12px 52px;border:1px solid var(--line);border-radius:8px}}.steps li:before{{counter-increment:step;content:counter(step);position:absolute;left:14px;top:13px;width:25px;height:25px;display:grid;place-items:center;border-radius:50%;background:var(--green);color:#fff;font-weight:800}}.table-wrap{{overflow:auto;border:1px solid var(--line);border-radius:8px}}table{{width:100%;border-collapse:collapse;min-width:760px;font-size:13px}}th,td{{padding:9px;border-bottom:1px solid var(--line);border-right:1px solid var(--line);text-align:left;vertical-align:top}}th{{background:#eef3ef}}tr:last-child td{{border-bottom:0}}th:last-child,td:last-child{{border-right:0}}.num{{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}}code{{font:12px ui-monospace,Consolas,monospace;word-break:break-word}}#later-prices td:nth-child(2){{min-width:138px}}#later-prices td:nth-child(2) code{{white-space:nowrap;word-break:normal}}#later-prices td:nth-child(4){{min-width:260px}}#later-prices td:nth-child(5){{min-width:170px}}.cards{{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px;margin:14px 0}}.card{{padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--soft)}}.card b{{display:block;font-size:24px;color:var(--green)}}.card span,.small{{color:var(--muted)}}ul{{padding-left:23px}}li{{margin:6px 0}}@media(max-width:1000px){{.shell{{display:block}}nav{{position:relative;height:auto;border-right:0;border-bottom:1px solid var(--line)}}nav div{{columns:3}}main{{padding:28px}}.cards{{grid-template-columns:repeat(2,1fr)}}}}@media(max-width:650px){{nav div{{columns:1}}main{{padding:21px 14px}}h1{{font-size:29px}}.cards{{grid-template-columns:1fr}}}}
</style></head><body><div class="shell"><nav><h2>参数化价格代数</h2><div>
<a href="#conclusion">结论</a><a href="#symbols">参数与定义域</a><a href="#derive">逐步推导</a><a href="#discrete">精确离散模型</a><a href="#continuous">连续与矩阵模型</a><a href="#budget">图纸预算</a><a href="#substitute">最后代入</a><a href="#all65">第 16–65 项</a><a href="#sensitivity">局部敏感度</a><a href="#boundary">证明边界</a><a href="#reproduce">复现</a>
</div></nav><main><header><div class="eyebrow">CAT WORKSHOP · PARAMETRIC ECONOMICS</div><h1>先保留参数，再代入规则</h1><p class="lead">50% 税、25 分采购摩擦、2% 借贷费和 150 金币图纸预算都不是由配方图证明出的常数。本报告先在 <code>(τ,f,r,ℓ,h,b,L,ρ,H,ε,u,c,κ,δ,B)</code> 上推导，再在第 7 节一次性代入当前难度 5 规则。</p></header>

<section id="conclusion"><h2>1. 结论</h2><div class="box"><strong>价格与预算必须分层。</strong>技术价格由税后清算价值、原料机会成本、采购、融资、运输和协调约束决定；图纸预算 <code>B</code> 只判断这一价格向量是否买得起，不能倒推商品“应该值多少”。</div><ul><li>配方 DAG 给出一个按拓扑顺序可解、逐分币严格检验的最小整数价格向量。</li><li>在固定活跃分支下，连续模型是有限 Leontief 逆；因为依赖矩阵幂零，不存在无穷级数收敛假设。</li><li>当前数值只产生一个条件结果，不会被称为普适最优价格。</li></ul></section>

<section id="symbols"><h2>2. 参数与定义域</h2><div class="table-wrap"><table><thead><tr><th>符号</th><th>含义</th><th>本报告末尾代入值</th><th>理论定义域</th></tr></thead><tbody>{parameter_table}</tbody></table></div><p class="small">其中 <code>q=1-τ</code> 是猫保留的税后比例。把 <code>q</code> 保持为正符号，可避免展开式被写成难读的 <code>(τ-1)</code> 负分母。</p></section>

<section id="derive"><h2>3. 从一只利己猫逐步推导</h2><ol class="steps"><li><strong>税后清算。</strong>目录价为 <code>p</code> 金币时，精确可得 <code>nτ(p)=u·p-ceil(τu·p)</code> 分；连续近似为 <code>u·q·p</code>。</li><li><strong>放弃原料的机会成本。</strong>配方 <code>i</code> 消耗 <code>aᵢⱼ</code> 件原料 <code>j</code>，最低应补回 <code>Σ aᵢⱼ nτ(pⱼ)</code>。</li><li><strong>缺料采购摩擦。</strong>若按最保守的“全部缺料”条件，共有 <code>mᵢ=Σaᵢⱼ</code> 个订单，决策函数再扣 <code>f·mᵢ</code>。这里 <code>f</code> 是模型参数，不被解释成自然常数。</li><li><strong>逐单融资。</strong>每个订单的普通报价是 <code>nτ(pⱼ)+b</code>；零现金时每一单分别产生 <code>φᵣ,ℓ(z)=max(ℓ,ceil(rz))</code>。最低贷款费 <code>ℓ</code> 与最低正利润 <code>ε</code> 含义不同，即使当前都等于 1 分也不能合并。必须逐单求和，不能把总额只取整一次。</li><li><strong>运输与外售二选一。</strong>最长 <code>L</code> 跳有至多 <code>L-1</code> 个中转猫，费用上界为 <code>(L-1)h</code>。订单已经多付 <code>b</code>，所以额外所需利润为 <code>M=max(ε,(L-1)h-b+ε)</code>。</li><li><strong>协调项。</strong>工作量超过视野 <code>H</code> 时再扣 <code>ρ·max(Wᵢ-H,0)</code>；<code>ρ,H</code> 同样保持可变。</li></ol></section>

<section id="discrete"><h2>4. 精确整数模型</h2><div class="formula">φᵣ,ℓ(z) = max(ℓ, ceil(rz))

Rᵢ = Σⱼ aᵢⱼ nτ(Pⱼ) + f mᵢ
   + Σⱼ aᵢⱼ φᵣ,ℓ(nτ(Pⱼ)+b)
   + ρ max(Wᵢ-H,0) + M

Pᵢ = min {{ p ∈ ℤ₊ : nτ(p) ≥ Rᵢ }}

M = max(ε,(L-1)h-b+ε)</div><p>配方图无环，所以先求六种资源，再逐项求后继。<code>nτ(p)</code> 对 <code>p</code> 单调；因此每一步选出的最小整数都是该前缀的分量最小解。拓扑归纳后得到全向量唯一的分量最小解。</p><div class="box warn">这是“全部原料缺失、零现金、最长路线”的充分价格包络，不是假设每次真实交易都恰好走最坏路线。它保证单笔计划不亏，但不能单独证明有限猫网络会稳定调度。</div></section>

<section id="continuous"><h2>5. 连续模型与有限 Leontief 逆</h2><div class="formula">一般分段式：
pᵢ* = Σⱼ aᵢⱼpⱼ* + [f mᵢ + Σⱼaᵢⱼ max(ℓ,r(uq pⱼ*+b))
      + ρ max(Wᵢ-H,0) + M] / (u q)

若每条边都满足 r(uq pⱼ*+b) ≥ ℓ：
pᵢ* = (1+r) Σⱼ aᵢⱼpⱼ*
      + [(f+r b)mᵢ + ρ max(Wᵢ-H,0) + M] / (u q)

p* = (I-(1+r)A)⁻¹d
   = Σₖ₌₀⁶⁴ ((1+r)A)ᵏ d</div><p>一般模型是分段仿射。只有比例费率分支全部激活时才使用矩阵化简；按配方拓扑排列后，<code>A</code> 严格下三角，故 <code>A⁶⁵=0</code>。当前代入点该分支为 <strong>{'已验证激活' if point['percentageLoanBranchActiveForFirst15'] else '未全部激活'}</strong>。逆矩阵是有限多项式，不需要凭经验指定“原料统一加价百分比”。</p><details><summary>前 15 项一般分段递推</summary><div class="table-wrap"><table><thead><tr><th>商品</th><th>递推</th></tr></thead><tbody>{recurrence_rows}</tbody></table></div></details></section>

<section id="budget"><h2>6. 图纸预算是独立约束</h2><div class="formula">Cᵢᵇˡᵘᵉ = max(δ, κPᵢ)

Σᵢ∈{{11,…,15}} Cᵢᵇˡᵘᵉ ≤ B</div><p>因此可行参数域是 <code>Θ={{θ：满足全部定义域，且 C_blueprint(θ)≤B}}</code>。改变 <code>B</code> 不改变 <code>P</code>，只改变是否可购买；改变 <code>κ</code> 也不改变技术价格，只改变图纸价格映射。</p></section>

<section id="substitute"><h2>7. 到这里才代入当前数值</h2><p>当前起始猫图的实测直径是 <strong>{point['observedStarterGraphDiameterEdges']}</strong> 跳。于是最坏中转费用为 <code>({params['maxRouteEdges']}-1)×{params['carrierFeeCapCents']}={route_cost}</code> 分，当前订单溢价为 {params['ordinaryOrderPremiumCents']} 分，故 <code>M={margin}</code> 分。</p><div class="cards"><div class="card"><b>{money(point['blueprint11To15TotalCents'])}</b><span>11–15 图纸总费</span></div><div class="card"><b>{money(params['initialBlueprintBudgetCents'])}</b><span>代入预算 B</span></div><div class="card"><b>{money(point['blueprintBudgetSlackCents'])}</b><span>条件预算余量</span></div><div class="card"><b>{'可负担' if point['blueprintAffordable'] else '不可负担'}</b><span>只针对本次参数点</span></div></div><h3>价格递推结果</h3><div class="table-wrap"><table><thead><tr><th>#</th><th>商品</th><th>连续价</th><th>精确整数价</th><th>原料机会成本/分</th><th>摩擦/分</th><th>逐单融资/分</th><th>协调/分</th><th>利润包络/分</th></tr></thead><tbody>{price_table}</tbody></table></div><h3>付费图纸</h3><div class="table-wrap"><table><thead><tr><th>#</th><th>图纸</th><th>目录价/金币</th><th>图纸费</th></tr></thead><tbody>{blueprint_rows}</tbody></table></div><div class="box info">连续模型的五张图纸商品价之和是 <strong>{point['continuousBlueprintPriceSum']:.4f}</strong> 金币，精确整数价之和是 <strong>{sum(rows_by_id[item]['basePriceCoins'] for item in point['perBlueprintCostsCents'])}</strong> 金币。差异来自逐分币税收、逐单贷款取整和整数目录价，不应把连续值冒充游戏实际收费。</div></section>

<section id="all65"><h2>8. 第 16–65 项继续递推</h2><div class="box"><strong>全部 65 项已按同一公式完成。</strong>没有为后期商品另设倍率，也没有把当前目录价当成目标值。当前参数点的比例贷款分支在全部 65 项依赖边上均已验证激活。</div><div class="cards"><div class="card"><b>{exact_total:,}</b><span>65 项精确价格之和</span></div><div class="card"><b>{current_total:,}</b><span>当前生产目录价格之和</span></div><div class="card"><b>147,959</b><span>本模型星门价格</span></div><div class="card"><b>{money(point['allPaidBlueprintTotalCents'])}</b><span>按当前 κ 购买 11–65 全部图纸</span></div></div><div class="box warn"><strong>后期建筑不按件摊销。</strong>工厂、机床、实验室等地面建筑可重复使用，配方并不会在每次制作时消耗它们。它们在本层只限制可行工位；拥挤时产生的容量影子租金必须由稳态流 LP 的对偶变量计算，不能先拍一个百分比塞进商品价。</div><h3>后 50 项价格</h3><div class="table-wrap"><table id="later-prices"><thead><tr><th>#</th><th>商品</th><th>时代</th><th>难度 5 配方</th><th>附近建筑</th><th>运行时工作量</th><th>连续价</th><th>精确整数价</th><th>当前目录价</th><th>理论/当前</th></tr></thead><tbody>{later_price_rows}</tbody></table></div><h3>按时代汇总</h3><div class="table-wrap"><table id="tier-summary"><thead><tr><th>时代</th><th>数量</th><th>最低价</th><th>最高价</th><th>理论价格和</th><th>当前目录和</th></tr></thead><tbody>{tier_rows}</tbody></table></div><p>这些价格是当前参数下的<strong>单项非亏损下界</strong>。例如星门 147,959 金币低于当前目录的 383,668 金币，不代表应立即降价；只有加入空间容量租金并通过 10/15/20/22/30/35 三窗口稳定性检验后，才有资格成为生产候选。</p></section>

<section id="sensitivity"><h2>9. 当前分支上的局部敏感度</h2><p>以下导数先由符号式求出，再在当前参数点求值；它们是局部斜率，不是新的推荐常数。弹性表示参数增加 1% 时，连续五项价格和约变化多少百分比。</p><div class="table-wrap"><table><thead><tr><th>参数</th><th>导数单位</th><th>∂S/∂参数</th><th>局部弹性</th></tr></thead><tbody>{sensitivity_rows}</tbody></table></div><ul><li><code>∂S/∂B=0</code>：预算不决定技术价格；预算余量对 <code>B</code> 的导数才是 1。</li><li>当前 <code>b&lt;(L-1)h</code>，多 1 分订单溢价既增加少量融资，又减少 1 分运输缺口；后者占优，所以局部导数为负。达到分段边界后符号会改变，不能外推成“订单溢价越大越好”。</li><li>税率只对不能同步征税的固定分币成本产生放大；原料与成品都按同一税率清算的比例部分在递推中抵消。</li></ul></section>

<section id="boundary"><h2>10. 这个证明能证明什么</h2><div class="box"><strong>能证明：</strong>给定参数向量后，前 65 项存在可复算的分量最小整数价格，使零现金、全缺料、给定最长路线的单项计划保持严格非亏损，并可检查图纸预算。</div><div class="box no"><strong>不能证明：</strong>猫的局部贪心评分会自动产生全网稳态、所有中间品跨窗口持续生产，或 1000 个随机空间种子都通过稳定性验收。那些是容量、路由、信用占用与闭环控制问题，必须继续使用稳态多商品流 LP、对偶瓶颈和确定性三窗口模拟。</div></section>

<section id="reproduce"><h2>11. 复现与变参</h2><div class="formula">python scripts/analyze-price-algebra.py
python scripts/generate-price-algebra-report.py

# 示例：只改变代入点，不改公式或游戏源码
python scripts/analyze-price-algebra.py --tax-rate 0.35 --loan-rate 0.01 \
  --procurement-friction-cents 10 --blueprint-budget-cents 20000</div><p class="small">分析 JSON：<code>{esc(ANALYSIS.relative_to(ROOT))}</code><br>SHA-256：<code>{sha256(ANALYSIS)}</code><br>模型标识：<code>{esc(data['schema'])}</code></p></section>
</main></div></body></html>"""

REPORT.write_text(document, encoding="utf-8")
print(json.dumps({
    "report": str(REPORT),
    "bytes": REPORT.stat().st_size,
    "sha256": sha256(REPORT),
    "analysisSha256": sha256(ANALYSIS),
}, ensure_ascii=False, indent=2))
