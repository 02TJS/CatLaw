import { useState } from "react";
import {
  canUnlockRecipe,
  CATALOG_ANALYSIS,
  describeRecipe,
  ITEM_BY_ID,
  INTRO_RECIPE_IDS,
  INDUSTRIAL_GATE_RECIPE_IDS,
  ITEMS,
  MARKET_CERTIFICATION_ITEM_IDS,
  RECIPE_BY_ID,
  RECIPE_BY_OUTPUT,
  missingProductionCertifications,
  recipePrerequisiteIds,
  recipeUnlockCost,
} from "../game/catalog";
import type { GameController } from "../game/controller";
import { formatMoney, inventoryTotal, itemPrice } from "../game/engine";
import { difficultySiteRequirements, effectiveRecipeInputs } from "../game/difficulty";

const TIER_NAMES = ["基础采集", "手工作坊", "机械制造", "电气工业", "电子自动化", "计算与核能", "航天时代", "量子时代", "星门工程"];

export function CatalogPanel({ controller }: { controller: GameController }) {
  const state = controller.state;
  const [message, setMessage] = useState("");
  const craftedItems = ITEMS.filter((item) => state.itemStats[item.id].crafted > 0).map((item) => item.id);
  const certifiedItems = MARKET_CERTIFICATION_ITEM_IDS.filter((itemId) => state.itemStats[itemId].crafted > 0);
  const missingCertificationItems = MARKET_CERTIFICATION_ITEM_IDS.filter((itemId) => !certifiedItems.includes(itemId));

  return <div className="catalog-panel">
    <div className="panel-summary">
      <strong>配方图</strong>
      <span>已解锁 {state.unlockedRecipes.length} / {ITEMS.length}</span>
    </div>
    <div className="recipe-note">前 9 项免费启蒙；第 10–15 项需用国库金币购买，解锁后教学目标会继续到齿轮。第 16–20 项还要求这六种中间品都曾实际制造。</div>
    <div className={`certification-card ${missingCertificationItems.length === 0 ? "complete" : ""}`} data-testid="industry-certification">
      <div><strong>产业认证 {certifiedItems.length}/6</strong><span>解锁第 16–20 项的共同门槛</span></div>
      <small>{missingCertificationItems.length === 0
        ? "✓ 六种中间品均已实际制造"
        : `待认证：${missingCertificationItems.map((id) => `${ITEM_BY_ID.get(id)?.emoji} ${ITEM_BY_ID.get(id)?.name}`).join("、")}`}</small>
    </div>
    {message && <div className={message.includes("已解锁") ? "success-box" : "error-box"}>{message}</div>}
    {TIER_NAMES.map((tierName, tier) => {
      const tierItems = ITEMS.filter((item) => item.tier === tier);
      const unlockedCount = tierItems.filter((item) => state.unlockedRecipes.includes(RECIPE_BY_OUTPUT.get(item.id)!.id)).length;
      return <section className="tier-section" key={tierName}>
        <div className="section-heading"><h3>{tier}. {tierName}</h3><span>{unlockedCount}/{tierItems.length}</span></div>
        <div className="item-grid">
          {tierItems.map((item) => {
            const entry = RECIPE_BY_OUTPUT.get(item.id)!;
            const unlocked = state.unlockedRecipes.includes(entry.id);
            const available = canUnlockRecipe(entry.id, state.unlockedRecipes, craftedItems);
            const cost = recipeUnlockCost(entry.id);
            const stats = state.itemStats[item.id];
            const missing = recipePrerequisiteIds(entry.id)
              .filter((id) => !state.unlockedRecipes.includes(id))
              .map((id) => ITEM_BY_ID.get(RECIPE_BY_ID.get(id)!.output)?.name ?? id);
            const missingCertifications = missingProductionCertifications(entry.id, craftedItems)
              .map((id) => ITEM_BY_ID.get(id)?.name ?? id);
            const affordable = state.treasuryCoins >= cost;
            const siteLabel = difficultySiteRequirements(entry, state.difficulty).map((requirement) => {
              const building = ITEM_BY_ID.get(requirement.buildingItemId);
              return `${building?.emoji ?? "🏗️"} ${building?.name ?? requirement.buildingItemId} ${requirement.maxManhattanDistance}格内`;
            }).join("、");
            return <article
              className={`item-card recipe-card ${unlocked ? "unlocked" : available ? "available" : "locked"}`}
              key={item.id}
              title={describeRecipe(entry.id)}
              data-testid={`recipe-${entry.id}`}
            >
              <div className="item-emoji">{item.emoji}</div>
              <div className="recipe-card-main">
                {siteLabel && <small className="site-requirement">制造地点：{siteLabel}</small>}
                <div className="recipe-title"><strong>{item.name}</strong>{state.discoveredItems.includes(item.id) && <span>已制造</span>}</div>
                <small className="recipe-formula">{describeRecipe(entry.id)}{state.difficulty === 5 && effectiveRecipeInputs(entry, state.difficulty).some((input, index) => input.quantity !== entry.inputs[index]?.quantity) ? " · 难度5大宗配料" : ""}</small>
                <small>基础 {formatMoney(CATALOG_ANALYSIS.basePrices[item.id] * 100)} · 实际 {formatMoney(itemPrice(state, item.id))} · 库存 {inventoryTotal(state, item.id)}</small>
                <small>制 {stats.crafted} / 售 {stats.sold}</small>
                {unlocked
                  ? <span className="recipe-status learned">✓ {INTRO_RECIPE_IDS.includes(entry.id) ? "开局免费启蒙" : "猫咪已学会"}</span>
                  : available
                    ? <button
                        className="recipe-unlock"
                        disabled={!affordable}
                        data-testid={`unlock-${entry.id}`}
                        onClick={() => {
                          const result = controller.unlockRecipe(entry.id);
                          setMessage(result.ok ? `${item.emoji} ${item.name}配方已解锁，所有猫都已学会。` : result.error ?? "解锁失败");
                        }}
                      >{affordable ? `解锁 · ${formatMoney(cost)}` : `还差 ${formatMoney(cost - state.treasuryCoins)}`}</button>
                    : <span className="recipe-status prerequisite">{missing.length > 0
                      ? `先解锁：${missing.join("、")}`
                      : INDUSTRIAL_GATE_RECIPE_IDS.includes(entry.id) && missingCertifications.length > 0
                        ? `产业认证缺：${missingCertifications.join("、")}`
                        : "尚未满足解锁条件"}</span>}
              </div>
            </article>;
          })}
        </div>
      </section>;
    })}
  </div>;
}
