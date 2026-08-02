import { useState } from "react";
import { DEPLOYABLE_BUILDING_IDS, ITEM_BY_ID, ITEMS } from "../game/catalog";
import type { GameController } from "../game/controller";
import { formatMoney, warehouseQuote } from "../game/engine";

interface PlacementFeedback {
  itemId: string;
  position: { x: number; y: number };
  ok: boolean;
  error?: string;
}

interface Props {
  controller: GameController;
  placingItemId: string | null;
  feedback: PlacementFeedback | null;
  onStartPlacement: (itemId: string) => void;
  onCancelPlacement: () => void;
}

const TIER_NAMES = ["基础采集", "手工作坊", "机械制造", "电气工业", "电子自动化", "计算与核能", "航天时代", "量子时代", "星门工程"];

export function BuildingPanel({ controller, placingItemId, feedback, onStartPlacement, onCancelPlacement }: Props) {
  const state = controller.state;
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const totalStored = Object.values(state.playerBuildingInventory).reduce((sum, quantity) => sum + quantity, 0);
  const stockedKinds = ITEMS.filter((item) => (state.playerBuildingInventory[item.id] ?? 0) > 0).length;

  return <div className="building-panel warehouse-panel">
    <div className="panel-summary">
      <span>玩家仓库</span>
      <strong>{stockedKinds}/{ITEMS.length} 种 · {totalStored} 件</strong>
    </div>
    <p className="recipe-note">65 种商品全部陈列。猫咪未被生产计划、订单、合同或建筑报价占用的现货都可收购；货款归卖方猫咪，商品进入仓库。</p>

    {placingItemId && <div className="placement-mode-card" data-testid="building-placement-mode">
      <strong>{ITEM_BY_ID.get(placingItemId)?.emoji} 正在放置{ITEM_BY_ID.get(placingItemId)?.name}</strong>
      <span>画布会显示作用范围；红色地块不可放置。</span>
      <button className="small-action" onClick={onCancelPlacement}>取消放置</button>
    </div>}
    {(feedback || message) && <div className={(feedback ? feedback.ok : message?.ok) ? "success-box" : "error-box"} data-testid="warehouse-message">
      {feedback ? (feedback.ok
        ? `已放置在 (${feedback.position.x}, ${feedback.position.y})`
        : feedback.error ?? "放置失败") : message?.text}
    </div>}

    {TIER_NAMES.map((tierName, tier) => {
      const tierItems = ITEMS.filter((item) => item.tier === tier);
      const tierStored = tierItems.filter((item) => (state.playerBuildingInventory[item.id] ?? 0) > 0).length;
      return <section className="tier-section warehouse-tier" key={tierName}>
        <div className="section-heading"><h3>{tier}. {tierName}</h3><span>陈列 {tierStored}/{tierItems.length}</span></div>
        <div className="warehouse-grid">
          {tierItems.map((item) => {
            const stored = state.playerBuildingInventory[item.id] ?? 0;
            const quote = warehouseQuote(state, item.id);
            const deployable = DEPLOYABLE_BUILDING_IDS.includes(item.id as typeof DEPLOYABLE_BUILDING_IDS[number]);
            const affordable = state.treasuryCoins >= quote.unitPriceCents;
            return <article className={`warehouse-item-card ${stored > 0 ? "stocked" : "empty"}`} key={item.id} data-testid={`warehouse-item-${item.id}`}>
              <span className="warehouse-emoji">{item.emoji}</span>
              <div className="warehouse-item-main">
                <strong>{item.name}</strong>
                <small>仓库 ×{stored} · 猫咪现货 {quote.availableQuantity}</small>
                <small>{quote.availableQuantity > 0 ? `最低 ${formatMoney(quote.unitPriceCents)}` : "等待猫咪产出可售现货"}</small>
                <div className="warehouse-actions">
                  <button
                    disabled={quote.availableQuantity < 1 || !affordable}
                    data-testid={`buy-item-${item.id}`}
                    onClick={() => {
                      const result = controller.buyWarehouseItem(item.id);
                      setMessage({
                        ok: result.ok,
                        text: result.ok
                          ? `${item.emoji} 已收购 1 件${item.name}并存入仓库，支付 ${formatMoney(result.cost ?? 0)}。`
                          : result.error ?? "收购失败",
                      });
                    }}
                  >{quote.availableQuantity < 1 ? "暂无现货" : affordable ? "收购 1 件" : "国库不足"}</button>
                  {deployable && stored > 0 && <button className={placingItemId === item.id ? "active" : ""} onClick={() => onStartPlacement(item.id)}>
                    {placingItemId === item.id ? "选地块中" : "放置"}
                  </button>}
                </div>
              </div>
            </article>;
          })}
        </div>
      </section>;
    })}

    <div className="section-heading"><h3>已放置建筑</h3><span>{state.buildings.length} 栋</span></div>
    {state.buildings.length === 0 ? <div className="empty-state small">暂无地面建筑。</div> : <div className="deployed-building-list">
      {state.buildings.map((building) => <div key={building.id}>
        <span>{ITEM_BY_ID.get(building.itemId)?.emoji} {ITEM_BY_ID.get(building.itemId)?.name} · ({building.position.x}, {building.position.y})</span>
        <button onClick={() => {
          const result = controller.dismantleBuilding(building.id);
          setMessage({ ok: result.ok, text: result.ok ? "建筑已拆除并退回仓库。" : result.error ?? "拆除失败" });
        }}>拆除</button>
      </div>)}
    </div>}
  </div>;
}
