import { useState } from "react";
import { compileLaw } from "../api";
import type { GameController } from "../game/controller";
import { formatMoney, nextEnactmentCost, REPEAL_COST } from "../game/engine";
import type { LawDraft } from "../game/types";
import { ITEM_BY_ID } from "../game/catalog";

export function LawPanel({ controller }: { controller: GameController }) {
  const state = controller.state;
  const [text, setText] = useState("如果听到木材订单，就把制作木材的候选评分提高3倍，否则按局部收益行动");
  const [draft, setDraft] = useState<LawDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [insertionIndex, setInsertionIndex] = useState(0);
  const cost = nextEnactmentCost(state);
  const starterLawsActive = state.laws.filter((law) => law.id.startsWith("starter-law-")).length;

  const requestCompile = async () => {
    if (text.trim().length < 2) return;
    setBusy(true);
    setMessage("");
    setDraft(null);
    try {
      setDraft(await compileLaw(text, state));
      setInsertionIndex(0);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "编译失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="law-panel">
      <div className="panel-summary">
        <strong>还可免费立法 {Math.max(0, 5 - state.enactmentCount)} 次</strong>
        <span>{starterLawsActive ? `${starterLawsActive} 条预制指引运行中` : "费用由国库支付"}</span>
      </div>

      <div className="recipe-note">全体猫共用一份逻辑，基础视野为曼哈顿半径 2，量子信标最高提升到 5。DeepSeek 可读取地标加成并自行选择直接动作、条件判断、修改候选评分或混合使用；新版本替换旧逻辑，法典不接收配料表。</div>

      <label className="field-label" htmlFor="law-text">新法条</label>
      <textarea id="law-text" data-testid="law-input" value={text} onChange={(event) => setText(event.target.value)} rows={3} />
      <div className="quick-laws">
        <button onClick={() => setText("如果听到木材订单，就把制作木材的候选评分提高3倍，否则按局部收益行动")}>响应木材订单</button>
        <button onClick={() => setText("如果当前工位能够制作木板，就优先制作木板，否则按局部收益行动")}>优先木板</button>
        <button onClick={() => setText("两格内木材较多时，把传递木材的候选评分提高3倍；仍可在有矿石且东边有猫时直接传递矿石")}>混合评分</button>
        <button onClick={() => setText("把齿轮的基础价格提高50%")}>齿轮 +50%</button>
        <button onClick={() => setText("对所有销售收入征收100%的税，税款进入国库")}>100%销售税</button>
      </div>
      <button className="primary wide" onClick={requestCompile} disabled={busy || text.trim().length < 2} data-testid="compile-law">
        {busy ? "正在生成…" : "生成法条"}
      </button>
      {message && <div className={message.includes("已颁布") || message.includes("正在修订") ? "success-box" : "error-box"}>{message}</div>}

      {draft && <section className="draft-card" data-testid="law-draft">
        <div className="draft-title"><div><span className="eyebrow">待颁布草案</span><h3>{draft.title}</h3></div><span className={`law-kind ${draft.category}`}>{draft.category === "tax" ? `税法 ${Math.round((draft.taxRate ?? 0) * 100)}%` : draft.category === "price" ? `价格 ×${draft.priceMultiplier ?? 1}` : "全体共享逻辑"}</span></div>
        <p>{draft.summary}</p>
        <div className="validation-row">
          <span className={draft.validation.syntax ? "pass" : "fail"}>{draft.validation.syntax ? "✓" : "×"} 语法</span>
          <span className={draft.validation.safety ? "pass" : "fail"}>{draft.validation.safety ? "✓" : "×"} 沙箱</span>
          <span>{draft.validation.examplesPassed}/{draft.validation.examplesTotal} 样例</span>
        </div>
        {draft.warnings.map((warning) => <div className="warning" key={warning}>⚠ {warning}</div>)}
        {draft.validation.messages.map((item) => <div className="validation-message" key={item}>{item}</div>)}
        {draft.category === "price" && <div className="price-preview">作用商品：{draft.priceItemId === "*" ? "全部商品" : ITEM_BY_ID.get(draft.priceItemId ?? "")?.name ?? draft.priceItemId}</div>}
        {draft.category === "behavior" && <details><summary>查看安全逻辑</summary><pre className="law-source">{draft.sourceCode}</pre></details>}
        {draft.category === "behavior" && <div className="warning">颁布后将替换当前共享逻辑；正在执行的动作不会中断。</div>}
        <label className="priority-select">颁布优先级
          <select value={insertionIndex} onChange={(event) => setInsertionIndex(Number(event.target.value))}>
            {Array.from({ length: state.laws.length + 1 }, (_, index) => <option value={index} key={index}>{index === 0 ? "最高优先级" : `置于第 ${index + 1} 位`}</option>)}
          </select>
        </label>
        <button className="enact-button" disabled={!draft.validation.syntax || !draft.validation.safety || state.treasuryCoins < cost} data-testid="enact-law" onClick={() => {
          const result = controller.enact(draft, insertionIndex);
          if (result.ok) {
            setDraft(null);
            setMessage(`《${draft.title}》已颁布`);
          } else setMessage(result.error ?? "颁布失败");
        }}>颁布 · {cost === 0 ? "免费" : `${formatMoney(cost)} 国库`}</button>
      </section>}

      <div className="section-heading"><h3>现行法典</h3><span>{state.laws.length} 条</span></div>
      {state.laws.length === 0 && <div className="empty-state">没有法条时，猫只会在两格视野内按局部收益贪心。</div>}
      <div className="law-list">
        {state.laws.map((law, index) => <article className={`law-card ${law.status}`} key={law.id} data-testid={`law-${law.id}`}>
          <div className="priority-number">{index + 1}</div>
          <div className="law-card-main">
            <div className="law-card-title"><strong>{law.title}</strong><span className={`law-kind ${law.category}`}>{law.category === "tax" ? `${Math.round((law.taxRate ?? 0) * 100)}% 税` : law.category === "price" ? `价格 ×${law.priceMultiplier ?? 1}` : law.category === "system" ? "基础经济法" : "全体共享逻辑"}</span></div>
            <p>{law.summary}</p>
            <small>命中 {law.hitCount}{law.invalidCount ? ` · 异常 ${law.invalidCount}` : ""}{law.status === "quarantined" ? " · 已隔离" : ""}</small>
          </div>
          <div className="law-actions">
            <button disabled={index === 0 || law.locked} onClick={() => controller.reorder(law.id, -1)} title="提高优先级">↑</button>
            <button disabled={index === state.laws.length - 1 || law.locked} onClick={() => controller.reorder(law.id, 1)} title="降低优先级">↓</button>
            <button disabled={law.locked} onClick={() => { setText(law.playerText); setDraft(null); setMessage(`正在修订《${law.title}》，修改后重新编译并颁布。`); }} title="修订为新版本">修</button>
            <button disabled={law.locked} className="danger" onClick={() => {
              const result = controller.repeal(law.id);
              if (!result.ok) setMessage(result.error ?? `废止需要 ${formatMoney(REPEAL_COST)}`);
            }} title={`废止需国库 ${formatMoney(REPEAL_COST)}`}>废</button>
          </div>
        </article>)}
      </div>
    </div>
  );
}
