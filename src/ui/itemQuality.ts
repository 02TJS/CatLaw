import { ITEM_BY_ID } from "../game/catalog";
import type { ItemId } from "../game/types";

export type ItemQualityId = "pearl" | "sage" | "azure" | "lilac" | "champagne" | "rose" | "graphite" | "prism";

export interface ItemQualityPalette {
  id: ItemQualityId;
  label: string;
  topStops: readonly [string, string, string];
  sideLeft: string;
  sideRight: string;
  accent: string;
  haloInner: string;
  haloOuter: string;
}

export interface WorkstationQualityVisual {
  level: number;
  borderWidth: number;
  glowWidth: number;
  glowBlur: number;
  liftTileFraction: number;
  fullHighlight: boolean;
}

const QUALITY_BY_TIER: readonly ItemQualityPalette[] = [
  { id: "pearl", label: "珍珠白", topStops: ["#fffdf8", "#f0eee8", "#faf9f5"], sideLeft: "#d9d7d0", sideRight: "#e5e2da", accent: "#a9aca8", haloInner: "rgba(245, 242, 232, .46)", haloOuter: "rgba(245, 242, 232, 0)" },
  { id: "sage", label: "鼠尾草绿", topStops: ["#f0f7ef", "#d9eadb", "#e9f2e7"], sideLeft: "#b9d0bd", sideRight: "#c9dccb", accent: "#78a884", haloInner: "rgba(139, 190, 151, .34)", haloOuter: "rgba(139, 190, 151, 0)" },
  { id: "azure", label: "雾霭蓝", topStops: ["#eaf6fc", "#c9e0f1", "#dcedf7"], sideLeft: "#9fbfd8", sideRight: "#b3cee2", accent: "#4f91c1", haloInner: "rgba(79, 151, 204, .62)", haloOuter: "rgba(79, 151, 204, 0)" },
  { id: "lilac", label: "月光紫", topStops: ["#f5f0fa", "#e5daf1", "#eee7f7"], sideLeft: "#cbbbdc", sideRight: "#dacde7", accent: "#9479b1", haloInner: "rgba(151, 123, 181, .31)", haloOuter: "rgba(151, 123, 181, 0)" },
  { id: "champagne", label: "香槟金", topStops: ["#fff9e8", "#f2e6c1", "#faf1d8"], sideLeft: "#dac99b", sideRight: "#e7d7ad", accent: "#c0a052", haloInner: "rgba(202, 170, 91, .3)", haloOuter: "rgba(202, 170, 91, 0)" },
  { id: "rose", label: "烟霞红", topStops: ["#fdf1ef", "#f0d8d6", "#f8e5e2"], sideLeft: "#d8b7b4", sideRight: "#e5c8c5", accent: "#b9706c", haloInner: "rgba(190, 111, 106, .29)", haloOuter: "rgba(190, 111, 106, 0)" },
  { id: "graphite", label: "雾墨黑", topStops: ["#eef0f2", "#d4d8dd", "#e5e7e9"], sideLeft: "#aeb4bc", sideRight: "#c0c5cb", accent: "#555c66", haloInner: "rgba(76, 84, 95, .26)", haloOuter: "rgba(76, 84, 95, 0)" },
];

const PRISM: ItemQualityPalette = {
  id: "prism",
  label: "星门炫彩",
  topStops: ["#f5e7f4", "#dcecf8", "#e5f3df"],
  sideLeft: "#c9c7e2",
  sideRight: "#bcd8dc",
  accent: "#8b72b8",
  haloInner: "rgba(157, 130, 202, .34)",
  haloOuter: "rgba(121, 195, 188, 0)",
};

const BUILDING_QUALITY_LEVEL: Readonly<Record<string, number>> = {
  factory: 1,
  machine_tool: 2,
  antenna: 3,
  lab: 4,
  reactor: 5,
};

export function qualityPaletteAtLevel(level: number): ItemQualityPalette {
  return QUALITY_BY_TIER[Math.min(QUALITY_BY_TIER.length - 1, Math.max(0, Math.floor(level)))];
}

export function itemQualityLevel(itemId: ItemId | string | null | undefined): number {
  if (itemId === "stargate") return QUALITY_BY_TIER.length;
  return Math.min(QUALITY_BY_TIER.length - 1, Math.max(0, ITEM_BY_ID.get(itemId ?? "")?.tier ?? 0));
}

export function itemQualityPalette(itemId: ItemId | string | null | undefined): ItemQualityPalette {
  if (itemId === "stargate") return PRISM;
  return qualityPaletteAtLevel(itemQualityLevel(itemId));
}

/**
 * Ground buildings have their own visual progression. Factory deliberately
 * starts at sage instead of inheriting its catalog tier (which would be blue),
 * then each later deployable facility advances one quality step.
 */
export function buildingQualityPalette(itemId: ItemId | string | null | undefined): ItemQualityPalette {
  const level = BUILDING_QUALITY_LEVEL[itemId ?? ""];
  return level === undefined ? itemQualityPalette(itemId) : qualityPaletteAtLevel(level);
}

/**
 * Keeps quality emphasis stable in screen pixels. Green goods have a clearly
 * visible single rim; blue goods use a modest 1/9-tile lift, gold goods add
 * another 1/9 tile, and red goods highlight the complete raised platform.
 */
export function workstationQualityVisual(itemId: ItemId | string | null | undefined): WorkstationQualityVisual {
  const level = itemQualityLevel(itemId);
  if (level >= 2) {
    return {
      level,
      borderWidth: level >= 4 ? 5.6 : 5.2,
      glowWidth: level >= 4 ? 11.5 : 10,
      glowBlur: level >= 4 ? 27 : 22,
      liftTileFraction: level >= 4 ? 2 / 9 : 1 / 9,
      fullHighlight: level === 5,
    };
  }
  if (level === 1) {
    return { level, borderWidth: 3.2, glowWidth: 0, glowBlur: 0, liftTileFraction: 0, fullHighlight: false };
  }
  return { level, borderWidth: 1.05, glowWidth: 0, glowBlur: 0, liftTileFraction: 0, fullHighlight: false };
}
