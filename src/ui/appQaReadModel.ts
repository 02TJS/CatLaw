import type { GameController } from "../game/controller";
import {
  catLiquidationPreview,
  catStockPurchaseQuote,
  grossProductionValuePerMinute,
  inventoryTotal,
  itemPrice,
  purchasableParcels,
  warehouseBulkSellQuote,
  warehouseQuote,
  warehouseSellPrice,
  WEALTH_HISTORY_SAMPLE_INTERVAL_MS,
} from "../game/engine";
import {
  canUnlockRecipe,
  ITEM_BY_ID,
  ITEMS,
  MARKET_CERTIFICATION_ITEM_IDS,
  RECIPES,
  recipeUnlockCost,
} from "../game/catalog";
import { localVisibleCats, LOCAL_VISION_RADIUS } from "../game/localPlanner";
import { DIFFICULTY_PROFILES } from "../game/difficulty";
import type { LandmarkId } from "../game/types";
import { achievementGrade, pendingAchievements } from "../game/achievements";
import {
  catCashCents,
  playerWarehouseInventory,
  treasuryCashCents,
} from "../game/domainSemantics";
import {
  landmarkDisplayName,
  LANDMARK_BY_ID,
  LANDMARK_DEFINITIONS,
  landmarkEffectsAt,
  NAMED_LANDMARK_EMOJI,
  NAMED_LANDMARK_WOOD_COST,
} from "../game/landmarks";
import { lawProgramSummary, SHARED_BEHAVIOR_HASH } from "../game/lawProgram";
import { safeSpeechTemplates, speechEventIsVisible } from "../game/speech";
import { positionKey, resourceHarvestTiles, resourceNodesAtPosition } from "../game/world";
import {
  buildMapLensSnapshot,
  ITEM_SCOPED_LENSES,
  mapLensTitle,
  type MapLensId,
  type WealthLensMode,
} from "./mapLenses";
import { itemQualityLevel, itemQualityPalette } from "./itemQuality";
import type { UiPreferences } from "./uiPreferences";
import {
  bountyBroadcastsForCat,
  broadcastsForCat,
  buildingOfferBroadcastsForCat,
  creditAvailableCents,
  netWorthCents,
  planForCatPublic,
  readyContractForCat,
  signalsForCat,
} from "../game/market";
import type {
  CommerceFeedback,
  LandmarkPlacementFeedback,
  PlacementFeedback,
} from "./appTypes";
import type { RuntimeSpeedMultiplier } from "../game/domainUnits";

export function renderGameToText(
  state: GameController["state"],
  speedMultiplier: RuntimeSpeedMultiplier,
  selectedCatId: string,
  placingBuildingItemId: string | null,
  placementFeedback: PlacementFeedback | null,
  placingLandmarkId: LandmarkId | null,
  landmarkFeedback: LandmarkPlacementFeedback | null,
  uiPreferences: UiPreferences,
  mapInteractionMode: boolean,
  mapLensId: MapLensId,
  mapLensItemId: string | null,
  wealthLensMode: WealthLensMode,
  wealthLensWindowMs: number,
  commerceFeedback: CommerceFeedback | null,
  achievementReviewArmed: boolean,
): string {
  const craftedItems = ITEMS.filter((item) => state.itemStats[item.id].crafted > 0).map((item) => item.id);
  const certifiedItems = MARKET_CERTIFICATION_ITEM_IDS.filter((itemId) => state.itemStats[itemId].crafted > 0);
  const missingCertificationItems = MARKET_CERTIFICATION_ITEM_IDS.filter((itemId) => !certifiedItems.includes(itemId));
  const positionMap = new Map(state.cats.map((cat) => [positionKey(cat.position), cat]));
  const decisionLaws = state.laws.filter((law) => law.status === "active");
  const wealthLensOptions = { wealthMode: wealthLensMode, wealthWindowMs: wealthLensWindowMs };
  const activeMapLens = mapInteractionMode ? buildMapLensSnapshot(state, mapLensId, mapLensItemId, wealthLensOptions) : null;
  const warehouseInventory = playerWarehouseInventory(state);
  return JSON.stringify({
    coordinateSystem: "整数方格；原点(0,0)；x向右增加，y向下增加；只可向四邻传递",
    simTimeMs: Math.round(state.simTime),
    difficulty: DIFFICULTY_PROFILES[state.difficulty],
    paused: state.paused,
    runtimeSpeedMultiplier: speedMultiplier,
    visualPreferences: {
      controlScale: uiPreferences.controlScale,
      interfaceFontScale: uiPreferences.interfaceFontScale,
      speechBubbleScale: uiPreferences.speechBubbleScale,
      mapScale: uiPreferences.mapScale,
      speechFrequencyPercent: state.speechFrequency,
      speechBubbleAvoidsControls: [
        "dragRegion", "headlineStats", "mainCommerce", "windowControls", "dock",
        "filterPalette", "legend", "drawer", "commerceFeedback", "quickStats", "tileActionMenu",
      ],
    },
    speedShortcuts: { "1": "1x", "2": "2x", "3": "4x", "4": "8x", p: "pause" },
    treasuryCents: treasuryCashCents(state),
    personalCashCents: state.cats.reduce((sum, cat) => sum + catCashCents(cat), 0),
    totalDebtCents: state.cats.reduce((sum, cat) => sum + cat.debtCents, 0),
    totalSalesCents: state.totalSales,
    totalProductionValueCents: state.totalProductionValueCents,
    grossProductionValuePerMinuteCents: grossProductionValuePerMinute(state),
    commerceAnimation: commerceFeedback ? {
      active: true,
      ok: commerceFeedback.ok,
      message: commerceFeedback.text,
      treasuryDeltaCents: commerceFeedback.treasuryDeltaCents ?? null,
      items: (commerceFeedback.itemDeltas ?? []).map((entry) => ({
        ...entry,
        emoji: ITEM_BY_ID.get(entry.itemId)?.emoji ?? "❔",
        name: ITEM_BY_ID.get(entry.itemId)?.name ?? entry.itemId,
        tier: ITEM_BY_ID.get(entry.itemId)?.tier ?? 0,
        rarity: itemQualityPalette(entry.itemId).id,
        rarityLevel: itemQualityLevel(entry.itemId),
      })),
    } : { active: false, items: [], treasuryDeltaCents: null },
    achievements: {
      unlockedCount: state.achievements.length,
      acknowledgedCount: state.achievements.filter((achievement) => achievement.acknowledgedAt !== null).length,
      pending: pendingAchievements(state).map((achievement) => ({
        id: achievement.id,
        kind: achievement.kind,
        itemId: achievement.itemId,
        thresholdCents: achievement.thresholdCents,
        grade: achievementGrade(achievement),
      })),
      presentationTrigger: "successful-main-commerce-action",
      reviewArmed: achievementReviewArmed,
      awaitingCommerceTrigger: !achievementReviewArmed && pendingAchievements(state).length > 0,
      currentDialogId: !achievementReviewArmed ? null : (pendingAchievements(state)[0]?.id ?? null),
      concurrentWithCommerce: Boolean(achievementReviewArmed && commerceFeedback && pendingAchievements(state).length > 0),
      deferredByCommerce: false,
    },
    decisionModel: {
      visionRadius: LOCAL_VISION_RADIUS,
      sharedByAllCats: true,
      sharedBehaviorHash: SHARED_BEHAVIOR_HASH,
      decisionLaws: decisionLaws.map((law) => ({ id: law.id, title: law.title, astHash: law.astHash, speechTemplates: safeSpeechTemplates(law.speechTemplates) })),
      actionAuthority: "唯一共享 behavior 按优先级解释统一法典；每条法规每次决策最多执行一次",
      marketPlanningRequiresLawHelper: true,
      bountyPlanningAuthority: "悬赏是公开法规数据；只有共享 behavior 函数调用 earnCoins/choose/weighted 后才能认领并创建计划",
      fallback: null,
    },
    discoveredItems: state.discoveredItems,
    unlockedRecipes: state.unlockedRecipes,
    world: {
      mapInteractionMode,
      mapLens: {
        id: mapInteractionMode ? mapLensId : "none",
        title: mapInteractionMode ? mapLensTitle(mapLensId, mapLensItemId, wealthLensOptions) : "普通地图",
        itemId: mapInteractionMode && ITEM_SCOPED_LENSES.has(mapLensId) ? mapLensItemId : null,
        colorOnly: mapLensId !== "inventory",
        inventoryMarkersEnhancedOnly: true,
        actionItemsHidden: mapInteractionMode && mapLensId !== "none",
        craftActionItemsHidden: mapInteractionMode && mapLensId !== "none",
        speechBubblesHidden: mapInteractionMode && mapLensId !== "none",
        catCoordinates: mapInteractionMode && mapLensId === "coordinates"
          ? state.cats.map((cat) => ({ catId: cat.id, serial: cat.createdIndex + 1, position: cat.position }))
          : [],
        wealthNormalization: mapInteractionMode && mapLensId === "wealth" && activeMapLens?.metric ? {
          unit: activeMapLens.metric.unit,
          mode: activeMapLens.metric.mode ?? "total",
          windowMs: activeMapLens.metric.mode === "change" ? activeMapLens.metric.windowMs ?? wealthLensWindowMs : null,
          baselineAtMs: activeMapLens.metric.mode === "change" ? activeMapLens.metric.baselineAt ?? null : null,
          sampleIntervalMs: WEALTH_HISTORY_SAMPLE_INTERVAL_MS,
          historySamples: state.wealthHistory.length,
          min: activeMapLens.metric.min,
          median: activeMapLens.metric.median,
          max: activeMapLens.metric.max,
          cats: state.cats.map((cat) => ({
            catId: cat.id,
            value: activeMapLens.metric?.values.get(cat.id) ?? 0,
            normalized: activeMapLens.metric?.normalized.get(cat.id) ?? 0.5,
          })),
        } : null,
        activityHeat: mapInteractionMode && mapLensId === "activity" && activeMapLens?.metric ? {
          unit: activeMapLens.metric.unit,
          activeMeaning: "当前正在制作或运输",
          stalledAfterMs: 60_000,
          cats: state.cats.map((cat) => ({
            catId: cat.id,
            inactiveMs: activeMapLens.metric?.values.get(cat.id) ?? 60_000,
            normalizedInactivity: activeMapLens.metric?.normalized.get(cat.id) ?? 1,
          })),
        } : null,
        stationInventoryMarkers: (mapInteractionMode && mapLensId === "inventory")
          ? state.cats.map((cat) => {
              const entries = Object.entries(cat.inventory)
                .filter(([itemId, quantity]) => quantity > 0 && ITEM_BY_ID.has(itemId))
                .sort(([leftId], [rightId]) => (ITEM_BY_ID.get(rightId)?.tier ?? -1) - (ITEM_BY_ID.get(leftId)?.tier ?? -1)
                  || leftId.localeCompare(rightId));
              return {
                catId: cat.id,
                shown: entries.slice(0, 3).map(([itemId, quantity]) => ({ itemId, quantity })),
                hiddenKinds: Math.max(0, entries.length - 3),
              };
            })
          : [],
        orderParticipants: [...(activeMapLens?.orderFloors.values() ?? [])].map((floor) => ({
          catId: floor.catId,
          demands: floor.demandItemIds,
          demandTargets: floor.demandTargets,
          supplies: floor.supplyItemIds,
          carrier: floor.carrier,
        })) ?? [],
        stabilityHistory: mapInteractionMode && mapLensId === "stability" ? {
          persistentAcrossSaves: true,
          selectedItemId: mapLensItemId,
          producers: state.cats.map((cat) => ({
            catId: cat.id,
            plannedCount: mapLensItemId ? (state.productionHistory.byCat[cat.id]?.[mapLensItemId]?.plannedCount ?? 0) : 0,
            craftedCount: mapLensItemId ? (state.productionHistory.byCat[cat.id]?.[mapLensItemId]?.craftedCount ?? 0) : 0,
            lastCraftedAt: mapLensItemId ? (state.productionHistory.byCat[cat.id]?.[mapLensItemId]?.lastCraftedAt ?? null) : null,
          })).filter((entry) => entry.plannedCount > 0 || entry.craftedCount > 0),
          relations: activeMapLens?.edges.map((edge) => ({
            id: edge.id,
            kind: edge.kind ?? null,
            itemId: edge.itemId ?? null,
            sourceCatId: edge.sourceCatId,
            targetCatId: edge.targetCatId,
            count: edge.count ?? 1,
          })) ?? [],
          arrowEncoding: "线宽与箭头大小按累计计划次数的 log2 缩放",
        } : null,
      },
      parcelSize: 9,
      worldSeed: state.worldSeed,
      unlockedParcels: state.unlockedParcels,
      purchasableParcels: purchasableParcels(state),
      resourceNodes: state.resourceNodes.map((node) => ({
        id: node.id,
        itemId: node.itemId,
        position: node.position,
        source: node.id.startsWith("resource-player-") ? "player-created" : "world-generated",
        centerOccupied: state.cats.some((cat) => cat.position.x === node.position.x && cat.position.y === node.position.y),
        harvestTiles: resourceHarvestTiles(node),
        harvestingCats: state.cats.filter((cat) => resourceNodesAtPosition([node], cat.position).length > 0).map((cat) => cat.id),
      })),
      buildings: state.buildings,
      buildingOrders: state.buildingOrders,
      buildingOffers: state.buildingOffers.filter((offer) => offer.status === "open"),
      warehouse: {
        inventory: warehouseInventory,
        purchasedSource: state.playerWarehousePurchases,
        lockedItemIds: state.lockedWarehouseItemIds,
        fixedSellPricesCents: Object.fromEntries(ITEMS.map((item) => [item.id, warehouseSellPrice(item.id)])),
        sellPriceRule: "catalog base price × 2; unaffected by laws, difficulty, or landmarks",
        distinctItems: ITEMS.filter((item) => (warehouseInventory[item.id] ?? 0) > 0).length,
        totalItems: Object.values(warehouseInventory).reduce((sum, quantity) => sum + quantity, 0),
        purchasable: ITEMS.map((item) => warehouseQuote(state, item.id)).filter((quote) => quote.availableQuantity > 0),
        allCatStockQuote: catStockPurchaseQuote(state),
        bulkUnlockedSellQuote: warehouseBulkSellQuote(state),
      },
      playerBuildingInventory: warehouseInventory,
      buildingPlacement: {
        itemId: placingBuildingItemId,
        lastAttempt: placementFeedback,
        blockedTileRules: ["locked parcel", "cat", "building", "landmark", "resource center"],
      },
      landmarkEngineering: {
        blueprints: LANDMARK_DEFINITIONS.map((definition) => ({
          id: definition.id,
          name: definition.name,
          emoji: definition.emoji,
          radius: definition.radius,
          blueprintPriceCents: definition.blueprintPriceCents,
          unlocked: state.unlockedLandmarkIds.includes(definition.id),
          discoveredMaterials: definition.materials.filter((material) => state.discoveredItems.includes(material.itemId)).length,
          materialCount: definition.materials.length,
          materials: definition.materials.map((material) => ({ ...material, stored: warehouseInventory[material.itemId] ?? 0 })),
          description: definition.description,
        })),
        deployed: state.landmarks.map((landmark) => ({
          ...landmark,
          kind: landmark.landmarkId ? "engineered" : "marker",
          name: landmarkDisplayName(landmark),
          emoji: landmark.landmarkId ? LANDMARK_BY_ID.get(landmark.landmarkId)?.emoji ?? "🏛️" : NAMED_LANDMARK_EMOJI,
          effects: landmark.landmarkId ? landmarkEffectsAt(state, landmark.position) : null,
        })),
        placement: { landmarkId: placingLandmarkId, lastAttempt: landmarkFeedback },
      },
      rightClickWorldEditing: {
        namedLandmarkCost: { itemId: "wood", quantity: NAMED_LANDMARK_WOOD_COST },
        resourceCost: { quantity: 50, itemIds: ["wood", "stone", "sand", "water", "fiber", "ore"] },
        optionVisibility: "缺少对应仓库材料时完全不显示创建选项",
        objectActions: ["rename-landmark", "dismantle-landmark", "dismantle-building", "remove-resource", "audit-and-remove-cat"],
      },
    },
    logistics: state.logisticsStatus,
    market: {
      nextDecisionReviewMs: null,
      broadcastMode: "global-immediate",
      broadcasts: [...state.marketBroadcasts].slice(-64).reverse(),
      openOrders: state.demandOrders.filter((order) => order.status === "open").map((order) => ({
        id: order.id,
        itemId: order.itemId,
        buyerCatId: order.buyerCatId,
        destinationCatId: order.destinationCatId,
        maxDeliveredCents: order.maxDeliveredCents,
        reservedCents: order.reservedCents,
        committedSellerCatId: order.committedSellerCatId ?? null,
        quotedSellerCents: order.quotedSellerCents ?? null,
        quotedRouteCatIds: order.quotedRouteCatIds ?? [],
        quotedFeesByCatId: order.quotedFeesByCatId ?? {},
      })),
      activePlans: state.procurementPlans.filter((plan) => plan.status === "active").map((plan) => ({
        id: plan.id,
        catId: plan.catId,
        itemId: plan.outputItemId,
        phase: plan.phase,
        terminalRevenueCents: plan.terminalRevenueCents,
        bundleCostCents: plan.bundleCostCents,
        financingReserveCents: plan.financingReserveCents,
        alternativeGainCents: plan.alternativeGainCents,
        expectedProfitCents: plan.expectedProfitCents,
        bundleOrderIds: plan.bundleOrderIds,
        blockedReason: plan.blockedReason,
      })),
      activeContracts: state.shipmentContracts.filter((contract) => contract.status !== "delivered").map((contract) => ({
        id: contract.id,
        orderId: contract.orderId,
        itemId: contract.itemId,
        status: contract.status,
        routeCatIds: contract.routeCatIds,
        currentLeg: contract.currentLeg,
        custodianCatId: contract.custodianCatId,
      })),
      recentLifecycle: state.marketEvents.slice(-12),
      discoveryBounties: state.discoveryBounties.map((bounty) => ({
        itemId: bounty.itemId,
        amountCents: bounty.amountCents,
        claimedByCatId: bounty.claimedByCatId,
        paid: bounty.paid,
      })),
      fundingRule: "供应猫逐层给出卖价、路线和运费；直接原料包与最坏借贷费一次性冻结，净收益至少1分才承诺",
    },
    marketChallenge: {
      foundationRange: "前15项基础产业",
      foundationCompleted: ITEMS.slice(0, 15).every((item) => state.discoveredItems.includes(item.id)),
      selectionRule: "净资产增益/作业与运输负担",
      certification: `${certifiedItems.length}/${MARKET_CERTIFICATION_ITEM_IDS.length}`,
      certifiedItems,
      missingItems: missingCertificationItems,
      missingNames: missingCertificationItems.map((id) => ITEM_BY_ID.get(id)?.name ?? id),
      rule: "前10项开局免费，第11–15项由国库购买；所有已解锁配方统一参加资产收益率竞争，没有按目录位置指定的生产目标；第16–20项要求第11–15项全部实际制造过",
    },
    purchasableRecipes: RECIPES.filter((recipe) => canUnlockRecipe(recipe.id, state.unlockedRecipes, craftedItems)).map((recipe) => ({
      recipeId: recipe.id,
      costCents: recipeUnlockCost(recipe.id),
      affordable: state.treasuryCoins >= recipeUnlockCost(recipe.id),
    })),
    speechBubbles: state.floatingEvents.filter((event) => event.kind === "speech").map((event) => ({
      id: event.id,
      catId: event.catId,
      text: event.text,
      lawId: event.lawId ?? null,
      reason: event.reason ?? null,
      itemId: event.itemId ?? null,
      gainCents: event.gainCents ?? null,
      direction: event.direction ?? null,
      destinationCatId: event.destinationCatId ?? null,
      scheduledDelayMs: event.scheduledDelayMs ?? 0,
      startsInMs: Math.max(0, Math.round(event.createdAt - state.simTime)),
      visible: speechEventIsVisible(event, state.simTime),
      remainingMs: state.simTime < event.createdAt
        ? event.duration
        : Math.max(0, Math.round(event.createdAt + event.duration - state.simTime)),
    })),
    laws: state.laws.map((law, priority) => ({ priority, id: law.id, title: law.title, explanation: law.explanation ?? law.summary, capabilities: lawProgramSummary(law.program, law.sourceCode), immutable: true, astHash: law.astHash, status: law.status, hits: law.hitCount, speechTemplates: safeSpeechTemplates(law.speechTemplates) })),
    lawbookRevision: state.lawbookRevision,
    commandAudit: state.commandAudit.slice(-100),
    prices: Object.fromEntries(state.discoveredItems.map((id) => [id, itemPrice(state, id)])),
    cats: state.cats.slice(0, 200).map((cat) => ({
      landmarkEffects: landmarkEffectsAt(state, cat.position),
      id: cat.id,
      selected: cat.id === selectedCatId,
      position: cat.position,
      cashCents: catCashCents(cat),
      debtCents: cat.debtCents,
      liquidation: catLiquidationPreview(state, cat),
      escrowReservedCents: cat.escrowReservedCents,
      netWorthCents: netWorthCents(state, cat, (itemId) => itemPrice(state, itemId)),
      creditAvailableCents: creditAvailableCents(state, cat, (itemId) => itemPrice(state, itemId)),
      inventory: cat.inventory,
      playerPurchaseQuote: catStockPurchaseQuote(state, cat.id),
      action: cat.action ? { type: cat.action.type, itemId: cat.action.itemId, lawId: cat.action.lawId, decisionReason: cat.action.decisionReason ?? null, contractId: cat.action.contractId ?? null, remainingMs: Math.max(0, Math.round(cat.action.endsAt - state.simTime)) } : null,
      speech: state.floatingEvents.find((event) => event.kind === "speech" && event.catId === cat.id) ?? null,
      productionPlan: planForCatPublic(state, cat.id) ?? null,
      ownOrders: state.demandOrders.filter((order) => order.buyerKind === "cat" && order.buyerCatId === cat.id && order.status === "open"),
      buildingOffers: state.buildingOffers.filter((offer) => offer.sellerCatId === cat.id && offer.status === "open"),
      localSignals: signalsForCat(state, cat.id).map((signal) => ({
        orderId: signal.orderId,
        itemId: state.demandOrders.find((order) => order.id === signal.orderId)?.itemId ?? null,
        effectiveBidCents: signal.effectiveBidCents,
        sourceCatId: broadcastsForCat(state, cat.id).find((entry) => entry.kind === "demand-open" && entry.subjectId === signal.orderId)?.sourceCatId ?? null,
      })),
      heardBounties: bountyBroadcastsForCat(state, cat.id),
      heardBuildingOffers: buildingOfferBroadcastsForCat(state, cat.id),
      receivedBroadcasts: broadcastsForCat(state, cat.id).slice(0, 32),
      carrying: readyContractForCat(state, cat.id) ?? null,
      contracts: state.shipmentContracts.filter((contract) => contract.status !== "delivered"
        && contract.routeCatIds.includes(cat.id)).map((contract) => ({
          id: contract.id,
          itemId: contract.itemId,
          status: contract.status,
          routeCatIds: contract.routeCatIds,
          currentLeg: contract.currentLeg,
          custodianCatId: contract.custodianCatId,
        })),
      lastDecision: cat.lastDecision,
      visibleWorkstations: localVisibleCats(state, cat, positionMap, landmarkEffectsAt(state, cat.position).effectiveVisionRadius).filter((entry) => entry.id !== cat.id).map((entry) => ({
        id: entry.id,
        position: entry.position,
        distance: Math.abs(entry.position.x - cat.position.x) + Math.abs(entry.position.y - cat.position.y),
      })),
      localScoreTrace: cat.decisionTrace,
    })),
    stargatesBuilt: state.stargatesBuilt,
    catalogInventory: Object.fromEntries(state.discoveredItems.map((id) => [id, inventoryTotal(state, id)])),
    itemStats: Object.fromEntries(state.discoveredItems.map((id) => [id, state.itemStats[id]])),
  });
}
