import { useState } from "react";
import { ITEM_BY_ID } from "../game/catalog";
import type { GameController } from "../game/controller";
import { catStockPurchaseQuote, formatMoney, harvestResourceAt, itemPrice } from "../game/engine";
import type { CatState } from "../game/types";
import {
  bountyBroadcastsForCat,
  broadcastsForCat,
  buildingOfferReservedQuantity,
  buildingOfferBroadcastsForCat,
  creditAvailableCents,
  creditLimitCents,
  externalNetCentsAt,
  netWorthCents,
  planForCatPublic,
  readyContractForCat,
  signalsForCat,
} from "../game/market";
import catSpriteUrl from "../assets/cat-workshop-sprite.png?url";
import { LANDMARK_BY_ID, landmarkEffectsAt } from "../game/landmarks";

export function Inspector({ cat, controller, totalItems, onRemoved }: { cat?: CatState; controller: GameController; totalItems: number; onRemoved: () => void }) {
  const state = controller.state;
  const [purchaseMessage, setPurchaseMessage] = useState<{ ok: boolean; text: string } | null>(null);
  if (!cat) return <div className="empty-state">点击画布中的猫咪查看详情。</div>;

  const inventory = Object.entries(cat.inventory).filter(([, quantity]) => quantity > 0).sort((a, b) => b[1] - a[1]);
  const resourceItemId = harvestResourceAt(state, cat.position);
  const productionPlan = planForCatPublic(state, cat.id);
  const ownOrders = state.demandOrders.filter((order) => order.buyerKind === "cat" && order.buyerCatId === cat.id && order.status === "open");
  const localSignals = signalsForCat(state, cat.id);
  const bountySignals = bountyBroadcastsForCat(state, cat.id);
  const heardOffers = buildingOfferBroadcastsForCat(state, cat.id);
  const broadcasts = broadcastsForCat(state, cat.id);
  const ownOffers = state.buildingOffers.filter((offer) => offer.sellerCatId === cat.id && offer.status === "open");
  const carrying = readyContractForCat(state, cat.id);
  const activeContracts = state.shipmentContracts.filter((contract) => contract.status !== "delivered" && contract.routeCatIds.includes(cat.id));
  const netWorth = netWorthCents(state, cat, (itemId) => itemPrice(state, itemId));
  const creditLimit = creditLimitCents(state, cat, (itemId) => itemPrice(state, itemId));
  const creditAvailable = creditAvailableCents(state, cat, (itemId) => itemPrice(state, itemId));
  const landmarkEffects = landmarkEffectsAt(state, cat.position);
  const coveredLandmarks = Object.entries(landmarkEffects.stacks).filter(([, count]) => count > 0);
  const liquidationInventory = { ...cat.inventory };
  for (const [itemId, quantity] of Object.entries(cat.action?.reserved ?? {})) liquidationInventory[itemId] = (liquidationInventory[itemId] ?? 0) + quantity;
  const liquidationStockCents = Object.entries(liquidationInventory).reduce((sum, [itemId, quantity]) => (
    sum + Math.max(0, quantity) * externalNetCentsAt(state, itemId, (id) => itemPrice(state, id), cat)
  ), 0);
  const liquidationAssetsCents = cat.coins + liquidationStockCents;
  const liquidationDeltaCents = liquidationAssetsCents - cat.debtCents;
  const catPurchaseQuote = catStockPurchaseQuote(state, cat.id);
  const catPurchaseControls = <>
    <div className="section-heading"><h3>玩家收购</h3><span>可收购 {catPurchaseQuote.totalQuantity} 件 · {formatMoney(catPurchaseQuote.totalCostCents)}</span></div>
    <p className="recipe-note">点击单项现货即可收进玩家仓库；作业、计划、运输合同或建筑报价占用的数量不会重复出售。</p>
    {purchaseMessage && <div className={purchaseMessage.ok ? "success-box" : "error-box"} data-testid="cat-purchase-message">{purchaseMessage.text}</div>}
    {catPurchaseQuote.totalQuantity === 0 ? <div className="empty-state small">这只猫目前没有可收购现货</div> : <div className="inventory-list cat-purchase-list">{inventory.map(([id]) => {
      const item = ITEM_BY_ID.get(id);
      const lines = catPurchaseQuote.lines.filter((line) => line.itemId === id);
      const available = lines.reduce((sum, line) => sum + line.quantity, 0);
      const lowest = lines.reduce((price, line) => Math.min(price, line.unitPriceCents), Number.POSITIVE_INFINITY);
      if (available < 1) return null;
      return <div key={`purchase-${id}`} className="cat-stock-row">
        <span>{item?.emoji} {item?.name ?? id} · 可收购 {available}</span>
        <button
          data-testid={`buy-cat-${cat.id}-${id}`}
          disabled={state.treasuryCoins < lowest}
          onClick={() => {
            const result = controller.buyCatItem(cat.id, id);
            setPurchaseMessage({ ok: result.ok, text: result.ok
              ? `${item?.emoji ?? ""} 已收购 1 件，支付 ${formatMoney(result.cost ?? 0)}。`
              : result.error ?? "收购失败" });
          }}
        >收购 1 件 · {formatMoney(lowest)}</button>
      </div>;
    })}</div>}
  </>;

  return <div className="inspector">
    {catPurchaseControls}
    <section className="cat-profile">
      <div className="cat-avatar" style={{ backgroundImage: `url(${catSpriteUrl})` }} role="img" aria-label="姜黄色工匠猫" />
      <div><span className="eyebrow">猫咪 #{cat.createdIndex}</span><h2>工位 ({cat.position.x}, {cat.position.y})</h2><p>{resourceItemId ? `${ITEM_BY_ID.get(resourceItemId)?.emoji} ${ITEM_BY_ID.get(resourceItemId)?.name}采集区` : "普通工位"}</p></div>
    </section>

    <div className="section-heading"><h3>地标加成</h3><span>{coveredLandmarks.length ? `${coveredLandmarks.length} 类覆盖` : "无覆盖"}</span></div>
    <section className="detail-block landmark-effect-block" data-testid="cat-landmark-effects">
      <Detail label="覆盖层数" value={coveredLandmarks.length ? coveredLandmarks.map(([id, count]) => `${LANDMARK_BY_ID.get(id as import("../game/types").LandmarkId)?.emoji ?? ""}${LANDMARK_BY_ID.get(id as import("../game/types").LandmarkId)?.name ?? id}×${count}`).join(" · ") : "无"} />
      <Detail label="有效视野" value={`曼哈顿半径 ${landmarkEffects.effectiveVisionRadius}`} />
      <Detail label="全部动作加速" value={`${Math.round(landmarkEffects.actionSpeedReduction * 100)}%`} />
      <Detail label="制作专项加速" value={`${Math.round(landmarkEffects.craftSpeedReduction * 100)}%`} />
      <Detail label="传递专项加速" value={`${Math.round(landmarkEffects.passSpeedReduction * 100)}%`} />
      <Detail label="外部售价" value={`+${Math.round(landmarkEffects.saleValueBonus * 100)}%`} />
      <Detail label="额外信用" value={`+${formatMoney(landmarkEffects.creditBonusCents)}`} />
      <Detail label="中转费" value={`+${Math.round(landmarkEffects.carrierFeeBonus * 100)}%`} />
    </section>

    <div className="section-heading"><h3>资产</h3><span>{totalItems} 件自有物品</span></div>
    <section className="detail-block asset-block" data-testid="cat-assets">
      <Detail label="现金" value={formatMoney(cat.coins)} />
      <Detail label="债务" value={formatMoney(cat.debtCents)} />
      <Detail label="净资产" value={formatMoney(netWorth)} />
      <Detail label="信用额度" value={formatMoney(creditLimit)} />
      <Detail label="可用信用" value={formatMoney(creditAvailable)} />
      <Detail label="冻结保证金" value={formatMoney(cat.escrowReservedCents)} />
    </section>
    <section className="cat-removal-card" data-testid="cat-removal">
      <strong>删除猫咪并结算</strong>
      <span>先偿还贷款，再把现金和库存净值转入国库；未完成订单与运输合同会取消。</span>
      <div><span>可清算资产</span><b>{formatMoney(liquidationAssetsCents)}</b></div>
      <div><span>偿还贷款</span><b>{formatMoney(cat.debtCents)}</b></div>
      <div><span>国库变化</span><b className={liquidationDeltaCents >= 0 ? "positive" : "negative"}>{formatSignedMoney(liquidationDeltaCents)}</b></div>
      <button className="small-action danger" disabled={state.cats.length <= 1} onClick={() => {
        const confirmed = window.confirm(`确定删除猫咪 #${cat.createdIndex} 吗？将偿还 ${formatMoney(cat.debtCents)} 贷款，国库变化 ${formatSignedMoney(liquidationDeltaCents)}。未完成市场事务会取消。`);
        if (!confirmed) return;
        const result = controller.removeCat(cat.id);
        if (result.ok) onRemoved();
      }}>{state.cats.length <= 1 ? "至少保留一只猫咪" : "删除并结算"}</button>
    </section>
    {inventory.length === 0 ? <div className="empty-state small">库存为空</div> : <div className="inventory-list compact-inventory">{inventory.map(([id, quantity]) => {
      const item = ITEM_BY_ID.get(id);
      const offered = buildingOfferReservedQuantity(state, cat.id, id);
      return <div key={id}><span>{item?.emoji} {item?.name ?? id}{offered ? ` · 挂牌预留 ${offered}` : ""}</span><strong>×{quantity}</strong></div>;
    })}</div>}

    <div className="section-heading"><h3>市场</h3><span>猫咪署名 · 全局即时广播</span></div>
    <section className="detail-block" data-testid="cat-market">
      <Detail label="自己的订单" value={ownOrders.length ? ownOrders.map((order) => `${order.id}:${order.itemId} 到货${formatMoney(order.maxDeliveredCents)} · 预留${formatMoney(order.reservedCents)} · ${order.committedSellerCatId ?? "待报价"}`).join(" · ") : "无"} />
      <Detail label="听到的订单" value={localSignals.length ? localSignals.slice(0, 4).map((signal) => {
        const demand = state.demandOrders.find((entry) => entry.id === signal.orderId);
        const source = broadcasts.find((entry) => entry.kind === "demand-open" && entry.subjectId === signal.orderId)?.sourceCatId;
        return `${signal.orderId}:${demand?.itemId ?? "?"} 由${source ?? "?"}广播`;
      }).join(" · ") : "无"} />
      <Detail label="建筑报价" value={ownOffers.length ? ownOffers.map((offer) => `${offer.id}:${offer.itemId}@${formatMoney(offer.askCents)}`).join(" · ") : "无"} />
      <Detail label="听到的悬赏" value={bountySignals.length ? bountySignals.slice(0, 4).map((signal) => `${signal.itemId}@${formatMoney(signal.amountCents)} 由${signal.sourceCatId}广播`).join(" · ") : "无"} />
      <Detail label="听到的建筑报价" value={heardOffers.length ? heardOffers.slice(0, 3).map((signal) => `${signal.itemId}@${formatMoney(signal.amountCents)} 由${signal.sourceCatId}广播`).join(" · ") : "无"} />
      <Detail label="最近广播" value={broadcasts.length ? broadcasts.slice(0, 4).map((signal) => `${signal.sourceCatId}:${signal.kind}/${signal.itemId}`).join(" · ") : "无"} />
      <Detail label="托管货物" value={carrying ? `${carrying.id}:${carrying.itemId}` : "无"} />
      <Detail label="合同路线" value={activeContracts.length ? activeContracts.map((contract) => `${contract.id} ${contract.routeCatIds.join("→")}`).join(" · ") : "无"} />
    </section>

    <div className="section-heading"><h3>行动</h3><span>{cat.action ? "工作中" : "待机"}</span></div>
    <section className="detail-block action-block" data-testid="cat-action-detail">
      <Detail label="生产计划" value={productionPlan ? `${ITEM_BY_ID.get(productionPlan.outputItemId)?.emoji ?? ""} ${productionPlan.outputItemId} · ${productionPlan.reason}` : "无"} />
      <Detail label="预计收入" value={productionPlan ? formatMoney(productionPlan.expectedRevenueCents) : "—"} />
      <Detail label="计划阶段" value={productionPlan?.phase ?? "—"} />
      <Detail label="可靠原料包" value={productionPlan ? formatMoney(productionPlan.bundleCostCents ?? 0) : "—"} />
      <Detail label="融资预留" value={productionPlan ? formatMoney(productionPlan.financingReserveCents ?? 0) : "—"} />
      <Detail label="预计净收益" value={productionPlan ? formatMoney(productionPlan.expectedProfitCents ?? 0) : "—"} />
      <Detail label="当前动作" value={cat.action ? `${actionName(cat.action.type)} ${ITEM_BY_ID.get(cat.action.itemId)?.emoji ?? ""} ${cat.action.itemId}` : "待机"} />
      <Detail label="剩余时间" value={cat.action ? `${Math.max(0, (cat.action.endsAt - state.simTime) / 1_000).toFixed(1)} 秒` : "—"} />
      <Detail label="决策理由" value={cat.lastDecision} />
    </section>
    <details>
      <summary>决策记录</summary>
      <ol className="trace-list">{cat.decisionTrace.length ? cat.decisionTrace.map((trace, index) => <li key={`${trace}-${index}`}>{trace}</li>) : <li>尚无决策记录</li>}</ol>
    </details>
  </div>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function formatSignedMoney(cents: number): string {
  const sign = cents > 0 ? "+" : cents < 0 ? "−" : "";
  return `${sign}${(Math.abs(cents) / 100).toFixed(2)} 🪙`;
}

function actionName(type: "craft" | "pass" | "wait") {
  return type === "craft" ? "制作" : type === "pass" ? "运输" : "内部等待";
}
