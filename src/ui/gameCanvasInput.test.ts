import { describe, expect, it } from "vitest";
import { screenToIso } from "./isometric";
import {
  beginCanvasDrag,
  panCameraForDrag,
  updateCanvasDrag,
  zoomCameraAtPoint,
} from "./gameCanvasInput";

describe("game canvas input state", () => {
  it("uses the existing four-pixel drag threshold", () => {
    const camera = { x: 32, y: 28, zoom: 1.08 };
    const drag = beginCanvasDrag({ x: 100, y: 200 }, camera, false);
    expect(updateCanvasDrag(drag, { x: 104, y: 200 })).toEqual({ dx: 4, dy: 0 });
    expect(drag.moved).toBe(false);
    expect(updateCanvasDrag(drag, { x: 104.01, y: 200 })).toEqual({ dx: 4.010000000000005, dy: 0 });
    expect(drag.moved).toBe(true);
  });

  it("pans from the drag origin using the current zoom", () => {
    const camera = { x: 32, y: 28, zoom: 2 };
    const drag = beginCanvasDrag({ x: 100, y: 200 }, camera, false);
    panCameraForDrag(camera, drag, 20, -10);
    expect(camera).toEqual({ x: 22, y: 33, zoom: 2 });
  });

  it("keeps the pointer anchor fixed while rounding map scale to twentieths", () => {
    const camera = { x: 32, y: 28, zoom: 1.08 };
    const viewport = { width: 900, height: 700 };
    const pointer = { x: 620, y: 260 };
    const before = screenToIso(pointer, camera, viewport);
    const scale = zoomCameraAtPoint(camera, pointer, viewport, -120, 1.08, 0.6, 1.8);
    const after = screenToIso(pointer, camera, viewport);

    expect(scale * 20).toBe(Math.round(scale * 20));
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });
});
