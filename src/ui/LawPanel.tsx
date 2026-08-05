import { useState } from "react";
import { compileLaw } from "../api";
import type { GameController } from "../game/controller";
import { formatMoney, nextEnactmentCost, REPEAL_COST } from "../game/engine";
import { lawProgramSummary } from "../game/lawProgram";
import { safeSpeechTemplates } from "../game/speech";
import type { LawDraft } from "../game/types";

export function LawPanel({ controller }: { controller: GameController }) {
  const state = controller.state;
  const [text, setText] = useState("如果听到木材订单，就把制作木材的候选评分提高3倍，否则请求局部收益选择器");
  const [draft, setDraft] = useState<LawDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [insertionIndex, setInsertionIndex] = useState(0);
  const cost = nextEnactmentCost(state);

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

  return <div className="law-panel">
    <div className="panel-summary">
      <strong>还可免费立法 {Math.max(0, 5 - state.enactmentCount)} 次</strong>
      <span>统一法典 · 修订次数 {state.lawbookRevision}</span>
    </div>

    <div className="recipe-note">
      所有猫只在动作完成后，通过同一个共享 behavior 按优先级执行每条法规一次。法规颁布后永久不可修改；改变内容请起草新法并废止旧法。重排和废止不会调用 DeepSeek。
    </div>

    <label className="field-label" htmlFor="law-text">新法规</label>
    <textarea id="law-text" data-testid="law-input" value={text} onChange={(event) => setText(event.target.value)} rows={4} />
    <div className="quick-laws">
      <button onClick={() => setText("如果听到订单，提高制作和合同传递评分，然后请求选择器")}>订单物流</button>
      <button onClick={() => setText("如果当前工位能够制作木板，就直接制作木板；否则请求选择器")}>优先木板</button>
      <button onClick={() => setText("把所有商品的价格调整为基础价格的2倍，不改变任何动作或评分")}>全商品 ×2</button>
      <button onClick={() => setText("把齿轮价格提高50%，不改变任何动作或评分")}>齿轮 +50%</button>
      <button onClick={() => setText("对所有销售收入征收100%的税，税款进入国库")}>100%销售税</button>
      <button onClick={() => setText("当玩家仓库木板低于5件时，提高制作木板的候选评分，然后请求选择器")}>木板保底</button>
    </div>
    <button className="quick-law-warehouse" onClick={() => setText("wood 最低库存至少保持 5 件，低于下限时优先生产 wood")}>最低库存</button>
    <button className="primary wide" onClick={requestCompile} disabled={busy || text.trim().length < 2} data-testid="compile-law">
      {busy ? "正在生成…" : "生成不可修改的新法规"}
    </button>
    {message && <div className={message.includes("已颁布") ? "success-box" : "error-box"}>{message}</div>}

    {draft && <section className="draft-card" data-testid="law-draft">
      <div className="draft-title"><div><span className="eyebrow">待颁布草案</span><h3>{draft.title}</h3></div><span className="law-kind">统一法规</span></div>
      <p>{draft.summary}</p>
      <div className="price-preview">{lawProgramSummary(draft.program, draft.sourceCode)}</div>
      <div className="validation-row">
        <span className={draft.validation.syntax ? "pass" : "fail"}>{draft.validation.syntax ? "✓" : "×"} 语法</span>
        <span className={draft.validation.safety ? "pass" : "fail"}>{draft.validation.safety ? "✓" : "×"} 沙箱</span>
        <span>{draft.validation.examplesPassed}/{draft.validation.examplesTotal} 样例</span>
      </div>
      {draft.compileAudit && <small>DeepSeek {draft.compileAudit.model} · {draft.compileAudit.durationMs}ms · {draft.compileAudit.attempts} 次尝试</small>}
      {draft.warnings.map((warning) => <div className="warning" key={warning}>⚠ {warning}</div>)}
      {draft.validation.messages.map((item) => <div className="validation-message" key={item}>{item}</div>)}
      <div className="speech-preview"><strong>猫咪决策台词</strong><ul>{safeSpeechTemplates(draft.speechTemplates).map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul></div>
      <details><summary>查看不可变源码</summary><pre className="law-source">{draft.sourceCode}</pre></details>
      <div className="warning">确认颁布后不能修改原文或源码；改变内容需要另起草一条法规。</div>
      <label className="priority-select">颁布优先级
        <select value={insertionIndex} onChange={(event) => setInsertionIndex(Number(event.target.value))}>
          {Array.from({ length: state.laws.length + 1 }, (_, index) => <option value={index} key={index}>{index === 0 ? "最高优先级" : `置于第 ${index + 1} 位`}</option>)}
        </select>
      </label>
      <button className="enact-button" disabled={!draft.validation.syntax || !draft.validation.safety || state.treasuryCoins < cost} data-testid="enact-law" onClick={() => {
        const result = controller.enact(draft, insertionIndex);
        if (result.ok) {
          setDraft(null);
          setText("");
          setMessage(`《${draft.title}》已颁布；如需改变，请新建法规。`);
        } else setMessage(result.error ?? "颁布失败");
      }}>颁布 · {cost === 0 ? "免费" : `${formatMoney(cost)} 国库`}</button>
    </section>}

    <div className="section-heading"><h3>现行统一法典</h3><span>{state.laws.length} 条</span></div>
    {state.laws.length === 0 && <div className="empty-state">没有法规授权动作时，猫每5秒完成一次内部等待。</div>}
    <div className="law-list">
      {state.laws.map((law, index) => <article className={`law-card ${law.status}`} key={law.id} data-testid={`law-${law.id}`}>
        <div className="priority-number">{index + 1}</div>
        <div className="law-card-main">
          <div className="law-card-title"><strong>{law.title}</strong><span className="law-kind">{law.locked ? "基础法规" : "统一法规"}</span></div>
          <p>{law.summary}</p>
          <small>{lawProgramSummary(law.program, law.sourceCode)} · 命中 {law.hitCount}{law.invalidCount ? ` · 异常 ${law.invalidCount}` : ""}{law.status === "quarantined" ? " · 已隔离" : ""}</small>
          <details><summary>查看原文、台词与不可变源码</summary><p>{law.playerText}</p><div className="speech-preview compact"><strong>决策台词</strong><ul>{safeSpeechTemplates(law.speechTemplates).map((line, speechIndex) => <li key={`${speechIndex}-${line}`}>{line}</li>)}</ul></div><pre className="law-source">{law.sourceCode}</pre><small>{law.astHash}</small></details>
        </div>
        <div className="law-actions">
          <button disabled={index === 0 || law.locked} onClick={() => controller.reorder(law.id, -1)} title="提高优先级">↑</button>
          <button disabled={index === state.laws.length - 1 || law.locked} onClick={() => controller.reorder(law.id, 1)} title="降低优先级">↓</button>
          <button disabled={law.locked} className="danger" onClick={() => {
            const result = controller.repeal(law.id);
            if (!result.ok) setMessage(result.error ?? `废止需要 ${formatMoney(REPEAL_COST)}`);
          }} title={`永久废止需国库 ${formatMoney(REPEAL_COST)}`}>废</button>
        </div>
      </article>)}
    </div>
  </div>;
}
