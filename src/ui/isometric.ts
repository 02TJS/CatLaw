import type { Position } from "../game/types";

export const TILE_WIDTH = 128;
export const TILE_HEIGHT = 64;
export const EMPTY_TILE_DEPTH = 14;
export const WORKSTATION_DEPTH = 8;

export interface Point {
  x: number;
  y: number;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface SceneDepthKey {
  position: Point;
  layer: number;
  order: number;
}

export function worldToIso(position: Point): Point {
  return {
    x: (position.x - position.y) * (TILE_WIDTH / 2),
    y: (position.x + position.y) * (TILE_HEIGHT / 2),
  };
}

export function isoToWorld(point: Point): Point {
  const horizontal = point.x / (TILE_WIDTH / 2);
  const vertical = point.y / (TILE_HEIGHT / 2);
  return {
    x: (horizontal + vertical) / 2,
    y: (vertical - horizontal) / 2,
  };
}

export function isoToScreen(point: Point, camera: Camera, viewport: Viewport): Point {
  return {
    x: viewport.width / 2 + (point.x - camera.x) * camera.zoom,
    y: viewport.height / 2 + (point.y - camera.y) * camera.zoom,
  };
}

export function screenToIso(point: Point, camera: Camera, viewport: Viewport): Point {
  return {
    x: camera.x + (point.x - viewport.width / 2) / camera.zoom,
    y: camera.y + (point.y - viewport.height / 2) / camera.zoom,
  };
}

export function tileDiamond(position: Position): [Point, Point, Point, Point] {
  const center = worldToIso(position);
  return [
    { x: center.x, y: center.y - TILE_HEIGHT / 2 },
    { x: center.x + TILE_WIDTH / 2, y: center.y },
    { x: center.x, y: center.y + TILE_HEIGHT / 2 },
    { x: center.x - TILE_WIDTH / 2, y: center.y },
  ];
}

export function pointInTile(point: Point, position: Position, epsilon = 1e-7): boolean {
  const center = worldToIso(position);
  const normalized = Math.abs(point.x - center.x) / (TILE_WIDTH / 2)
    + Math.abs(point.y - center.y) / (TILE_HEIGHT / 2);
  return normalized <= 1 + epsilon;
}

/** Returns the visually front-most tile when a point lies exactly on a shared edge. */
export function isoPointToTile(point: Point): Position {
  const rough = isoToWorld(point);
  const originX = Math.round(rough.x);
  const originY = Math.round(rough.y);
  const candidates: Position[] = [];
  for (let y = originY - 1; y <= originY + 1; y += 1) {
    for (let x = originX - 1; x <= originX + 1; x += 1) {
      const candidate = { x, y };
      if (pointInTile(point, candidate)) candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => -depthCompare(a, b));
  return candidates[0] ?? { x: originX, y: originY };
}

export function screenPointToTile(point: Point, camera: Camera, viewport: Viewport): Position {
  return isoPointToTile(screenToIso(point, camera, viewport));
}

export function depthCompare(
  a: Position & { createdIndex?: number },
  b: Position & { createdIndex?: number },
): number {
  return (a.x + a.y) - (b.x + b.y)
    || a.x - b.x
    || a.y - b.y
    || (a.createdIndex ?? 0) - (b.createdIndex ?? 0);
}

/** Sorts static tiles and moving actors in one painter queue. Fractional positions let an actor change sides at a tile boundary. */
export function sceneDepthCompare(a: SceneDepthKey, b: SceneDepthKey): number {
  return (a.position.x + a.position.y + a.layer) - (b.position.x + b.position.y + b.layer)
    || a.position.x - b.position.x
    || a.position.y - b.position.y
    || a.order - b.order;
}

export function visibleWorldBounds(camera: Camera, viewport: Viewport, margin = 2) {
  const corners = [
    { x: 0, y: 0 },
    { x: viewport.width, y: 0 },
    { x: viewport.width, y: viewport.height },
    { x: 0, y: viewport.height },
  ].map((point) => isoToWorld(screenToIso(point, camera, viewport)));
  return {
    minX: Math.floor(Math.min(...corners.map((point) => point.x))) - margin,
    maxX: Math.ceil(Math.max(...corners.map((point) => point.x))) + margin,
    minY: Math.floor(Math.min(...corners.map((point) => point.y))) - margin,
    maxY: Math.ceil(Math.max(...corners.map((point) => point.y))) + margin,
  };
}
