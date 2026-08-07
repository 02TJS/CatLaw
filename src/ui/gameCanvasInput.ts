import type { Position } from "../game/types";
import { screenToIso, type Camera, type Viewport } from "./isometric";

export interface CanvasDragState {
  x: number;
  y: number;
  cameraX: number;
  cameraY: number;
  moved: boolean;
  nativeWindow: boolean;
}

export function beginCanvasDrag(
  point: Position,
  camera: Camera,
  nativeWindow: boolean,
): CanvasDragState {
  return { x: point.x, y: point.y, cameraX: camera.x, cameraY: camera.y, moved: false, nativeWindow };
}

export function updateCanvasDrag(
  drag: CanvasDragState,
  point: Position,
): { dx: number; dy: number } {
  const dx = point.x - drag.x;
  const dy = point.y - drag.y;
  if (Math.hypot(dx, dy) > 4) drag.moved = true;
  return { dx, dy };
}

export function panCameraForDrag(
  camera: Camera,
  drag: CanvasDragState,
  dx: number,
  dy: number,
): void {
  camera.x = drag.cameraX - dx / camera.zoom;
  camera.y = drag.cameraY - dy / camera.zoom;
}

export function zoomCameraAtPoint(
  camera: Camera,
  pointer: Position,
  viewport: Viewport,
  deltaY: number,
  defaultZoom: number,
  minimumScale: number,
  maximumScale: number,
): number {
  const before = screenToIso(pointer, camera, viewport);
  const nextScale = Math.round(Math.max(
    minimumScale,
    Math.min(maximumScale, (camera.zoom * Math.exp(-deltaY * 0.001)) / defaultZoom),
  ) * 20) / 20;
  camera.zoom = defaultZoom * nextScale;
  const after = screenToIso(pointer, camera, viewport);
  camera.x += before.x - after.x;
  camera.y += before.y - after.y;
  return nextScale;
}
