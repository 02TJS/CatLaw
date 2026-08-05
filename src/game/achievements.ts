import { CATALOG_ANALYSIS, ITEM_BY_ID, ITEMS } from "./catalog";
import type { AchievementEvent, GameState, ItemId } from "./types";

export const PRODUCTION_RATE_ACHIEVEMENT_THRESHOLDS_CENTS = [
  10_000, 50_000, 200_000, 1_000_000, 5_000_000, 25_000_000, 100_000_000,
] as const;

export const TOTAL_PRODUCTION_ACHIEVEMENT_THRESHOLDS_CENTS = [
  10_000, 100_000, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000,
] as const;

const achievementId = (kind: AchievementEvent["kind"], subject: string | number) => `${kind}:${subject}`;

function appendAchievement(state: GameState, event: AchievementEvent): void {
  if (state.achievements.some((entry) => entry.id === event.id)) return;
  state.achievements.push(event);
}

export function unlockProductionAchievements(
  state: GameState,
  itemId: ItemId,
  firstCraft: boolean,
  productionRateCents: number,
): void {
  if (firstCraft) {
    appendAchievement(state, {
      id: achievementId("first-craft", itemId),
      kind: "first-craft",
      itemId,
      thresholdCents: null,
      unlockedAt: state.simTime,
      acknowledgedAt: null,
    });
  }
  for (const thresholdCents of PRODUCTION_RATE_ACHIEVEMENT_THRESHOLDS_CENTS) {
    if (productionRateCents < thresholdCents) continue;
    appendAchievement(state, {
      id: achievementId("production-rate", thresholdCents),
      kind: "production-rate",
      itemId: null,
      thresholdCents,
      unlockedAt: state.simTime,
      acknowledgedAt: null,
    });
  }
  for (const thresholdCents of TOTAL_PRODUCTION_ACHIEVEMENT_THRESHOLDS_CENTS) {
    if (state.totalProductionValueCents < thresholdCents) continue;
    appendAchievement(state, {
      id: achievementId("total-production", thresholdCents),
      kind: "total-production",
      itemId: null,
      thresholdCents,
      unlockedAt: state.simTime,
      acknowledgedAt: null,
    });
  }
}

export function acknowledgeAchievement(state: GameState, achievementIdToAcknowledge: string): boolean {
  const achievement = state.achievements.find((entry) => entry.id === achievementIdToAcknowledge && entry.acknowledgedAt === null);
  if (!achievement) return false;
  achievement.acknowledgedAt = state.simTime;
  return true;
}

export function achievementGrade(entry: AchievementEvent): number {
  if (entry.kind === "first-craft") {
    if (entry.itemId === "stargate") return 8;
    return Math.max(0, ITEM_BY_ID.get(entry.itemId ?? "")?.tier ?? 0);
  }
  const thresholds = entry.kind === "production-rate"
    ? PRODUCTION_RATE_ACHIEVEMENT_THRESHOLDS_CENTS
    : TOTAL_PRODUCTION_ACHIEVEMENT_THRESHOLDS_CENTS;
  const thresholdIndex = thresholds.findIndex((threshold) => threshold === entry.thresholdCents);
  return Math.max(0, thresholdIndex + (entry.kind === "production-rate" ? 2 : 3));
}

export function pendingAchievements(state: GameState): AchievementEvent[] {
  return state.achievements.filter((entry) => entry.acknowledgedAt === null)
    .sort((left, right) => achievementGrade(right) - achievementGrade(left)
      || (right.thresholdCents ?? 0) - (left.thresholdCents ?? 0)
      || left.unlockedAt - right.unlockedAt
      || left.id.localeCompare(right.id));
}

function inferredLegacyTotalProductionValue(state: GameState): number {
  return ITEMS.reduce((sum, item) => sum + Math.max(0, state.itemStats[item.id]?.crafted ?? 0)
    * Math.max(1, CATALOG_ANALYSIS.basePrices[item.id] ?? 1) * 100, 0);
}

function inferredRecentProductionRate(state: GameState): number {
  const logicalMinuteMs = 60_000 / Math.max(1, state.simulationSpeed);
  const observedMs = Math.max(1, Math.min(logicalMinuteMs, state.simTime));
  const cutoff = state.simTime - logicalMinuteMs;
  const valueCents = state.recentProductionEvents.reduce((sum, event) => {
    if (event.at < cutoff) return sum;
    return sum + (Number.isFinite(event.valueCents)
      ? Math.max(0, Math.round(event.valueCents ?? 0))
      : Math.max(1, CATALOG_ANALYSIS.basePrices[event.itemId] ?? 1) * 100);
  }, 0);
  return Math.round(valueCents * logicalMinuteMs / observedMs);
}

export function normalizeAchievementState(
  state: GameState,
  hadPersistedAchievements: boolean,
  hadPersistedTotal = true,
): void {
  state.totalProductionValueCents = hadPersistedTotal && Number.isFinite(state.totalProductionValueCents)
    ? Math.max(0, Math.round(state.totalProductionValueCents))
    : inferredLegacyTotalProductionValue(state);
  const seen = new Set<string>();
  state.achievements = (Array.isArray(state.achievements) ? state.achievements : []).filter((entry) => {
    if (!entry || typeof entry.id !== "string" || seen.has(entry.id)) return false;
    if (!["first-craft", "production-rate", "total-production"].includes(entry.kind)) return false;
    if (entry.itemId !== null && entry.itemId !== undefined && !ITEM_BY_ID.has(entry.itemId)) return false;
    seen.add(entry.id);
    entry.unlockedAt = Number.isFinite(entry.unlockedAt) ? entry.unlockedAt : state.simTime;
    entry.acknowledgedAt = Number.isFinite(entry.acknowledgedAt) ? entry.acknowledgedAt : null;
    return true;
  });
  if (hadPersistedAchievements) return;

  const acknowledgeHistorical = (event: AchievementEvent) => appendAchievement(state, {
    ...event,
    unlockedAt: state.simTime,
    acknowledgedAt: state.simTime,
  });
  for (const item of ITEMS) {
    if ((state.itemStats[item.id]?.crafted ?? 0) <= 0) continue;
    acknowledgeHistorical({
      id: achievementId("first-craft", item.id),
      kind: "first-craft",
      itemId: item.id,
      thresholdCents: null,
      unlockedAt: state.simTime,
      acknowledgedAt: state.simTime,
    });
  }
  const rate = inferredRecentProductionRate(state);
  for (const thresholdCents of PRODUCTION_RATE_ACHIEVEMENT_THRESHOLDS_CENTS) {
    if (rate < thresholdCents) continue;
    acknowledgeHistorical({
      id: achievementId("production-rate", thresholdCents),
      kind: "production-rate",
      itemId: null,
      thresholdCents,
      unlockedAt: state.simTime,
      acknowledgedAt: state.simTime,
    });
  }
  for (const thresholdCents of TOTAL_PRODUCTION_ACHIEVEMENT_THRESHOLDS_CENTS) {
    if (state.totalProductionValueCents < thresholdCents) continue;
    acknowledgeHistorical({
      id: achievementId("total-production", thresholdCents),
      kind: "total-production",
      itemId: null,
      thresholdCents,
      unlockedAt: state.simTime,
      acknowledgedAt: state.simTime,
    });
  }
}
