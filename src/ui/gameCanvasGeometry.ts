import type { ActionCommand, CatState, Direction, GameState, Position } from "../game/types";
import {
  depthCompare,
  isoPointToTile,
  isoToScreen,
  pointInTile,
  screenToIso,
  TILE_HEIGHT,
  TILE_WIDTH,
  type Camera,
  worldToIso,
} from "./isometric";
import { workstationQualityVisual } from "./itemQuality";

export interface CanvasViewport {
  width: number;
  height: number;
}

export type CanvasContextTarget =
  | { kind: "empty" }
  | { kind: "cat"; id: string }
  | { kind: "resource"; id: string }
  | { kind: "building"; id: string }
  | { kind: "landmark"; id: string };

export function workstationLift(cat: CatState): number {
  const activeItemId = cat.action && cat.action.type !== "wait" ? cat.action.itemId : null;
  return TILE_HEIGHT * workstationQualityVisual(activeItemId).liftTileFraction;
}

export function workstationCenter(cat: CatState): Position {
  const center = worldToIso(cat.position);
  return { x: center.x, y: center.y - workstationLift(cat) };
}

export function catMotion(
  cat: CatState,
  stationCenter: Position,
  simTime: number,
  reducedMotion: boolean,
): { x: number; y: number; mirror: boolean; inFront: boolean } {
  if (!cat.action || cat.action.type === "wait") {
    const idlePhase = reducedMotion ? 0 : simTime / 1_800 + cat.createdIndex * 0.71;
    return {
      x: stationCenter.x + Math.sin(idlePhase) * 1.6,
      y: stationCenter.y - 30 + Math.sin(idlePhase * 0.7) * 0.8,
      mirror: Math.cos(idlePhase * 0.5) < -0.72,
      inFront: false,
    };
  }

  const elapsed = Math.max(0, simTime - cat.action.startedAt);
  if (cat.action.type === "pass") {
    const item = actionItemPosition(cat.action, stationCenter, simTime, reducedMotion);
    const vector = passScreenVector(cat.action.direction ?? "east");
    const distance = Math.hypot(vector.x, vector.y);
    const unit = { x: vector.x / distance, y: vector.y / distance };
    const step = reducedMotion ? 0 : Math.sin(elapsed / 175 * Math.PI) * 1.4;
    return {
      x: item.x - unit.x * 19 - unit.y * step,
      y: item.y - unit.y * 19 + unit.x * step + 5,
      mirror: unit.x < 0,
      inFront: false,
    };
  }

  const item = { x: stationCenter.x, y: stationCenter.y - 11 };
  const seed = (cat.createdIndex * 0.173) % 1;
  let angle = seed * Math.PI * 2;
  let radiusX = 29;
  let radiusY = 13;

  if (!reducedMotion && cat.action.type === "craft") {
    angle += elapsed / 4_600 * Math.PI * 2;
  }

  const x = item.x + Math.cos(angle) * radiusX;
  const y = item.y + Math.sin(angle) * radiusY + (reducedMotion ? 0 : Math.sin(elapsed / 230 + seed * 7) * 0.8);
  return {
    x,
    y,
    mirror: Math.cos(angle) < 0,
    inFront: y > item.y + 1,
  };
}

export function actionItemPosition(
  action: ActionCommand,
  stationCenter: Position,
  simTime: number,
  reducedMotion: boolean,
): Position {
  const origin = { x: stationCenter.x, y: stationCenter.y - 11 };
  if (action.type !== "pass") return origin;
  const travel = passTravel(action, simTime, reducedMotion);
  const vector = passScreenVector(action.direction ?? "east");
  return { x: origin.x + vector.x * travel, y: origin.y + vector.y * travel };
}

export function actorScenePosition(cat: CatState, simTime: number, reducedMotion: boolean): Position {
  if (cat.action?.type !== "pass" || !cat.action.direction) return cat.position;
  const travel = passTravel(cat.action, simTime, reducedMotion);
  const offsets: Record<Direction, Position> = {
    north: { x: 0, y: -1 },
    east: { x: 1, y: 0 },
    south: { x: 0, y: 1 },
    west: { x: -1, y: 0 },
  };
  const offset = offsets[cat.action.direction];
  return {
    x: cat.position.x + offset.x * travel,
    y: cat.position.y + offset.y * travel,
  };
}

export function passTravel(action: ActionCommand, simTime: number, reducedMotion: boolean): number {
  if (reducedMotion) return 0.45;
  const progress = actionProgress(action, simTime);
  return progress * progress * (3 - 2 * progress);
}

export function passScreenVector(direction: Direction): Position {
  const vectors: Record<Direction, Position> = {
    north: { x: TILE_WIDTH / 2, y: -TILE_HEIGHT / 2 },
    east: { x: TILE_WIDTH / 2, y: TILE_HEIGHT / 2 },
    south: { x: -TILE_WIDTH / 2, y: TILE_HEIGHT / 2 },
    west: { x: -TILE_WIDTH / 2, y: -TILE_HEIGHT / 2 },
  };
  return vectors[direction];
}

export function actionProgress(action: ActionCommand, simTime: number): number {
  return Math.max(0, Math.min(1, (simTime - action.startedAt) / Math.max(1, action.endsAt - action.startedAt)));
}

export function pointToWorldTile(
  localPoint: Position,
  camera: Camera,
  viewport: CanvasViewport,
  cats: readonly CatState[],
): Position {
  const isoPoint = screenToIso(localPoint, camera, viewport);
  const rough = isoPointToTile(isoPoint);
  const raisedHit = cats
    .filter((cat) => Math.abs(cat.position.x - rough.x) <= 1 && Math.abs(cat.position.y - rough.y) <= 1)
    .filter((cat) => {
      const lift = workstationLift(cat);
      return lift > 0 && pointInTile({ x: isoPoint.x, y: isoPoint.y + lift }, cat.position);
    })
    .sort((left, right) => -depthCompare(
      { ...left.position, createdIndex: left.createdIndex },
      { ...right.position, createdIndex: right.createdIndex },
    ))[0];
  return raisedHit?.position ?? rough;
}

export function contextTargetAtPoint(
  localPoint: Position,
  camera: Camera,
  viewport: CanvasViewport,
  state: Pick<GameState, "resourceNodes" | "buildings" | "landmarks" | "cats" | "simTime">,
): { tile: Position; target: CanvasContextTarget } {
  const candidates: Array<{ tile: Position; target: CanvasContextTarget; distance: number; depth: number }> = [];
  const addCandidate = (tile: Position, target: CanvasContextTarget, isoCenter: Position, radius: number) => {
    const screen = isoToScreen(isoCenter, camera, viewport);
    const distance = Math.hypot(localPoint.x - screen.x, localPoint.y - screen.y);
    if (distance <= radius) candidates.push({ tile, target, distance, depth: tile.x + tile.y });
  };
  const objectRadius = Math.max(18, 28 * camera.zoom);
  for (const node of state.resourceNodes) {
    const center = worldToIso(node.position);
    addCandidate(node.position, { kind: "resource", id: node.id }, { x: center.x, y: center.y - 23 }, objectRadius);
  }
  for (const building of state.buildings) {
    const center = worldToIso(building.position);
    addCandidate(building.position, { kind: "building", id: building.id }, { x: center.x, y: center.y - 23 }, objectRadius);
  }
  for (const landmark of state.landmarks) {
    const center = worldToIso(landmark.position);
    addCandidate(landmark.position, { kind: "landmark", id: landmark.id }, { x: center.x, y: center.y - 24 }, objectRadius);
  }
  for (const cat of state.cats) {
    const motion = catMotion(cat, workstationCenter(cat), state.simTime, false);
    addCandidate(cat.position, { kind: "cat", id: cat.id }, { x: motion.x, y: motion.y }, Math.max(15, 22 * camera.zoom));
  }
  candidates.sort((left, right) => left.distance - right.distance || right.depth - left.depth);
  if (candidates[0]) return { tile: { ...candidates[0].tile }, target: candidates[0].target };

  const tile = pointToWorldTile(localPoint, camera, viewport, state.cats);
  const cat = state.cats.find((entry) => entry.position.x === tile.x && entry.position.y === tile.y);
  if (cat) return { tile, target: { kind: "cat", id: cat.id } };
  const landmark = state.landmarks.find((entry) => entry.position.x === tile.x && entry.position.y === tile.y);
  if (landmark) return { tile, target: { kind: "landmark", id: landmark.id } };
  const building = state.buildings.find((entry) => entry.position.x === tile.x && entry.position.y === tile.y);
  if (building) return { tile, target: { kind: "building", id: building.id } };
  const resource = state.resourceNodes.find((entry) => entry.position.x === tile.x && entry.position.y === tile.y);
  if (resource) return { tile, target: { kind: "resource", id: resource.id } };
  return { tile, target: { kind: "empty" } };
}
