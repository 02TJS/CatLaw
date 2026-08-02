import type { Position, ResourceNode } from "./types";
import type { DifficultyLevel } from "./types";
import { difficultyProfile } from "./difficulty";

export const PARCEL_SIZE = 9;
export const PARCEL_HALF = 4;
export const BASE_RESOURCE_ITEM_IDS = ["wood", "stone", "sand", "water", "fiber", "ore"] as const;
export const DEFAULT_WORLD_SEED = 0x00c0ffee;
export const RESOURCE_HARVEST_RADIUS = 1;

const OFFSETS: Position[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

export const positionKey = (position: Position): string => `${position.x},${position.y}`;
export const parcelKey = (parcel: Position): string => `${parcel.x},${parcel.y}`;

export function normalizeWorldSeed(seed: number): number {
  const normalized = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : DEFAULT_WORLD_SEED;
  return normalized || DEFAULT_WORLD_SEED;
}

export function parcelForPosition(position: Position): Position {
  return {
    x: Math.floor((position.x + PARCEL_HALF) / PARCEL_SIZE),
    y: Math.floor((position.y + PARCEL_HALF) / PARCEL_SIZE),
  };
}

export function parcelBounds(parcel: Position) {
  const minX = parcel.x * PARCEL_SIZE - PARCEL_HALF;
  const minY = parcel.y * PARCEL_SIZE - PARCEL_HALF;
  return { minX, minY, maxX: minX + PARCEL_SIZE - 1, maxY: minY + PARCEL_SIZE - 1 };
}

export function parcelCost(parcel: Position, difficulty: DifficultyLevel = 2): number {
  return Math.ceil((5_000 + 2_500 * (Math.abs(parcel.x) + Math.abs(parcel.y))) * difficultyProfile(difficulty).parcelCostMultiplier);
}

export function isParcelUnlocked(unlocked: Iterable<Position>, parcel: Position): boolean {
  const key = parcelKey(parcel);
  return [...unlocked].some((entry) => parcelKey(entry) === key);
}

export function isPositionUnlocked(unlocked: Iterable<Position>, position: Position): boolean {
  return isParcelUnlocked(unlocked, parcelForPosition(position));
}

export function isAdjacentToUnlocked(unlocked: Iterable<Position>, parcel: Position): boolean {
  const keys = new Set([...unlocked].map(parcelKey));
  return OFFSETS.some((offset) => keys.has(`${parcel.x + offset.x},${parcel.y + offset.y}`));
}

export function frontierParcels(unlocked: Iterable<Position>): Position[] {
  const list = [...unlocked];
  const known = new Set(list.map(parcelKey));
  const frontier = new Map<string, Position>();
  for (const parcel of list) {
    for (const offset of OFFSETS) {
      const candidate = { x: parcel.x + offset.x, y: parcel.y + offset.y };
      const key = parcelKey(candidate);
      if (!known.has(key)) frontier.set(key, candidate);
    }
  }
  return [...frontier.values()].sort((a, b) => Math.abs(a.x) + Math.abs(a.y) - Math.abs(b.x) - Math.abs(b.y)
    || a.y - b.y || a.x - b.x);
}

function mulberry32(seed: number): () => number {
  let value = normalizeWorldSeed(seed);
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function mixSeed(seed: number, x: number, y: number): number {
  let hash = normalizeWorldSeed(seed) ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function shuffle<T>(values: T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function central(position: Position): boolean {
  return position.x >= -PARCEL_HALF && position.x <= PARCEL_HALF
    && position.y >= -PARCEL_HALF && position.y <= PARCEL_HALF;
}

export function resourceHarvestTiles(node: ResourceNode): Position[] {
  const result: Position[] = [];
  for (let dy = -RESOURCE_HARVEST_RADIUS; dy <= RESOURCE_HARVEST_RADIUS; dy += 1) {
    for (let dx = -RESOURCE_HARVEST_RADIUS; dx <= RESOURCE_HARVEST_RADIUS; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      result.push({ x: node.position.x + dx, y: node.position.y + dy });
    }
  }
  return result;
}

export function resourceNodesAtPosition(nodes: ReadonlyArray<ResourceNode>, position: Position): ResourceNode[] {
  return nodes.filter((node) => {
    const dx = Math.abs(node.position.x - position.x);
    const dy = Math.abs(node.position.y - position.y);
    return Math.max(dx, dy) === RESOURCE_HARVEST_RADIUS;
  });
}

function starterLayout(vertical: boolean): { catPositions: Position[]; resourcePositions: Position[] } {
  const catPositions: Position[] = [{ x: 0, y: 0 }];
  for (const y of [-1, 1]) {
    for (let x = -2; x <= 2; x += 1) catPositions.push({ x, y });
  }
  const resourcePositions: Position[] = [];
  for (const y of [-2, 2]) {
    for (const x of [-3, 0, 3]) resourcePositions.push({ x, y });
  }
  if (!vertical) return { catPositions, resourcePositions };
  return {
    catPositions: catPositions.map((position) => ({ x: position.y, y: position.x })),
    resourcePositions: resourcePositions.map((position) => ({ x: position.y, y: position.x })),
  };
}

export function generateStarterWorld(seed: number): { catPositions: Position[]; resourceNodes: ResourceNode[] } {
  const random = mulberry32(seed);
  const { catPositions, resourcePositions } = starterLayout(random() >= 0.5);
  const resources = shuffle([...BASE_RESOURCE_ITEM_IDS], random);
  const resourceNodes = resourcePositions.map((position, index) => ({
    id: `resource-0-0-${index}`,
    itemId: resources[index],
    position: { ...position },
  }));
  return { catPositions: catPositions.map((position) => ({ ...position })), resourceNodes };
}

export function generateParcelResourceNodes(seed: number, parcel: Position): ResourceNode[] {
  if (parcel.x === 0 && parcel.y === 0) return generateStarterWorld(seed).resourceNodes;
  const random = mulberry32(mixSeed(seed, parcel.x, parcel.y));
  const bounds = parcelBounds(parcel);
  const positions: Position[] = [];
  for (let y = bounds.minY + 1; y <= bounds.maxY - 1; y += 1) {
    for (let x = bounds.minX + 1; x <= bounds.maxX - 1; x += 1) positions.push({ x, y });
  }
  const count = 1 + Math.floor(random() * 2);
  const selectedPositions: Position[] = [];
  for (const position of shuffle(positions, random)) {
    if (selectedPositions.every((entry) => Math.max(Math.abs(entry.x - position.x), Math.abs(entry.y - position.y)) >= 3)) {
      selectedPositions.push(position);
      if (selectedPositions.length === count) break;
    }
  }
  const selectedResources = shuffle([...BASE_RESOURCE_ITEM_IDS], random).slice(0, count);
  return selectedPositions.map((position, index) => ({
    id: `resource-${parcel.x}-${parcel.y}-${index}`,
    itemId: selectedResources[index],
    position,
  }));
}

export function randomWorldSeed(): number {
  const values = new Uint32Array(1);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(values);
  else values[0] = Math.floor(Math.random() * 0xffff_ffff);
  return normalizeWorldSeed(values[0]);
}
