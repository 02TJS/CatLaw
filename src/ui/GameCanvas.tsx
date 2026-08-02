import { useEffect, useRef } from "react";
import catSpriteUrl from "../assets/cat-workshop-sprite.png?url";
import { ITEM_BY_ID } from "../game/catalog";
import type { GameController } from "../game/controller";
import { buildingPlacementFailure, formatMoney } from "../game/engine";
import type { ActionCommand, CatState, DeployedBuilding, Direction, FloatingEvent, Position, ResourceNode } from "../game/types";
import { frontierParcels, isPositionUnlocked, parcelBounds, parcelCost, parcelForPosition, parcelKey, resourceHarvestTiles } from "../game/world";
import {
  type Camera,
  isoToScreen,
  sceneDepthCompare,
  screenPointToTile,
  screenToIso,
  TILE_HEIGHT,
  TILE_WIDTH,
  tileDiamond,
  visibleWorldBounds,
  WORKSTATION_DEPTH,
  worldToIso,
} from "./isometric";

const DEFAULT_CAMERA: Camera = { x: 32, y: 28, zoom: 1.08 };
const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
const CAT_RENDER_SCALE = 2 / 5;
const CAT_RENDER_SIZE = 64 * CAT_RENDER_SCALE;
const emojiCache = new Map<string, HTMLCanvasElement>();

interface GroundLayerCache {
  canvas?: HTMLCanvasElement;
  key?: string;
}

interface Props {
  controller: GameController;
  selectedCatId: string;
  onSelectCat: (id: string) => void;
  expansionMode: boolean;
  placingBuildingItemId: string | null;
  onBuildingPlacementResult: (feedback: { itemId: string; position: Position; ok: boolean; error?: string }) => void;
}

type SceneEntry =
  | { kind: "resource"; position: Position; layer: number; order: number; node: ResourceNode }
  | { kind: "building"; position: Position; layer: number; order: number; building: DeployedBuilding }
  | { kind: "actor"; position: Position; layer: number; order: number; cat: CatState };

export function GameCanvas({
  controller,
  selectedCatId,
  onSelectCat,
  expansionMode,
  placingBuildingItemId,
  onBuildingPlacementResult,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camera = useRef<Camera>({ ...DEFAULT_CAMERA });
  const hoveredTile = useRef<Position | null>(null);
  const drag = useRef<{ x: number; y: number; cameraX: number; cameraY: number; moved: boolean } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const context = canvas.getContext("2d", { alpha: false })!;
    const image = new Image();
    image.src = catSpriteUrl;
    let frameHandle = 0;
    let dpr = window.devicePixelRatio || 1;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const groundCache: GroundLayerCache = {};

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawWorld(
        context,
        rect.width,
        rect.height,
        dpr,
        controller,
        image,
        camera.current,
        selectedCatId,
        hoveredTile.current,
        expansionMode,
        placingBuildingItemId,
        reducedMotion,
        groundCache,
      );
      frameHandle = requestAnimationFrame(draw);
    };
    frameHandle = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frameHandle);
      observer.disconnect();
    };
  }, [controller, selectedCatId, expansionMode, placingBuildingItemId]);

  const pointToTile = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return screenPointToTile(
      { x: clientX - rect.left, y: clientY - rect.top },
      camera.current,
      { width: rect.width, height: rect.height },
    );
  };

  const placeHoveredCat = () => {
    const tile = hoveredTile.current;
    if (!tile) return;
    if (placingBuildingItemId) {
      const result = controller.placeBuilding(placingBuildingItemId, tile);
      onBuildingPlacementResult({ itemId: placingBuildingItemId, position: { ...tile }, ...result });
      return;
    }
    if (expansionMode) {
      controller.expandParcel(parcelForPosition(tile));
      return;
    }
    if (!isPositionUnlocked(controller.state.unlockedParcels, tile)) return;
    const occupied = controller.state.cats.find((cat) => cat.position.x === tile.x && cat.position.y === tile.y);
    if (occupied) {
      onSelectCat(occupied.id);
      return;
    }
    if (controller.addCat(tile)) {
      const created = controller.state.cats.find((cat) => cat.position.x === tile.x && cat.position.y === tile.y);
      if (created) onSelectCat(created.id);
    }
  };

  return (
    <canvas
      id="game-canvas"
      ref={canvasRef}
      data-testid="game-canvas"
      tabIndex={0}
      aria-label="等距猫咪工坊。拖拽平移，滚轮缩放，点击或按空格在绿色预览工位放置猫咪。"
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        canvasRef.current?.focus();
        canvasRef.current?.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, cameraX: camera.current.x, cameraY: camera.current.y, moved: false };
      }}
      onPointerMove={(event) => {
        hoveredTile.current = pointToTile(event.clientX, event.clientY);
        if (!drag.current) return;
        const dx = event.clientX - drag.current.x;
        const dy = event.clientY - drag.current.y;
        if (Math.hypot(dx, dy) > 4) drag.current.moved = true;
        camera.current.x = drag.current.cameraX - dx / camera.current.zoom;
        camera.current.y = drag.current.cameraY - dy / camera.current.zoom;
      }}
      onPointerLeave={() => {
        if (!drag.current) hoveredTile.current = null;
      }}
      onPointerUp={(event) => {
        const current = drag.current;
        drag.current = null;
        hoveredTile.current = pointToTile(event.clientX, event.clientY);
        if (!current || current.moved) return;
        placeHoveredCat();
      }}
      onPointerCancel={() => { drag.current = null; }}
      onKeyDown={(event) => {
        if (event.key === " ") {
          event.preventDefault();
          placeHoveredCat();
        }
      }}
      onWheel={(event) => {
        const rect = canvasRef.current!.getBoundingClientRect();
        const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        const before = screenToIso(pointer, camera.current, { width: rect.width, height: rect.height });
        camera.current.zoom = Math.max(0.34, Math.min(1.8, camera.current.zoom * Math.exp(-event.deltaY * 0.001)));
        const after = screenToIso(pointer, camera.current, { width: rect.width, height: rect.height });
        camera.current.x += before.x - after.x;
        camera.current.y += before.y - after.y;
        hoveredTile.current = pointToTile(event.clientX, event.clientY);
      }}
    />
  );
}

function drawWorld(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
  controller: GameController,
  image: HTMLImageElement,
  camera: Camera,
  selectedCatId: string,
  hoveredTile: Position | null,
  expansionMode: boolean,
  placingBuildingItemId: string | null,
  reducedMotion: boolean,
  groundCache: GroundLayerCache,
) {
  const state = controller.state;
  const viewport = { width, height };
  const bounds = visibleWorldBounds(camera, viewport, 3);
  const ground = getGroundLayer(width, height, dpr, groundCache);
  context.drawImage(ground, 0, 0, width, height);

  context.save();
  context.translate(width / 2, height / 2);
  context.scale(camera.zoom, camera.zoom);
  context.translate(-camera.x, -camera.y);

  drawUnlockedParcels(context, state.unlockedParcels);
  if (expansionMode) drawExpansionParcels(context, state.unlockedParcels, state.treasuryCoins, state.difficulty, hoveredTile);
  drawResourceRegions(context, state.resourceNodes);

  const visibleCats = state.cats
    .filter((cat) => cat.position.x >= bounds.minX - 1 && cat.position.x <= bounds.maxX + 1
      && cat.position.y >= bounds.minY - 1 && cat.position.y <= bounds.maxY + 1);
  const visibleResources = state.resourceNodes.filter((node) => node.position.x >= bounds.minX - 1
    && node.position.x <= bounds.maxX + 1 && node.position.y >= bounds.minY - 1 && node.position.y <= bounds.maxY + 1);
  const scene: SceneEntry[] = [];
  visibleResources.forEach((node, index) => scene.push({
    kind: "resource", position: node.position, layer: 0.5, order: -1_000_000 + index, node,
  }));
  for (const cat of visibleCats) {
    scene.push({
      kind: "actor",
      position: actorScenePosition(cat, state.simTime, reducedMotion),
      layer: 0.5,
      order: cat.createdIndex * 4 + 2,
      cat,
    });
  }
  state.buildings.filter((building) => building.position.x >= bounds.minX - 1
    && building.position.x <= bounds.maxX + 1 && building.position.y >= bounds.minY - 1
    && building.position.y <= bounds.maxY + 1).forEach((building, index) => scene.push({
    kind: "building", position: building.position, layer: 0.35, order: index * 4 + 1, building,
  }));
  scene.sort(sceneDepthCompare);

  // Workstations are terrain, not scene actors. Drawing every base before the
  // footpoint-sorted object layer prevents a tile top from covering a cat that
  // is crossing its rear edge while still preserving actor/building occlusion.
  const stationBases = [...visibleCats].sort((a, b) => sceneDepthCompare(
    { position: a.position, layer: 0, order: a.createdIndex },
    { position: b.position, layer: 0, order: b.createdIndex },
  ));
  for (const cat of stationBases) {
    drawCatStationBase(context, cat, state.simTime, camera.zoom, cat.id === selectedCatId, reducedMotion);
  }

  if (hoveredTile && placingBuildingItemId) {
    const failure = buildingPlacementFailure(state, placingBuildingItemId, hoveredTile);
    drawBuildingAura(context, hoveredTile, placingBuildingItemId);
    drawBuildingPlacementPreview(context, hoveredTile, placingBuildingItemId, !failure, dpr);
  } else if (hoveredTile && !expansionMode && isPositionUnlocked(state.unlockedParcels, hoveredTile)) {
    const occupied = state.cats.some((cat) => cat.position.x === hoveredTile.x && cat.position.y === hoveredTile.y);
    const resourceCenter = state.resourceNodes.some((node) => node.position.x === hoveredTile.x && node.position.y === hoveredTile.y);
    if (!occupied && !resourceCenter) drawPlacementPreview(context, hoveredTile, state.simTime, reducedMotion);
  }

  for (const entry of scene) {
    switch (entry.kind) {
      case "resource":
        drawResourceMarker(context, entry.node, dpr);
        break;
      case "building":
        drawBuildingMarker(context, entry.building, dpr);
        break;
      case "actor":
        drawCatActor(context, entry.cat, state.simTime, image, dpr, reducedMotion);
        break;
    }
  }

  drawFloatingEvents(context, state.cats, state.floatingEvents, state.simTime, reducedMotion);
  context.restore();

  drawCanvasHud(
    context,
    width,
    height,
    state.paused,
    hoveredTile,
    expansionMode,
    state.unlockedParcels,
    state.treasuryCoins,
    state.difficulty,
    placingBuildingItemId,
    hoveredTile && placingBuildingItemId ? buildingPlacementFailure(state, placingBuildingItemId, hoveredTile) : null,
  );
  if (state.milestoneAt !== null && state.simTime - state.milestoneAt < 2_400) {
    drawMilestone(context, width, height, state.simTime - state.milestoneAt, reducedMotion);
  }
}

function getGroundLayer(
  width: number,
  height: number,
  dpr: number,
  cache: GroundLayerCache,
): HTMLCanvasElement {
  const key = `${Math.round(width * dpr)}x${Math.round(height * dpr)}|${dpr}`;
  if (cache.canvas && cache.key === key) return cache.canvas;
  const canvas = cache.canvas ?? document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const context = canvas.getContext("2d", { alpha: false })!;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBackdrop(context, width, height);
  cache.canvas = canvas;
  cache.key = key;
  return canvas;
}

function parcelPolygon(parcel: Position): Position[] {
  const bounds = parcelBounds(parcel);
  return [
    tileDiamond({ x: bounds.minX, y: bounds.minY })[0],
    tileDiamond({ x: bounds.maxX, y: bounds.minY })[1],
    tileDiamond({ x: bounds.maxX, y: bounds.maxY })[2],
    tileDiamond({ x: bounds.minX, y: bounds.maxY })[3],
  ];
}

function tracePolygon(context: CanvasRenderingContext2D, points: Position[]) {
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) context.lineTo(points[index].x, points[index].y);
  context.closePath();
}

function drawUnlockedParcels(context: CanvasRenderingContext2D, parcels: Position[]) {
  context.save();
  context.lineWidth = 1.3;
  context.setLineDash([10, 8]);
  for (const parcel of parcels) {
    tracePolygon(context, parcelPolygon(parcel));
    context.fillStyle = "rgba(246, 247, 248, .32)";
    context.fill();
    context.strokeStyle = "rgba(135, 142, 151, .28)";
    context.stroke();
  }
  context.restore();
}

function drawExpansionParcels(
  context: CanvasRenderingContext2D,
  unlocked: Position[],
  treasuryCoins: number,
  difficulty: import("../game/types").DifficultyLevel,
  hoveredTile: Position | null,
) {
  const hoveredKey = hoveredTile ? parcelKey(parcelForPosition(hoveredTile)) : "";
  context.save();
  context.lineWidth = 2;
  for (const parcel of frontierParcels(unlocked)) {
    const affordable = treasuryCoins >= parcelCost(parcel, difficulty);
    const hovered = parcelKey(parcel) === hoveredKey;
    tracePolygon(context, parcelPolygon(parcel));
    context.fillStyle = affordable
      ? `rgba(85, 174, 109, ${hovered ? 0.18 : 0.08})`
      : `rgba(207, 91, 83, ${hovered ? 0.14 : 0.05})`;
    context.fill();
    context.strokeStyle = affordable ? "rgba(63, 145, 84, .68)" : "rgba(188, 83, 77, .48)";
    context.stroke();
    if (hovered) {
      const center = worldToIso({ x: parcel.x * 9, y: parcel.y * 9 });
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.font = "800 13px 'Microsoft YaHei UI', system-ui";
      context.fillStyle = affordable ? "#347b49" : "#a64b46";
      context.fillText(formatMoney(parcelCost(parcel, difficulty)), center.x, center.y);
    }
  }
  context.restore();
}

const RESOURCE_COLORS: Record<string, string> = {
  wood: "126, 96, 62",
  stone: "117, 130, 145",
  sand: "220, 178, 73",
  water: "66, 151, 226",
  fiber: "75, 161, 96",
  ore: "133, 108, 174",
};

function drawResourceRegions(context: CanvasRenderingContext2D, nodes: ResourceNode[]) {
  for (const node of nodes) {
    const color = RESOURCE_COLORS[node.itemId] ?? "108, 126, 112";
    for (const tile of resourceHarvestTiles(node)) {
      tracePolygon(context, tileDiamond(tile));
      context.fillStyle = `rgba(${color}, .14)`;
      context.fill();
      context.strokeStyle = `rgba(${color}, .38)`;
      context.lineWidth = 1;
      context.stroke();
    }
    tracePolygon(context, tileDiamond(node.position));
    context.fillStyle = `rgba(${color}, .28)`;
    context.fill();
    context.strokeStyle = `rgba(${color}, .72)`;
    context.lineWidth = 1.8;
    context.stroke();
  }
}

function drawResourceMarker(context: CanvasRenderingContext2D, node: ResourceNode, dpr: number) {
  const color = RESOURCE_COLORS[node.itemId] ?? "108, 126, 112";
  const center = worldToIso(node.position);
  context.save();
  context.beginPath();
  context.ellipse(center.x, center.y + 5, 25, 11, 0, 0, Math.PI * 2);
  context.fillStyle = `rgba(${color}, .22)`;
  context.fill();
  context.strokeStyle = `rgba(${color}, .58)`;
  context.lineWidth = 1.4;
  context.stroke();
  const item = ITEM_BY_ID.get(node.itemId);
  const size = 25;
  const emoji = getEmojiCanvas(item?.emoji ?? "📦", size, dpr);
  context.drawImage(emoji, center.x - size / 2 - 2, center.y - size / 2 - 10, size + 4, size + 4);
  context.restore();
}

function drawBuildingMarker(context: CanvasRenderingContext2D, building: DeployedBuilding, dpr: number) {
  const center = worldToIso(building.position);
  const emoji = getEmojiCanvas(ITEM_BY_ID.get(building.itemId)?.emoji ?? "🏗️", 25, dpr);
  context.save();
  context.beginPath();
  context.arc(center.x + 29, center.y - 23, 17, 0, Math.PI * 2);
  context.fillStyle = "rgba(255,255,255,.9)";
  context.fill();
  context.strokeStyle = "rgba(98,112,103,.36)";
  context.stroke();
  context.drawImage(emoji, center.x + 14, center.y - 39, 30, 30);
  context.restore();
}

function drawBuildingAura(context: CanvasRenderingContext2D, position: Position, itemId: string) {
  const radius = itemId === "reactor" ? 3 : 2;
  context.save();
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      if (Math.abs(dx) + Math.abs(dy) > radius) continue;
      const points = tileDiamond({ x: position.x + dx, y: position.y + dy });
      tracePolygon(context, points);
      context.fillStyle = "rgba(89, 151, 219, .055)";
      context.fill();
      context.strokeStyle = "rgba(89, 151, 219, .18)";
      context.lineWidth = 0.8;
      context.stroke();
    }
  }
  context.restore();
}

function drawBuildingPlacementPreview(
  context: CanvasRenderingContext2D,
  position: Position,
  itemId: string,
  valid: boolean,
  dpr: number,
) {
  const center = worldToIso(position);
  tracePolygon(context, tileDiamond(position));
  context.fillStyle = valid ? "rgba(67, 165, 101, .26)" : "rgba(215, 92, 85, .24)";
  context.fill();
  context.strokeStyle = valid ? "rgba(45, 135, 72, .9)" : "rgba(188, 61, 54, .9)";
  context.lineWidth = 2;
  context.stroke();
  const size = 31;
  const emoji = getEmojiCanvas(ITEM_BY_ID.get(itemId)?.emoji ?? "🏗️", size, dpr);
  context.save();
  context.globalAlpha = valid ? 0.9 : 0.55;
  context.drawImage(emoji, center.x - size / 2, center.y - size - 11, size, size);
  context.restore();
}

function drawBackdrop(context: CanvasRenderingContext2D, width: number, height: number) {
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
}

function drawCatStationBase(
  context: CanvasRenderingContext2D,
  cat: CatState,
  simTime: number,
  zoom: number,
  selected: boolean,
  reducedMotion: boolean,
) {
  const top = cat.action
    ? cat.action.type === "craft" ? "#e9f5ec" : cat.action.type === "pass" ? "#eaf1fb" : "#fbf0e5"
    : "#e5e7eb";
  drawExtrudedDiamond(context, cat.position, WORKSTATION_DEPTH, top, "#c6cbd1", "#b8bec5", selected ? "#d2a52c" : "#aeb4bb", selected ? 3 / zoom : 1.2 / zoom);
  const center = worldToIso(cat.position);

  if (selected) {
    context.save();
    context.shadowColor = "rgba(226, 190, 96, .72)";
    context.shadowBlur = 12;
    strokeDiamond(context, cat.position, "#e2be60", 2.4 / zoom);
    context.restore();
  }

  if (cat.action?.type === "pass" && cat.action.direction) {
    const pulse = reducedMotion ? 0.5 : (Math.sin(simTime / 260) + 1) / 2;
    drawDirectionArrow(context, center, cat.action.direction, pulse);
  }

  if (selected && zoom >= 0.62) {
    context.save();
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = "700 9px 'Microsoft YaHei UI', system-ui";
    context.fillStyle = "#6b7280";
    context.fillText(`(${cat.position.x}, ${cat.position.y})`, center.x, center.y + WORKSTATION_DEPTH + 8);
    context.restore();
  }
}

function drawCatActor(
  context: CanvasRenderingContext2D,
  cat: CatState,
  simTime: number,
  sprite: HTMLImageElement,
  dpr: number,
  reducedMotion: boolean,
) {
  const center = worldToIso(cat.position);
  const frame = animationFrame(simTime, Boolean(cat.action), reducedMotion);
  const motion = catMotion(cat, center, simTime, reducedMotion);
  const itemPosition = cat.action ? actionItemPosition(cat.action, center, simTime, reducedMotion) : null;
  if (cat.action && itemPosition && cat.action.type !== "pass" && motion.inFront) {
    drawAction(context, cat.action, itemPosition, simTime, dpr, reducedMotion);
  }
  drawCatSprite(context, sprite, frame, motion.x, motion.y, motion.mirror);
  if (cat.action && itemPosition && (cat.action.type === "pass" || !motion.inFront)) {
    drawAction(context, cat.action, itemPosition, simTime, dpr, reducedMotion);
  }
  if (!cat.action) drawIdleIndicator(context, center, cat.lastDecision);
}

function drawCatSprite(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  frame: number,
  x: number,
  y: number,
  mirror: boolean,
) {
  context.save();
  context.imageSmoothingEnabled = false;
  context.translate(Math.round(x), Math.round(y));
  if (mirror) context.scale(-1, 1);
  if (image.complete && image.naturalWidth) {
    const sourceX = (frame % 4) * 64;
    const sourceY = Math.floor(frame / 4) * 64;
    context.drawImage(image, sourceX, sourceY, 64, 64, -CAT_RENDER_SIZE / 2, -CAT_RENDER_SIZE / 2, CAT_RENDER_SIZE, CAT_RENDER_SIZE);
  } else {
    context.fillStyle = "#d9823b";
    context.fillRect(-CAT_RENDER_SIZE * 0.25, -CAT_RENDER_SIZE * 0.34, CAT_RENDER_SIZE * 0.5, CAT_RENDER_SIZE * 0.72);
    context.fillStyle = "#164b49";
    context.fillRect(-CAT_RENDER_SIZE * 0.19, CAT_RENDER_SIZE * 0.04, CAT_RENDER_SIZE * 0.38, CAT_RENDER_SIZE * 0.34);
  }
  context.restore();
}

function catMotion(
  cat: CatState,
  stationCenter: Position,
  simTime: number,
  reducedMotion: boolean,
): { x: number; y: number; mirror: boolean; inFront: boolean } {
  if (!cat.action) {
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
  } else if (!reducedMotion && cat.action.type === "sell") {
    angle -= elapsed / 3_800 * Math.PI * 2;
    radiusX = 27;
    radiusY = 12;
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

function actionItemPosition(
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

function actorScenePosition(cat: CatState, simTime: number, reducedMotion: boolean): Position {
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

function passTravel(action: ActionCommand, simTime: number, reducedMotion: boolean): number {
  if (reducedMotion) return 0.45;
  const progress = actionProgress(action, simTime);
  return progress * progress * (3 - 2 * progress);
}

function passScreenVector(direction: Direction): Position {
  const vectors: Record<Direction, Position> = {
    north: { x: TILE_WIDTH / 2, y: -TILE_HEIGHT / 2 },
    east: { x: TILE_WIDTH / 2, y: TILE_HEIGHT / 2 },
    south: { x: -TILE_WIDTH / 2, y: TILE_HEIGHT / 2 },
    west: { x: -TILE_WIDTH / 2, y: -TILE_HEIGHT / 2 },
  };
  return vectors[direction];
}

function actionProgress(action: ActionCommand, simTime: number): number {
  return Math.max(0, Math.min(1, (simTime - action.startedAt) / Math.max(1, action.endsAt - action.startedAt)));
}

function drawAction(
  context: CanvasRenderingContext2D,
  action: ActionCommand,
  itemPosition: Position,
  simTime: number,
  dpr: number,
  reducedMotion: boolean,
) {
  const item = ITEM_BY_ID.get(action.itemId);
  const x = itemPosition.x;
  const y = itemPosition.y;
  const progress = actionProgress(action, simTime);
  const pulse = reducedMotion ? 0.5 : (Math.sin(simTime / 260) + 1) / 2;
  const color = actionColor(action);

  context.save();
  if (action.type === "craft") {
    context.beginPath();
    context.arc(x, y, 18 + pulse * 3, 0, Math.PI * 2);
    context.fillStyle = `rgba(72, 201, 116, ${0.08 + pulse * 0.08})`;
    context.fill();
  } else if (action.type === "sell") {
    context.beginPath();
    context.arc(x, y, 20 + pulse * 2, 0, Math.PI * 2);
    context.strokeStyle = `rgba(242, 155, 75, ${0.34 + pulse * 0.36})`;
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = "rgba(242, 155, 75, .18)";
    context.fill();
  }

  const cached = getEmojiCanvas(item?.emoji ?? "❔", 30, dpr);
  context.drawImage(cached, x - 17, y - 17, 34, 34);

  // A light, compact sector and a precise outer ring replace the old black disc.
  if (progress > 0) {
    context.beginPath();
    context.moveTo(x, y);
    context.arc(x, y, 16, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    context.closePath();
    context.fillStyle = "rgba(5, 8, 7, .34)";
    context.fill();
  }
  context.beginPath();
  context.arc(x, y, 18.5, 0, Math.PI * 2);
  context.strokeStyle = "rgba(225, 234, 222, .25)";
  context.lineWidth = 2;
  context.stroke();
  context.beginPath();
  context.arc(x, y, 18.5, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
  context.strokeStyle = color;
  context.lineWidth = 2.4;
  context.lineCap = "round";
  context.stroke();
  context.restore();
}

function drawDirectionArrow(context: CanvasRenderingContext2D, center: Position, direction: Direction, pulse: number) {
  const offsets: Record<Direction, Position> = {
    north: { x: 22, y: -11 },
    east: { x: 22, y: 11 },
    south: { x: -22, y: 11 },
    west: { x: -22, y: -11 },
  };
  const offset = offsets[direction];
  const start = { x: center.x + offset.x * 0.55, y: center.y - 11 + offset.y * 0.55 };
  const end = { x: center.x + offset.x * (1.12 + pulse * 0.08), y: center.y - 11 + offset.y * (1.12 + pulse * 0.08) };
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.lineTo(end.x - Math.cos(angle - 0.65) * 8, end.y - Math.sin(angle - 0.65) * 8);
  context.moveTo(end.x, end.y);
  context.lineTo(end.x - Math.cos(angle + 0.65) * 8, end.y - Math.sin(angle + 0.65) * 8);
  context.strokeStyle = "rgba(99, 167, 255, .9)";
  context.lineWidth = 2.6;
  context.lineCap = "square";
  context.stroke();
}

function drawIdleIndicator(context: CanvasRenderingContext2D, center: Position, lastDecision: string) {
  const error = /错误|非法|缺少|没有/.test(lastDecision);
  context.beginPath();
  context.arc(center.x + 26, center.y - 16, 3, 0, Math.PI * 2);
  context.fillStyle = error ? "#dc5d55" : "rgba(107, 114, 128, .28)";
  context.fill();
}

function drawFloatingEvents(
  context: CanvasRenderingContext2D,
  cats: CatState[],
  events: FloatingEvent[],
  simTime: number,
  reducedMotion: boolean,
) {
  const catById = new Map(cats.map((cat) => [cat.id, cat]));
  const perCat = new Map<string, FloatingEvent[]>();
  for (const event of events) {
    const list = perCat.get(event.catId) ?? [];
    list.push(event);
    perCat.set(event.catId, list);
  }
  for (const list of perCat.values()) list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  for (const event of events) {
    const cat = catById.get(event.catId);
    if (!cat) continue;
    const age = Math.max(0, Math.min(1, (simTime - event.createdAt) / event.duration));
    const fade = age < 0.58 ? 1 : Math.max(0, 1 - (age - 0.58) / 0.42);
    const stack = perCat.get(event.catId) ?? [];
    const stackIndex = stack.findIndex((entry) => entry.id === event.id);
    const center = worldToIso(cat.position);
    const rise = reducedMotion ? 8 : age * 24;
    const x = center.x;
    const y = center.y - 82 - stackIndex * 17 - rise;
    const tax = event.text.includes("税");
    const color = event.kind === "sale" ? (tax ? "#c47b18" : "#d37c25") : "#32905a";

    context.save();
    context.globalAlpha = fade;
    drawEventParticles(context, event.id, x, y + 6, age, color, reducedMotion);
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = event.kind === "milestone" ? "900 19px 'Microsoft YaHei UI', system-ui" : "900 14px 'Microsoft YaHei UI', system-ui";
    context.lineJoin = "round";
    context.lineWidth = 4;
    context.strokeStyle = "rgba(255, 255, 255, .94)";
    context.strokeText(event.text, x, y);
    context.fillStyle = color;
    context.fillText(event.text, x, y);
    context.restore();
  }
}

function drawEventParticles(
  context: CanvasRenderingContext2D,
  id: string,
  x: number,
  y: number,
  age: number,
  color: string,
  reducedMotion: boolean,
) {
  const seed = hashString(id);
  context.fillStyle = color;
  for (let index = 0; index < 5; index += 1) {
    const angle = ((seed + index * 97) % 628) / 100;
    const distance = reducedMotion ? 5 : (7 + ((seed >> (index + 1)) & 7)) * Math.sin(age * Math.PI);
    const size = index % 2 ? 2 : 1.5;
    context.fillRect(x + Math.cos(angle) * distance - size / 2, y + Math.sin(angle) * distance - size / 2, size, size);
  }
}

function drawPlacementPreview(context: CanvasRenderingContext2D, position: Position, simTime: number, reducedMotion: boolean) {
  const alpha = reducedMotion ? 0.52 : 0.48 + Math.sin(simTime / 420) * 0.05;
  drawExtrudedDiamond(context, position, WORKSTATION_DEPTH, `rgba(206, 239, 214, ${alpha})`, "#b7d8bf", "#a8cbb1", "#4fa86b", 2);
  const center = worldToIso(position);
  context.save();
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = "900 24px system-ui";
  context.fillStyle = "#438d5b";
  context.fillText("+", center.x, center.y - 2);
  context.restore();
}

function drawExtrudedDiamond(
  context: CanvasRenderingContext2D,
  position: Position,
  depth: number,
  top: string,
  right: string,
  left: string,
  stroke: string,
  lineWidth: number,
) {
  const [north, east, south, west] = tileDiamond(position);
  context.beginPath();
  context.moveTo(west.x, west.y);
  context.lineTo(south.x, south.y);
  context.lineTo(south.x, south.y + depth);
  context.lineTo(west.x, west.y + depth);
  context.closePath();
  context.fillStyle = left;
  context.fill();
  context.beginPath();
  context.moveTo(south.x, south.y);
  context.lineTo(east.x, east.y);
  context.lineTo(east.x, east.y + depth);
  context.lineTo(south.x, south.y + depth);
  context.closePath();
  context.fillStyle = right;
  context.fill();
  context.beginPath();
  context.moveTo(north.x, north.y);
  context.lineTo(east.x, east.y);
  context.lineTo(south.x, south.y);
  context.lineTo(west.x, west.y);
  context.closePath();
  context.fillStyle = top;
  context.fill();
  context.strokeStyle = stroke;
  context.lineWidth = lineWidth;
  context.stroke();
}

function strokeDiamond(context: CanvasRenderingContext2D, position: Position, color: string, lineWidth: number) {
  const points = tileDiamond(position);
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) context.lineTo(points[index].x, points[index].y);
  context.closePath();
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.stroke();
}

function drawCanvasHud(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  paused: boolean,
  hoveredTile: Position | null,
  expansionMode: boolean,
  unlockedParcels: Position[],
  treasuryCoins: number,
  difficulty: import("../game/types").DifficultyLevel,
  placingBuildingItemId: string | null,
  buildingPlacementError: string | null,
) {
  if (hoveredTile) {
    const parcel = parcelForPosition(hoveredTile);
    const unlocked = unlockedParcels.some((entry) => parcelKey(entry) === parcelKey(parcel));
    const label = placingBuildingItemId
      ? `${hoveredTile.x}, ${hoveredTile.y} · ${buildingPlacementError ?? "可以放置"}`
      : expansionMode && !unlocked
      ? `地块 (${parcel.x}, ${parcel.y}) · ${formatMoney(parcelCost(parcel, difficulty))}${treasuryCoins >= parcelCost(parcel, difficulty) ? "" : " · 金币不足"}`
      : `${hoveredTile.x}, ${hoveredTile.y}`;
    context.font = "700 11px 'Microsoft YaHei UI', system-ui";
    const textWidth = context.measureText(label).width;
    roundedPath(context, 14, height - 43, textWidth + 28, 27, 8);
    context.fillStyle = "rgba(255, 255, 255, .94)";
    context.fill();
    context.strokeStyle = "rgba(107, 114, 128, .2)";
    context.stroke();
    context.fillStyle = "#6b7280";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, 28 + textWidth / 2, height - 29.5);
  }
  if (placingBuildingItemId) {
    roundedPath(context, width / 2 - 78, 18, 156, 32, 9);
    context.fillStyle = "rgba(241, 250, 243, .96)";
    context.fill();
    context.strokeStyle = "rgba(63, 145, 84, .55)";
    context.stroke();
    context.fillStyle = "#347b49";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = "800 12px 'Microsoft YaHei UI', system-ui";
    context.fillText(`放置 ${ITEM_BY_ID.get(placingBuildingItemId)?.name ?? placingBuildingItemId}`, width / 2, 34);
  } else if (expansionMode) {
    roundedPath(context, width / 2 - 68, 18, 136, 32, 9);
    context.fillStyle = "rgba(241, 250, 243, .96)";
    context.fill();
    context.strokeStyle = "rgba(63, 145, 84, .55)";
    context.stroke();
    context.fillStyle = "#347b49";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = "800 12px 'Microsoft YaHei UI', system-ui";
    context.fillText("开拓模式 · 点击相邻地块", width / 2, 34);
  }
  if (paused) {
    roundedPath(context, width / 2 - 55, 18, 110, 32, 9);
    context.fillStyle = "rgba(255, 255, 255, .96)";
    context.fill();
    context.strokeStyle = "rgba(210, 165, 44, .7)";
    context.stroke();
    context.fillStyle = "#9a7111";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = "800 12px 'Microsoft YaHei UI', system-ui";
    context.fillText("Ⅱ 工坊已暂停", width / 2, 34);
  }
}

function drawMilestone(context: CanvasRenderingContext2D, width: number, height: number, elapsed: number, reducedMotion: boolean) {
  const age = Math.min(1, elapsed / 2_400);
  const alpha = age < 0.76 ? 1 : Math.max(0, 1 - (age - 0.76) / 0.24);
  const pulse = reducedMotion ? 1 : 1 + Math.sin(elapsed / 110) * 0.035;
  context.save();
  context.globalAlpha = alpha;
  context.translate(width / 2, height / 2);
  context.scale(pulse, pulse);
  const glow = context.createRadialGradient(0, -10, 5, 0, -10, 120);
  glow.addColorStop(0, "rgba(100, 170, 230, .24)");
  glow.addColorStop(1, "rgba(100, 213, 130, 0)");
  context.fillStyle = glow;
  context.fillRect(-150, -140, 300, 260);
  context.textAlign = "center";
  context.font = `64px ${EMOJI_FONT}`;
  context.fillText("🌀", 0, -24);
  context.font = "900 26px 'Microsoft YaHei UI', system-ui";
  context.lineWidth = 8;
  context.strokeStyle = "rgba(255, 255, 255, .96)";
  context.strokeText("星门已开启", 0, 36);
  context.fillStyle = "#344054";
  context.fillText("星门已开启", 0, 36);
  context.restore();
}

function getEmojiCanvas(emoji: string, size: number, dpr: number): HTMLCanvasElement {
  const ratio = Math.max(1, Math.round(dpr * 100) / 100);
  const key = `${emoji}|${size}|${ratio}`;
  const existing = emojiCache.get(key);
  if (existing) return existing;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil((size + 8) * ratio);
  canvas.height = Math.ceil((size + 8) * ratio);
  const context = canvas.getContext("2d")!;
  context.scale(ratio, ratio);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `${size}px ${EMOJI_FONT}`;
  context.fillText(emoji, (size + 8) / 2, (size + 8) / 2 + 1);
  emojiCache.set(key, canvas);
  return canvas;
}

function actionColor(action: ActionCommand | null): string {
  if (!action) return "rgba(126, 147, 130, .38)";
  if (action.type === "craft") return "#64d582";
  if (action.type === "pass") return "#63a7ff";
  return "#f29b4b";
}

function animationFrame(simTime: number, working: boolean, reducedMotion: boolean): number {
  if (reducedMotion) return working ? 4 : 0;
  if (!working) {
    const idle = Math.floor(simTime / 900) % 14;
    if (idle === 5) return 1;
    if (idle === 10) return 2;
    if (idle === 11) return 3;
    return 0;
  }
  return 4 + Math.floor(simTime / 360) % 4;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function roundedPath(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}
