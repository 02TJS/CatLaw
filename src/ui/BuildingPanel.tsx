import { useState } from "react";
import { DEPLOYABLE_BUILDING_IDS, ITEM_BY_ID, ITEMS } from "../game/catalog";
import type { GameController } from "../game/controller";
import { formatMoney, warehouseQuote } from "../game/engine";
import { LANDMARK_BY_ID, LANDMARK_DEFINITIONS } from "../game/landmarks";
import type { LandmarkId } from "../game/types";

interface PlacementFeedback {
  itemId: string;
  position: { x: number; y: number };
  ok: boolean;
  error?: string;
}

interface LandmarkPlacementFeedback {
  landmarkId: LandmarkId;
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
  placingLandmarkId: LandmarkId | null;
  landmarkFeedback: LandmarkPlacementFeedback | null;
  onStartLandmarkPlacement: (landmarkId: LandmarkId) => void;
  onCancelLandmarkPlacement: () => void;
}

const TIER_NAMES = ["基础采集", "手工作坊", "机械制造", "电气工业", "电子自动化", "计算与核能", "航天时代", "量子时代", "星门工程"];

export function BuildingPanel({
  controller,
  placingItemId,
  feedback,
  onStartPlacement,
  onCancelPlacement,
  placingLandmarkId,
  landmarkFeedback,
  onStartLandmarkPlacement,
  onCancelLandmarkPlacement,
}: Props) {
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

    <section className="landmark-engineering" data-testid="landmark-engineering">
      <div className="section-heading"><h3>地标工程</h3><span>图纸 {state.unlockedLandmarkIds.length}/{LANDMARK_DEFINITIONS.length} · 已建 {state.landmarks.length}</span></div>
      <p className="recipe-note">发现全部建材后用国库永久购买图纸，再消耗仓库现货选址建造。范围按曼哈顿距离计算，同类最多叠加 3 层。</p>
      {placingLandmarkId && <div className="placement-mode-card landmark-placement-card" data-testid="landmark-placement-mode">
        <strong>{LANDMARK_BY_ID.get(placingLandmarkId)?.emoji} 正在建造{LANDMARK_BY_ID.get(placingLandmarkId)?.name}</strong>
        <span>点击画布中的合法普通空地；取消或失败均不扣材料。</span>
        <button className="small-action" onClick={onCancelLandmarkPlacement}>取消选址</button>
      </div>}
      {landmarkFeedback && <div className={landmarkFeedback.ok ? "success-box" : "error-box"} data-testid="landmark-message">
        {landmarkFeedback.ok
          ? `地标已落成于 (${landmarkFeedback.position.x}, ${landmarkFeedback.position.y})`
          : landmarkFeedback.error ?? "地标建造失败"}
      </div>}
      <div className="landmark-grid">
        {LANDMARK_DEFINITIONS.map((definition) => {
          const unlocked = state.unlockedLandmarkIds.includes(definition.id);
          const undiscovered = definition.materials.filter((material) => !state.discoveredItems.includes(material.itemId));
          const missing = definition.materials.filter((material) => (state.playerBuildingInventory[material.itemId] ?? 0) < material.quantity);
          return <article className={`landmark-card ${unlocked ? "unlocked" : "locked"}`} key={definition.id} data-testid={`landmark-card-${definition.id}`}>
            <div className="landmark-title"><span>{definition.emoji}</span><div><strong>{definition.name}</strong><small>{definition.description}</small></div></div>
            <div className="landmark-materials">{definition.materials.map((material) => {
              const item = ITEM_BY_ID.get(material.itemId);
              const stored = state.playerBuildingInventory[material.itemId] ?? 0;
              return <span className={stored >= material.quantity ? "enough" : "short"} key={material.itemId} title={item?.name}>
                {item?.emoji} {stored}/{material.quantity}
              </span>;
            })}</div>
            <small className="landmark-progress">发现 {definition.materials.length - undiscovered.length}/{definition.materials.length} · 拆除返还每项一半向下取整</small>
            <div className="landmark-actions">
              {!unlocked ? <button
                data-testid={`buy-blueprint-${definition.id}`}
                disabled={undiscovered.length > 0 || state.treasuryCoins < definition.blueprintPriceCents}
                onClick={() => {
                  const result = controller.buyLandmarkBlueprint(definition.id);
                  setMessage({ ok: result.ok, text: result.ok ? `${definition.emoji} ${definition.name}图纸已永久解锁。` : result.error ?? "购买失败" });
                }}
              >{undiscovered.length > 0 ? `待发现 ${undiscovered.length}` : `图纸 ${formatMoney(definition.blueprintPriceCents)}`}</button> : <span className="blueprint-owned">✓ 图纸已拥有</span>}
              <button
                data-testid={`build-landmark-${definition.id}`}
                className={placingLandmarkId === definition.id ? "active" : ""}
                disabled={!unlocked || missing.length > 0}
                onClick={() => onStartLandmarkPlacement(definition.id)}
              >{placingLandmarkId === definition.id ? "选址中" : missing.length > 0 ? `缺料 ${missing.length}` : "建造"}</button>
            </div>
          </article>;
        })}
      </div>
      <div className="section-heading"><h3>已建地标</h3><span>{state.landmarks.length} 座</span></div>
      {state.landmarks.length === 0 ? <div className="empty-state small">暂无地标。</div> : <div className="deployed-building-list landmark-list">
        {state.landmarks.map((landmark) => {
          const definition = LANDMARK_BY_ID.get(landmark.landmarkId);
          return <div key={landmark.id} data-testid={`deployed-landmark-${landmark.id}`}>
            <span>{definition?.emoji} {definition?.name} · ({landmark.position.x}, {landmark.position.y})</span>
            <button onClick={() => {
              const result = controller.dismantleLandmark(landmark.id);
              setMessage({ ok: result.ok, text: result.ok ? "地标已拆除，半数建材退回仓库。" : result.error ?? "拆除失败" });
            }}>拆除</button>
          </div>;
        })}
      </div>}
    </section>

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
