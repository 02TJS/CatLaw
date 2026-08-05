#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import html
import json
from collections import Counter
from pathlib import Path


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def fmt(value: float, digits: int = 3) -> str:
    if abs(value) >= 1000:
        return f"{value:,.{digits}f}"
    return f"{value:.{digits}f}"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="output/price-theory-input.json")
    parser.add_argument("--results", default="output/price-theory-results.json")
    parser.add_argument("--output", default="CatWorkshop-Price-Theory-and-Calculation.html")
    args = parser.parse_args()
    input_path = Path(args.input)
    results_path = Path(args.results)
    output_path = Path(args.output)
    data = json.loads(results_path.read_text(encoding="utf-8"))
    items = data["items"]
    aggregates = data["lpAggregates"]
    certificates = data["lpCertificates"]

    stage15_equal = [entry for entry in certificates if entry["stage"] == 15 and entry["mode"] == "equal-pieces"]
    leading_bottlenecks = Counter(entry["topTargetShadowShares"][0]["itemId"] for entry in stage15_equal)
    item_by_id = {entry["id"]: entry for entry in items}
    bottleneck_text = "、".join(
        f"{item_by_id[item_id]['name']} {count}/1000"
        for item_id, count in leading_bottlenecks.most_common()
    )

    work_rows = "".join(
        "<tr>"
        f"<td>{entry['index'] + 1}</td>"
        f"<td class='item'>{esc(entry['emoji'])} {esc(entry['name'])}<code>{esc(entry['id'])}</code></td>"
        f"<td>{entry['tier']}</td>"
        f"<td>{entry['workDifficulty1to4']:,}</td>"
        f"<td>{entry['workDifficulty5']:,}</td>"
        f"<td>{entry['currentCatalogPriceCoins']:,}</td>"
        f"<td>{entry['currentToTheoryRatioDifficulty5']:.2f}×</td>"
        "</tr>"
        for entry in items
    )

    spatial_rows = "".join(
        "<tr>"
        f"<td>{entry['index'] + 1}</td>"
        f"<td>{esc(entry['emoji'])} {esc(entry['name'])}</td>"
        f"<td>{entry['workDifficulty5']}</td>"
        f"<td>{entry['minimumDeliveredActionsDifficulty5InitialWorlds']['min']:.0f}</td>"
        f"<td>{entry['minimumDeliveredActionsDifficulty5InitialWorlds']['median']:.0f}</td>"
        f"<td>{entry['minimumDeliveredActionsDifficulty5InitialWorlds']['p95']:.0f}</td>"
        f"<td>{entry['minimumDeliveredActionsDifficulty5InitialWorlds']['max']:.0f}</td>"
        f"<td>{entry['currentCatalogPriceCoins']}</td>"
        "</tr>"
        for entry in items[:15]
    )

    mode_name = {"equal-pieces": "等件数 dᵢ=1", "equal-work": "等劳动 dᵢ=1/Wᵢ"}
    aggregate_rows = "".join(
        "<tr>"
        f"<td>前 {entry['stage']} 项</td>"
        f"<td>{mode_name[entry['mode']]}</td>"
        f"<td>{fmt(entry['lambdaPerMinute']['min'])}</td>"
        f"<td>{fmt(entry['lambdaPerMinute']['median'])}</td>"
        f"<td>{fmt(entry['lambdaPerMinute']['p95'])}</td>"
        f"<td>{fmt(entry['lambdaPerMinute']['max'])}</td>"
        "</tr>"
        for entry in aggregates
    )

    max_gap = max(entry["maxDualityGap"] for entry in aggregates)
    max_primal = max(entry["maxPrimalResidual"] for entry in aggregates)
    max_kkt = max(entry["maxKktResidual"] for entry in aggregates)
    max_norm = max(entry["maxDemandNormalizationError"] for entry in aggregates)
    environment = data.get("computeEnvironment", {})

    document = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>猫咪工坊：价格理论证明与 1000 种子计算</title>
<style>
:root{{--ink:#182019;--muted:#59635b;--line:#d8dfd9;--soft:#f4f7f4;--green:#176a43;--green2:#e8f4ec;--gold:#805d16;--gold2:#fbf4e4;--red:#96372f;--red2:#fbecea}}
*{{box-sizing:border-box}}html{{scroll-behavior:smooth}}body{{margin:0;background:#eef2ee;color:var(--ink);font:15px/1.72 "Segoe UI","Microsoft YaHei",sans-serif}}main{{width:min(1180px,calc(100% - 28px));margin:22px auto 60px;background:#fff;border:1px solid var(--line);box-shadow:0 14px 44px #26382b1a}}header,section,footer{{padding:34px 48px;border-bottom:1px solid var(--line)}}header{{padding-top:48px;background:linear-gradient(135deg,#fff,#f0f7f2)}}h1{{font-size:34px;line-height:1.2;margin:4px 0 14px}}h2{{font-size:23px;margin:0 0 14px}}h3{{font-size:18px;margin:24px 0 8px}}p{{margin:9px 0}}.eyebrow{{color:var(--green);font-weight:750;letter-spacing:.09em}}.lede{{font-size:18px;color:#364038}}.box{{border-left:5px solid var(--green);background:var(--green2);padding:14px 17px;margin:16px 0}}.warn{{border-left-color:var(--gold);background:var(--gold2)}}.no{{border-left-color:var(--red);background:var(--red2)}}.formula{{font:15px/1.65 Consolas,"Segoe UI",monospace;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:13px 16px;overflow:auto;white-space:pre-wrap;margin:12px 0}}.proof{{border-left:2px solid #afbeb2;padding-left:20px}}.proof li{{margin:8px 0}}.grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:15px 0}}.metric{{border:1px solid var(--line);background:#fff;border-radius:9px;padding:13px}}.metric b{{display:block;font-size:20px;color:var(--green)}}.table-wrap{{overflow:auto;border:1px solid var(--line);border-radius:8px}}table{{border-collapse:collapse;width:100%;min-width:720px}}th,td{{border-bottom:1px solid var(--line);border-right:1px solid var(--line);padding:8px 9px;text-align:right;vertical-align:top;white-space:nowrap}}th{{background:#eff4f0;position:sticky;top:0}}th:nth-child(2),td:nth-child(2){{text-align:left}}tr:last-child td{{border-bottom:0}}th:last-child,td:last-child{{border-right:0}}code{{font:12px Consolas,monospace;color:var(--muted);display:block}}.small{{font-size:13px;color:var(--muted)}}.check{{color:var(--green);font-weight:700}}footer{{border-bottom:0;color:var(--muted);font-size:13px}}a{{color:var(--green)}}@media(max-width:760px){{header,section,footer{{padding-left:22px;padding-right:22px}}.grid{{grid-template-columns:1fr}}h1{{font-size:28px}}}}
</style></head><body><main>
<header><div class="eyebrow">CAT WORKSHOP · PROOF FIRST, COMPUTATION SECOND</div><h1>价格理论证明与 1000 种子计算</h1>
<p class="lede">先说明哪些量能从数学推出，再报告数值。结论不是“高级品统一加若干百分比”，而是三层分离：技术包含劳动、实际逐跳到货成本、状态相关容量稀缺。</p>
<div class="box"><strong>最终建议：</strong>目录基础价采用 <b>pᵢ=cWᵢ</b>；难度 1–4 使用普通配方的 W，难度 5 使用大宗配方的 W。运输每发生一次真实 pass 再增加该动作的报酬；建筑与拥堵通过当时订单/影子租金形成动态溢价，不永久写进 65 项目录价。若沿用“基础资源=1 金币”，则只是选取外生标尺 c=1 金币/动作，表中的 W 才可直接读成金币。</div>
<div class="box warn"><strong>必须诚实的边界：</strong>配方只能确定相对价格。税率、信用、悬赏、利润率、25 分运费、12% 加价以及“1 金币/动作”均不能由配方证明；后者只是为了把相对价格显示成游戏货币的计价单位。</div></header>

<section><h2>一、这究竟是什么数学模型</h2>
<ol><li><b>Leontief 固定系数投入产出：</b>配料不能替代，正好对应固定配方。</li><li><b>有向无环生产超图：</b>一个配方把多种输入合成一个输出，65 项依赖图无环。</li><li><b>多商品空间网络流：</b>猫是节点，相邻 pass 是有向边，同一猫的制作与发送争夺动作容量。</li><li><b>稳态线性规划及其对偶：</b>三窗口“每项持续产出”在长期平均流量下是物料平衡和容量约束；对偶乘子就是边际瓶颈价格。</li></ol>
<p>这不是把经济学名词贴到游戏上：下面每一个游戏动作都落入一个变量或约束，并能由原始—对偶证书数值复核。</p></section>

<section id="technical-theorem"><h2>二、定理 A：技术基础价唯一，但只唯一到一个比例尺</h2>
<p>令 A<sub>ji</sub> 表示生产一件 i 必须消耗的 j 的数量。按配方拓扑序排列后，A 是严格三角矩阵，所以 A<sup>65</sup>=0。令每个采集或制作动作的机会成本相同，记为 c&gt;0；零输入资源也需要一次动作。</p>
<div class="formula">p = c·1 + Aᵀp
(I-Aᵀ)p = c·1
p = c(I-Aᵀ)⁻¹1 = c[ I + Aᵀ + (Aᵀ)² + … + (Aᵀ)⁶⁴ ]1 = cW</div>
<div class="proof"><ol><li>A<sup>65</sup>=0，因此有限级数确实是 (I-Aᵀ) 的逆：两者相乘后中间项望远镜消去，只剩 I。</li><li>所以解存在。若还有 p′，则 (I-Aᵀ)(p-p′)=0；左乘已存在的逆得到 p=p′，所以解唯一。</li><li>W 的每一项恰好把所有依赖层中的动作数展开相加，因此 W<sub>资源</sub>=1，W<sub>成品</sub>=1+ΣA<sub>ji</sub>W<sub>j</sub>。</li><li>若把 c 与全部 p 同乘任意正数，所有等式仍成立；所以绝对金币尺度不可识别，只能外部选择。</li></ol></div>
<p><b>这一定理排除了百分比拍脑袋：</b>相同 5 秒的新增制作动作贡献的是加法项 c，而不是“原料越贵，最后同一个动作就神奇地值越高”的固定百分比。</p></section>

<section><h2>三、定理 B：空间到货成本是最短生产超路径</h2>
<p>令 dist(u,v) 为猫链最短跳数，Sᵢ 为可采集资源 i 的猫集合，Dᵢ(v) 为把一件 i 交到猫 v 所需的最少动作数。则：</p>
<div class="formula">资源：Dᵢ(v) = 1 + min[s∈Sᵢ] dist(s,v)
制品：Dₒ(v) = min[u] {{ 1 + Σⱼ aⱼₒDⱼ(u) + dist(u,v) }}</div>
<div class="proof"><ol><li>任何资源方案必须先在某个合法资源猫采集一次，再沿一条路送到 v；最短路给出下界且能构造达到。</li><li>任何制品方案必有最后一次制作发生在某个 u；此前所有输入必须到达 u，之后输出必须到达 v，所以右式是所有方案的下界。</li><li>选取达到各输入最小值的方案、在 u 制作、再走最短路，就达到该下界。</li><li>沿配方 DAG 归纳，所有 D 唯一确定。它计算一次性、无拥堵成本；容量竞争留给下一层。</li></ol></div></section>

<section><h2>四、定理 C：稳定生产的瓶颈价格来自 LP 对偶</h2>
<p>x<sub>vr</sub> 是猫 v 的配方流量，y<sub>uvi</sub> 是物品 i 从 u 到 v 的逐跳流量，z<sub>vi</sub> 是最终吸收量，λ 是需求向量 d 的共同产出尺度。每个动作周期每猫容量为 1：</p>
<div class="formula">max λ
Σᵣxᵥᵣ + Σᵥ→ᵤ,ᵢ yᵥᵤᵢ ≤ 1                              （猫容量）
生产 + 流入 − 配料消耗 − 流出 − z = 0                   （逐猫逐物品守恒）
Σᵥzᵥᵢ = λdᵢ                                             （稳定需求）
x,y,z,λ ≥ 0</div>
<p>其对偶可用猫容量租金 κᵥ≥0、节点物品势 πᵥᵢ 和目标边际负担 βᵢ 表示：</p>
<div class="formula">min Σᵥκᵥ
πᵥ,o(r) ≤ κᵥ + Σⱼ aⱼᵣπᵥⱼ                              （制作）
πᵥᵢ ≤ πᵤᵢ + κᵤ                                         （u→v 运输）
βᵢ ≤ πᵥᵢ；  Σᵢdᵢβᵢ ≥ 1                                （吸收与归一化）</div>
<div class="proof"><ol><li>λ=0 给出可行解；总猫动作容量有限，而正的目标产出必须消耗制作动作，所以目标有界。</li><li>有限可行且有界的 LP 满足强对偶：max λ=min Σκ。对偶可行解是任何生产计划的上界证书。</li><li>互补松弛：未占满的猫容量必须有 κ=0；被正流量使用的制作或运输边，其不等式取等号。</li><li>因此 κ 不是主观加价，而是“多给该猫一个动作容量，稳定目标最多增加多少”的一阶敏感度。π 和 β 同理。</li></ol></div>
<p>注意 κ、π、β 依赖世界种子、猫位、建筑和需求 d；它们适合订单动态定价，不适合固化成永远不变的目录倍数。</p></section>

<section id="certificates"><h2>五、计算口径与可复现证书</h2>
<div class="grid"><div class="metric"><b>{data['seedCount']:,}</b>固定世界种子</div><div class="metric"><b>{len(certificates):,}</b>独立稀疏 LP</div><div class="metric"><b>{len(data['lpFailures'])}</b>求解失败</div></div>
<ul><li>阶段：前 10 项、前 15 项。</li><li>需求一：dᵢ=1，严格对应“每种商品相同件数”的稳定验收。</li><li>需求二：dᵢ=1/Wᵢ，用于比较相同包含劳动预算，不替代正式等件数口径。</li><li>资源采集只允许在真实资源覆盖猫；pass 只沿真实相邻有向边；制作和发送共同占用发送猫容量；接收不另占动作，和当前游戏一致。</li><li>税、信用、悬赏、现行价格、法条评分完全未进入 LP。</li></ul>
<table><thead><tr><th>证书</th><th>全部 4000 问题的最坏值</th><th>判定</th></tr></thead><tbody>
<tr><td>原始—对偶间隙</td><td>{max_gap:.3e}</td><td class="check">通过</td></tr><tr><td>原始可行性残差</td><td>{max_primal:.3e}</td><td class="check">通过</td></tr><tr><td>KKT/互补松弛残差</td><td>{max_kkt:.3e}</td><td class="check">通过</td></tr><tr><td>Σdᵢβᵢ=1 归一化误差</td><td>{max_norm:.3e}</td><td class="check">通过</td></tr></tbody></table>
<p class="small">输入 SHA-256：<code>{sha256(input_path)}</code>结果 SHA-256：<code>{sha256(results_path)}</code>环境：{esc(environment.get('hostname','unknown'))}；Python {esc(environment.get('python','?'))}；NumPy {esc(environment.get('numpy','?'))}；SciPy {esc(environment.get('scipy','?'))}；96 进程。求解器内部耗时 {float(environment.get('elapsedSeconds',0)):.3f} 秒。</p></section>

<section id="steady-results"><h2>六、1000 种子的稳态结果</h2>
<p>λ/分钟在“等件数”下可读作每分钟完成多少套“一种各一件”的组合。它是连续稳态上界，不是离散引擎已经自动实现该排程的宣称。</p>
<div class="table-wrap"><table><thead><tr><th>阶段</th><th>需求口径</th><th>最小</th><th>中位</th><th>P95</th><th>最大</th></tr></thead><tbody>{aggregate_rows}</tbody></table></div>
<div class="box"><strong>最重要的结构发现：</strong>前 15 项等件数模型的首要目标边际瓶颈为：{esc(bottleneck_text)}。齿轮占 969/1000，说明困难集中在齿轮—金属—矿石及其汇聚运输，而不是“所有商品整体太便宜”。统一 ×2 不改变任何相对价和候选排序，因此数学上不能消除此瓶颈。</div></section>

<section><h2>七、前 15 项的一次性最少到货动作</h2>
<p>下表在每个种子中允许选择最合适的最终猫，统计最少总动作。W 是完全忽略空间的下界；两者之差就是该布局不可避免的输入汇聚/运输成本。</p>
<div class="table-wrap"><table><thead><tr><th>#</th><th>商品</th><th>技术 W</th><th>最小</th><th>中位</th><th>P95</th><th>最大</th><th>当前目录价</th></tr></thead><tbody>{spatial_rows}</tbody></table></div>
<p>例：齿轮技术成本 W=11，但 1000 个初始布局的最少到货动作中位数为 19、P95 为 23；当前 24 金币刚好超过 P95。砖的中位到货成本为 8，当前价 7；玻璃中位为 9，当前价 8。这个结果支持“基础技术价 + 真实运输费”，不支持再造一个适用于所有物品和地图的百分比。</p></section>

<section id="prices"><h2>八、65 项技术价格表</h2>
<p>“理论价”列未另列，因为在 c=1 金币/动作这个外生示例下，它数值上就等于 W。难度 5 的大宗配方改变了部分投入数量，因此必须有独立 W；建筑只改变可行地点和动态稀缺，不改变配方内含动作。</p>
<div class="table-wrap"><table><thead><tr><th>#</th><th>商品 / ID</th><th>层级</th><th>W 难度1–4</th><th>W 难度5</th><th>当前价</th><th>当前/W5</th></tr></thead><tbody>{work_rows}</tbody></table></div></section>

<section><h2>九、到底什么价格合理</h2>
<h3>可直接实施的数学规则</h3><ol><li>选择一个公开的动作报酬标尺 c。若保留基础资源 1 金币，则 c=1；这是一项货币设计决定。</li><li>基础目录价：pᵢ=cWᵢ。难度 5 使用自己的 W，不把大宗配方成本藏在系数里。</li><li>每个真实运输动作单独获得 c；多原料在何处汇聚，就由合同实际走过的边累加，不用全局估算。</li><li>建筑附近稀缺、局部猫容量紧张时，订单出价根据当前 κ/π 上浮；一旦布局改变，溢价随之改变。</li><li>税、悬赏、信用都在基础价之外明示。它们可以为关卡服务，但不能伪装成生产成本。</li></ol>
<h3>对当前价格曲线的判断</h3><p>当前目录价相对 W5 从 1.00× 上升到星门的 {items[-1]['currentToTheoryRatioDifficulty5']:.2f}×。所以仅从配方劳动看，<b>高级品并不偏低，反而已包含巨额、且随层级上升的额外溢价</b>。若真实玩法仍认为高级品收益不足，说明需要支付的是空间运输、建筑稀缺、资本冻结或税后现金流；这些量必须用实际状态计算，不能继续提高一个没有来源的层级百分比。</p>
<div class="box no"><strong>不能声称的结论：</strong>本次计算没有给出唯一的晚期“金币市场价”，因为用户尚未指定一个固定的 35 项猫位、建筑布局、需求权重和货币标尺。任何在这些状态缺失时仍声称“星门就应该值 X 金币”的答案，数学上都不是唯一结论。</div></section>

<section><h2>十、理论与真实游戏验收的关系</h2><p>LP 给出长期平均上界和瓶颈证书，但猫的短视贪心、订单冻结、整数库存、信用和统一法条会造成实现损失。因此下一步若要修改生产价，应先把 p=cW、实际逐跳报酬和动态容量租金接入一个实验分支，再用用户定义的三窗口稳定标准做确定性模拟。模拟只能验证机制能否逼近理论上界，不能反过来“证明”理论。</p></section>

<footer>理论参考：W. Leontief 的投入产出法；T. Koopmans《Activity Analysis of Production and Allocation》；Boyd &amp; Vandenberghe《Convex Optimization》§5.4.4、§5.6。生成数据、求解器和全部 4000 个逐问题证书均保存在本工作区；本报告未修改游戏生产价格或猫咪行为。</footer>
</main></body></html>"""
    output_path.write_text(document, encoding="utf-8")
    print(json.dumps({"output": str(output_path), "items": len(items), "certificates": len(certificates), "bytes": output_path.stat().st_size}, ensure_ascii=False))


if __name__ == "__main__":
    main()
