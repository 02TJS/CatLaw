import { useEffect, useRef, useState } from "react";
import catSpriteUrl from "../assets/cat-workshop-sprite.png?url";
import { ITEM_BY_ID } from "../game/catalog";
import type { GameController } from "../game/controller";
import { buildingPlacementFailure, formatMoney, landmarkPlacementFailure } from "../game/engine";
import { LANDMARK_BY_ID } from "../game/landmarks";
import { speechEventIsVisible } from "../game/speech";
import type { ActionCommand, CatState, DeployedBuilding, DeployedLandmark, Direction, FloatingEvent, LandmarkId, Position, ResourceNode } from "../game/types";
import { frontierParcels, isPositionUnlocked, parcelBounds, parcelCost, parcelForPosition, parcelKey, resourceHarvestTiles } from "../game/world";
import {
  MAP_SCALE_MAX,
  MAP_SCALE_MIN,
} from "./uiPreferences";
import {
  type Camera,
  depthCompare,
  isoToScreen,
  isoPointToTile,
  pointInTile,
  sceneDepthCompare,
  screenToIso,
  TILE_HEIGHT,
  TILE_WIDTH,
  tileDiamond,
  visibleWorldBounds,
  WORKSTATION_DEPTH,
  worldToIso,
} from "./isometric";
import { EmojiCanvasCache } from "./emojiCanvasCache";
import { buildingQualityPalette, itemQualityLevel, itemQualityPalette, type ItemQualityPalette, workstationQualityVisual } from "./itemQuality";
import { chooseSpeechBubblePlacement, wrapSpeechText, type SpeechLayoutRectangle, type SpeechProtectedRectangle } from "./speechLayout";
import { buildMapLensSnapshot, LENS_COLORS, type LensColor, type MapLensId, type MapLensOrderFloor, type MapLensSnapshot } from "./mapLenses";

const DEFAULT_CAMERA: Camera = { x: 32, y: 28, zoom: 1.08 };
const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
const CAT_RENDER_SCALE = 2 / 5;
const CAT_RENDER_SIZE = 64 * CAT_RENDER_SCALE;
const CANVAS_FRAME_INTERVAL_MS = 1000 / 60;
const emojiCache = new EmojiCanvasCache<HTMLCanvasElement>();

interface GroundLayerCache {
  canvas?: HTMLCanvasElement;
  key?: string;
}

interface RenderScratch {
  visibleCats: CatState[];
  scene: SceneEntry[];
  stationBases: CatState[];
  catById: Map<string, CatState>;
  lensCache?: { revision: number; lensId: MapLensId; itemId: string | null; snapshot: MapLensSnapshot };
  speechControls: { measuredAt: number; width: number; height: number; rectangles: SpeechLayoutRectangle[] };
}

function createRenderScratch(): RenderScratch {
  return {
    visibleCats: [],
    scene: [],
    stationBases: [],
    catById: new Map(),
    speechControls: { measuredAt: Number.NEGATIVE_INFINITY, width: 0, height: 0, rectangles: [] },
  };
}

const SPEECH_CONTROL_SELECTORS = [
  ".pet-drag-region",
  ".pet-headline-stats",
  ".pet-main-commerce",
  ".pet-window-controls",
  ".pet-dock",
  ".map-lens-palette",
  ".map-lens-legend",
  ".pet-drawer",
  ".pet-commerce-feedback",
  ".pet-quick-stats",
  ".pet-add-cat-menu",
] as const;

function collectSpeechControlObstacles(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  measuredAt: number,
  cache: RenderScratch["speechControls"],
): SpeechLayoutRectangle[] {
  if (cache.width === width && cache.height === height && measuredAt - cache.measuredAt < 200) return cache.rectangles;
  const canvasRect = canvas.getBoundingClientRect();
  const margin = 6;
  const rectangles: SpeechLayoutRectangle[] = [];
  for (const selector of SPEECH_CONTROL_SELECTORS) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const rect = element.getBoundingClientRect();
      const left = Math.max(0, rect.left - canvasRect.left - margin);
      const top = Math.max(0, rect.top - canvasRect.top - margin);
      const right = Math.min(width, rect.right - canvasRect.left + margin);
      const bottom = Math.min(height, rect.bottom - canvasRect.top + margin);
      if (right > left && bottom > top) rectangles.push({ x: left, y: top, width: right - left, height: bottom - top });
    }
  }
  cache.measuredAt = measuredAt;
  cache.width = width;
  cache.height = height;
  cache.rectangles = rectangles;
  return rectangles;
}

interface Props {
  controller: GameController;
  selectedCatId: string;
  onSelectCat: (id: string) => void;
  expansionMode: boolean;
  placingBuildingItemId: string | null;
  onBuildingPlacementResult: (feedback: { itemId: string; position: Position; ok: boolean; error?: string }) => void;
  placingLandmarkId: LandmarkId | null;
  speechScale: number;
  mapScale: number;
  onMapScaleChange: (scale: number) => void;
  onLandmarkPlacementResult: (feedback: { landmarkId: LandmarkId; position: Position; ok: boolean; error?: string }) => void;
  mapLensId: MapLensId;
  mapLensItemId: string | null;
}

type SceneEntry =
  | { kind: "resource"; position: Position; layer: number; order: number; node: ResourceNode }
  | { kind: "building"; position: Position; layer: number; order: number; building: DeployedBuilding }
  | { kind: "landmark"; position: Position; layer: number; order: number; landmark: DeployedLandmark }
  | { kind: "actor"; position: Position; layer: number; order: number; cat: CatState };

interface AddCatMenu {
  tile: Position;
  x: number;
  y: number;
}

export function GameCanvas({
  controller,
  selectedCatId,
  onSelectCat,
  expansionMode,
  placingBuildingItemId,
  onBuildingPlacementResult,
  placingLandmarkId,
  speechScale,
  mapScale,
  onMapScaleChange,
  onLandmarkPlacementResult,
  mapLensId,
  mapLensItemId,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camera = useRef<Camera>({ ...DEFAULT_CAMERA, zoom: DEFAULT_CAMERA.zoom * mapScale });
  const hoveredTile = useRef<Position | null>(null);
  const drag = useRef<{ x: number; y: number; cameraX: number; cameraY: number; moved: boolean; nativeWindow: boolean } | null>(null);
  const groundCache = useRef<GroundLayerCache>({});
  const renderScratch = useRef<RenderScratch>(createRenderScratch());
  const renderOptions = useRef({ selectedCatId, expansionMode, placingBuildingItemId, placingLandmarkId, speechScale, mapLensId, mapLensItemId });
  renderOptions.current = { selectedCatId, expansionMode, placingBuildingItemId, placingLandmarkId, speechScale, mapLensId, mapLensItemId };
  const [addCatMenu, setAddCatMenu] = useState<AddCatMenu | null>(null);

  useEffect(() => {
    camera.current.zoom = DEFAULT_CAMERA.zoom * mapScale;
  }, [mapScale]);

  useEffect(() => {
    const dismissAddCatMenu = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-testid='add-cat-menu']")) return;
      setAddCatMenu(null);
    };
    window.addEventListener("pointerdown", dismissAddCatMenu, true);
    return () => window.removeEventListener("pointerdown", dismissAddCatMenu, true);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const context = canvas.getContext("2d", { alpha: true })!;
    const image = new Image();
    image.src = catSpriteUrl;
    let frameHandle = 0;
    let lastDrawAt = Number.NEGATIVE_INFINITY;
    let dpr = window.devicePixelRatio || 1;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const draw = (now: number) => {
      // Leave a small tolerance for 60 Hz displays whose rAF timestamps land a
      // fraction below 16.667 ms; without it, every other frame can be skipped.
      if (now - lastDrawAt + 0.5 < CANVAS_FRAME_INTERVAL_MS) {
        frameHandle = requestAnimationFrame(draw);
        return;
      }
      lastDrawAt = now;
      const rect = canvas.getBoundingClientRect();
      const options = renderOptions.current;
      const hasVisibleSpeech = controller.state.floatingEvents.some((event) => speechEventIsVisible(event, controller.state.simTime));
      const speechControlObstacles = hasVisibleSpeech
        ? collectSpeechControlObstacles(canvas, rect.width, rect.height, now, renderScratch.current.speechControls)
        : [];
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      drawWorld(
        context,
        rect.width,
        rect.height,
        dpr,
        controller,
        image,
        camera.current,
        options.selectedCatId,
        hoveredTile.current,
        options.expansionMode,
        options.placingBuildingItemId,
        options.placingLandmarkId,
        options.speechScale,
        speechControlObstacles,
        options.mapLensId,
        options.mapLensItemId,
        reducedMotion,
        groundCache.current,
        renderScratch.current,
      );
      frameHandle = requestAnimationFrame(draw);
    };
    frameHandle = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frameHandle);
      observer.disconnect();
    };
  }, [controller]);

  const pointToTile = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const isoPoint = screenToIso(
      { x: clientX - rect.left, y: clientY - rect.top },
      camera.current,
      { width: rect.width, height: rect.height },
    );
    const rough = isoPointToTile(isoPoint);
    const raisedHit = controller.state.cats
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
  };

  const activateHoveredTile = () => {
    const tile = hoveredTile.current;
    if (!tile) return;
    if (placingBuildingItemId) {
      const result = controller.placeBuilding(placingBuildingItemId, tile);
      onBuildingPlacementResult({ itemId: placingBuildingItemId, position: { ...tile }, ...result });
      return;
    }
    if (placingLandmarkId) {
      const result = controller.placeLandmark(placingLandmarkId, tile);
      onLandmarkPlacementResult({ landmarkId: placingLandmarkId, position: { ...tile }, ...result });
      return;
    }
    if (expansionMode) {
      const occupied = controller.state.cats.find((cat) => cat.position.x === tile.x && cat.position.y === tile.y);
      if (mapLensId !== "none" && occupied) {
        onSelectCat(occupied.id);
        return;
      }
      controller.expandParcel(parcelForPosition(tile));
      return;
    }
    if (!isPositionUnlocked(controller.state.unlockedParcels, tile)) return;
    const occupied = controller.state.cats.find((cat) => cat.position.x === tile.x && cat.position.y === tile.y);
    if (occupied) onSelectCat(occupied.id);
  };

  const addCatAt = (tile: Position) => {
    if (placingBuildingItemId || placingLandmarkId || expansionMode) return;
    if (!isPositionUnlocked(controller.state.unlockedParcels, tile)) return;
    if (controller.state.cats.some((cat) => cat.position.x === tile.x && cat.position.y === tile.y)) return;
    controller.addCat(tile);
  };

  const canOfferAddCatAt = (tile: Position) => !placingBuildingItemId
    && !placingLandmarkId
    && !expansionMode
    && isPositionUnlocked(controller.state.unlockedParcels, tile)
    && !controller.state.resourceNodes.some((node) => node.position.x === tile.x && node.position.y === tile.y)
    && !controller.state.buildings.some((building) => building.position.x === tile.x && building.position.y === tile.y)
    && !controller.state.landmarks.some((landmark) => landmark.position.x === tile.x && landmark.position.y === tile.y)
    && !controller.state.cats.some((cat) => cat.position.x === tile.x && cat.position.y === tile.y);

  return (
    <>
    <canvas
      id="game-canvas"
      ref={canvasRef}
      data-testid="game-canvas"
      data-map-scale={mapScale}
      tabIndex={0}
      aria-label={window.catWorkshopDesktop ? "等距猫咪工坊。普通模式左键拖动桌宠、滚轮缩放整体；地图模式改为平移和缩放地图。右键合法空地打开新增猫咪按钮。" : "等距猫咪工坊。左键拖拽平移，滚轮缩放地图，右键合法空地打开新增猫咪按钮。"}
      onContextMenu={(event) => {
        event.preventDefault();
        const tile = pointToTile(event.clientX, event.clientY);
        hoveredTile.current = tile;
        if (!canOfferAddCatAt(tile)) {
          setAddCatMenu(null);
          return;
        }
        const rect = canvasRef.current!.getBoundingClientRect();
        setAddCatMenu({
          tile,
          x: Math.max(64, Math.min(rect.width - 64, event.clientX - rect.left)),
          y: Math.max(12, Math.min(rect.height - 48, event.clientY - rect.top)),
        });
      }}
      onPointerDown={(event) => {
        canvasRef.current?.focus();
        if (event.button !== 0) return;
        canvasRef.current?.setPointerCapture(event.pointerId);
        const nativeWindow = Boolean(window.catWorkshopDesktop) && !placingBuildingItemId && !placingLandmarkId && !expansionMode;
        drag.current = { x: event.clientX, y: event.clientY, cameraX: camera.current.x, cameraY: camera.current.y, moved: false, nativeWindow };
        if (nativeWindow) window.catWorkshopDesktop?.beginWindowDrag(event.screenX, event.screenY);
      }}
      onPointerMove={(event) => {
        hoveredTile.current = pointToTile(event.clientX, event.clientY);
        if (!drag.current) return;
        const dx = event.clientX - drag.current.x;
        const dy = event.clientY - drag.current.y;
        if (Math.hypot(dx, dy) > 4) drag.current.moved = true;
        if (drag.current.nativeWindow) {
          window.catWorkshopDesktop?.moveWindowDrag(event.screenX, event.screenY);
          return;
        }
        camera.current.x = drag.current.cameraX - dx / camera.current.zoom;
        camera.current.y = drag.current.cameraY - dy / camera.current.zoom;
      }}
      onPointerLeave={() => {
        if (!drag.current || !drag.current.nativeWindow) hoveredTile.current = null;
      }}
      onPointerUp={(event) => {
        if (event.button !== 0) return;
        const current = drag.current;
        drag.current = null;
        if (current?.nativeWindow) window.catWorkshopDesktop?.endWindowDrag();
        hoveredTile.current = pointToTile(event.clientX, event.clientY);
        if (!current || current.moved) return;
        activateHoveredTile();
      }}
      onPointerCancel={() => {
        if (drag.current?.nativeWindow) window.catWorkshopDesktop?.endWindowDrag();
        drag.current = null;
      }}
      onWheel={(event) => {
        if (window.catWorkshopDesktop && !expansionMode) return;
        const rect = canvasRef.current!.getBoundingClientRect();
        const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        const before = screenToIso(pointer, camera.current, { width: rect.width, height: rect.height });
        const nextScale = Math.round(Math.max(
          MAP_SCALE_MIN,
          Math.min(MAP_SCALE_MAX, (camera.current.zoom * Math.exp(-event.deltaY * 0.001)) / DEFAULT_CAMERA.zoom),
        ) * 20) / 20;
        camera.current.zoom = DEFAULT_CAMERA.zoom * nextScale;
        const after = screenToIso(pointer, camera.current, { width: rect.width, height: rect.height });
        camera.current.x += before.x - after.x;
        camera.current.y += before.y - after.y;
        hoveredTile.current = pointToTile(event.clientX, event.clientY);
        onMapScaleChange(nextScale);
      }}
    />
    {addCatMenu && <button
      className="pet-add-cat-menu"
      data-testid="add-cat-menu"
      style={{ left: addCatMenu.x, top: addCatMenu.y }}
      onClick={() => {
        addCatAt(addCatMenu.tile);
        setAddCatMenu(null);
      }}
    >＋ 新增猫咪</button>}
    </>
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
  placingLandmarkId: LandmarkId | null,
  speechScale: number,
  speechControlObstacles: readonly SpeechLayoutRectangle[],
  mapLensId: MapLensId,
  mapLensItemId: string | null,
  reducedMotion: boolean,
  groundCache: GroundLayerCache,
  scratch: RenderScratch,
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
  const revision = controller.getRevision();
  if (!scratch.lensCache || scratch.lensCache.revision !== revision
    || scratch.lensCache.lensId !== mapLensId || scratch.lensCache.itemId !== mapLensItemId) {
    scratch.lensCache = {
      revision,
      lensId: mapLensId,
      itemId: mapLensItemId,
      snapshot: buildMapLensSnapshot(state, mapLensId, mapLensItemId),
    };
  }
  const lens = scratch.lensCache.snapshot;
  if (mapLensId === "environment") drawLensAreas(context, lens);
  else drawResourceRegions(context, state.resourceNodes);
  if (mapLensId === "coordinates") drawCoordinateAxes(context, bounds, camera.zoom);

  const { visibleCats, scene, stationBases, catById } = scratch;
  visibleCats.length = 0;
  scene.length = 0;
  stationBases.length = 0;
  catById.clear();
  for (const cat of state.cats) {
    if (cat.position.x < bounds.minX - 1 || cat.position.x > bounds.maxX + 1
      || cat.position.y < bounds.minY - 1 || cat.position.y > bounds.maxY + 1) continue;
    visibleCats.push(cat);
    catById.set(cat.id, cat);
  }
  for (let index = 0; index < state.resourceNodes.length; index += 1) {
    const node = state.resourceNodes[index];
    if (node.position.x < bounds.minX - 1 || node.position.x > bounds.maxX + 1
      || node.position.y < bounds.minY - 1 || node.position.y > bounds.maxY + 1) continue;
    scene.push({ kind: "resource", position: node.position, layer: 0.5, order: -1_000_000 + index, node });
  }
  for (const cat of visibleCats) {
    scene.push({
      kind: "actor",
      position: actorScenePosition(cat, state.simTime, reducedMotion),
      layer: 0.5,
      order: cat.createdIndex * 4 + 2,
      cat,
    });
  }
  for (let index = 0; index < state.buildings.length; index += 1) {
    const building = state.buildings[index];
    if (building.position.x < bounds.minX - 1 || building.position.x > bounds.maxX + 1
      || building.position.y < bounds.minY - 1 || building.position.y > bounds.maxY + 1) continue;
    scene.push({ kind: "building", position: building.position, layer: 0.35, order: index * 4 + 1, building });
  }
  for (let index = 0; index < state.landmarks.length; index += 1) {
    const landmark = state.landmarks[index];
    if (landmark.position.x < bounds.minX - 1 || landmark.position.x > bounds.maxX + 1
      || landmark.position.y < bounds.minY - 1 || landmark.position.y > bounds.maxY + 1) continue;
    scene.push({ kind: "landmark", position: landmark.position, layer: 0.4, order: 500_000 + index, landmark });
  }
  scene.sort(sceneDepthCompare);

  // Workstations are terrain, not scene actors. Drawing every base before the
  // footpoint-sorted object layer prevents a tile top from covering a cat that
  // is crossing its rear edge while still preserving actor/building occlusion.
  stationBases.push(...visibleCats);
  stationBases.sort((a, b) => sceneDepthCompare(
    { position: a.position, layer: 0, order: a.createdIndex },
    { position: b.position, layer: 0, order: b.createdIndex },
  ));
  for (const cat of stationBases) {
    drawCatStationBase(
      context,
      cat,
      state.simTime,
      camera.zoom,
      reducedMotion,
      dpr,
      lens.catColors.get(cat.id),
      mapLensId === "orders" || mapLensId === "stability" ? lens.orderFloors.get(cat.id) : undefined,
      mapLensId === "inventory",
    );
  }
  if (mapLensId === "orders" || mapLensId === "stability") drawOrderLensEdges(context, lens, catById, camera.zoom);

  if (hoveredTile && placingLandmarkId) {
    const failure = landmarkPlacementFailure(state, placingLandmarkId, hoveredTile);
    drawLandmarkAura(context, hoveredTile, placingLandmarkId);
    drawLandmarkPlacementPreview(context, hoveredTile, placingLandmarkId, !failure, dpr);
  } else if (hoveredTile && placingBuildingItemId) {
    const failure = buildingPlacementFailure(state, placingBuildingItemId, hoveredTile);
    drawBuildingAura(context, hoveredTile, placingBuildingItemId);
    drawBuildingPlacementPreview(context, hoveredTile, placingBuildingItemId, !failure, dpr);
  } else if (hoveredTile && state.landmarks.some((landmark) => landmark.position.x === hoveredTile.x && landmark.position.y === hoveredTile.y)) {
    const landmark = state.landmarks.find((entry) => entry.position.x === hoveredTile.x && entry.position.y === hoveredTile.y)!;
    drawLandmarkAura(context, landmark.position, landmark.landmarkId);
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
      case "landmark":
        drawLandmarkMarker(context, entry.landmark, dpr);
        break;
      case "actor":
        drawCatActor(context, entry.cat, state.simTime, image, dpr, reducedMotion, mapLensId !== "none");
        break;
    }
  }

  if (mapLensId === "coordinates") drawCoordinateCatLabels(context, visibleCats, camera.zoom);

  if (mapLensId === "none") drawFloatingEvents(context, catById, state.floatingEvents, state.simTime, reducedMotion);
  context.restore();

  if (mapLensId === "none") {
    drawSpeechBubbles(
      context,
      catById,
      state.floatingEvents,
      state.simTime,
      reducedMotion,
      camera,
      width,
      height,
      speechScale,
      speechControlObstacles,
    );
  }

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
    placingLandmarkId,
    hoveredTile && placingLandmarkId ? landmarkPlacementFailure(state, placingLandmarkId, hoveredTile) : null,
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
  const context = canvas.getContext("2d", { alpha: true })!;
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
  context.lineWidth = 0.72;
  context.setLineDash([]);
  for (const parcel of parcels) {
    const bounds = parcelBounds(parcel);
    context.strokeStyle = "rgba(104, 116, 108, .16)";
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
        tracePolygon(context, tileDiamond({ x, y }));
        context.stroke();
      }
    }

    context.lineWidth = 1.25;
    context.setLineDash([9, 7]);
    tracePolygon(context, parcelPolygon(parcel));
    context.strokeStyle = "rgba(91, 105, 96, .34)";
    context.stroke();
    context.lineWidth = 0.72;
    context.setLineDash([]);
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
      context.fillStyle = `rgba(${color}, .055)`;
      context.fill();
      context.strokeStyle = `rgba(${color}, .22)`;
      context.lineWidth = 0.85;
      context.stroke();
    }
    tracePolygon(context, tileDiamond(node.position));
    context.fillStyle = `rgba(${color}, .12)`;
    context.fill();
    context.strokeStyle = `rgba(${color}, .52)`;
    context.lineWidth = 1.4;
    context.stroke();
  }
}

function drawLensAreas(context: CanvasRenderingContext2D, lens: MapLensSnapshot) {
  context.save();
  for (const area of lens.areas) {
    const tiles: Position[] = [];
    if (area.kind === "resource") {
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          if (dx === 0 && dy === 0) continue;
          tiles.push({ x: area.position.x + dx, y: area.position.y + dy });
        }
      }
    } else {
      for (let dx = -area.radius; dx <= area.radius; dx += 1) {
        const remaining = area.radius - Math.abs(dx);
        for (let dy = -remaining; dy <= remaining; dy += 1) {
          tiles.push({ x: area.position.x + dx, y: area.position.y + dy });
        }
      }
    }
    for (const tile of tiles) {
      tracePolygon(context, tileDiamond(tile));
      context.globalAlpha = 0.15;
      context.fillStyle = area.color;
      context.fill();
      context.globalAlpha = 0.52;
      context.strokeStyle = area.color;
      context.lineWidth = 1.05;
      context.stroke();
    }
    tracePolygon(context, tileDiamond(area.position));
    context.globalAlpha = 0.28;
    context.fillStyle = area.color;
    context.fill();
    context.globalAlpha = 0.82;
    context.strokeStyle = area.color;
    context.lineWidth = 1.6;
    context.stroke();
  }
  context.restore();
}

function drawCoordinateAxisTile(
  context: CanvasRenderingContext2D,
  position: Position,
  color: string,
  label: string,
  zoom: number,
) {
  tracePolygon(context, tileDiamond(position));
  context.globalAlpha = 0.13;
  context.fillStyle = color;
  context.fill();
  context.globalAlpha = 0.72;
  context.strokeStyle = color;
  context.lineWidth = 1.2 / zoom;
  context.stroke();
  const center = worldToIso(position);
  const fontSize = 8.5 / zoom;
  context.font = `850 ${fontSize}px 'Microsoft YaHei UI', system-ui`;
  const textWidth = context.measureText(label).width;
  const paddingX = 4 / zoom;
  const boxHeight = 13 / zoom;
  const boxY = center.y + 11 / zoom;
  context.globalAlpha = 0.92;
  context.fillStyle = "rgba(255, 255, 255, .9)";
  context.beginPath();
  context.roundRect(center.x - textWidth / 2 - paddingX, boxY - boxHeight / 2, textWidth + paddingX * 2, boxHeight, 4 / zoom);
  context.fill();
  context.globalAlpha = 1;
  context.fillStyle = "#4c5650";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, center.x, boxY);
}

function drawCoordinateAxes(
  context: CanvasRenderingContext2D,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  zoom: number,
) {
  context.save();
  const minX = Math.floor(bounds.minX);
  const maxX = Math.ceil(bounds.maxX);
  const minY = Math.floor(bounds.minY);
  const maxY = Math.ceil(bounds.maxY);
  if (minY <= 0 && maxY >= 0) {
    for (let x = minX; x <= maxX; x += 1) {
      if (x === 0) continue;
      drawCoordinateAxisTile(context, { x, y: 0 }, LENS_COLORS.blue.top, `X ${x}`, zoom);
    }
  }
  if (minX <= 0 && maxX >= 0) {
    for (let y = minY; y <= maxY; y += 1) {
      if (y === 0) continue;
      drawCoordinateAxisTile(context, { x: 0, y }, LENS_COLORS.orange.top, `Y ${y}`, zoom);
    }
  }
  if (minX <= 0 && maxX >= 0 && minY <= 0 && maxY >= 0) {
    drawCoordinateAxisTile(context, { x: 0, y: 0 }, "#6f7772", "0,0", zoom);
  }
  context.restore();
}

function drawCoordinateCatLabels(
  context: CanvasRenderingContext2D,
  cats: readonly CatState[],
  zoom: number,
) {
  context.save();
  const fontSize = 8.5 / zoom;
  const paddingX = 5 / zoom;
  const boxHeight = 14 / zoom;
  context.font = `900 ${fontSize}px 'Microsoft YaHei UI', system-ui`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (const cat of cats) {
    const center = worldToIso(cat.position);
    const text = `#${cat.createdIndex + 1}  (${cat.position.x},${cat.position.y})`;
    const textWidth = context.measureText(text).width;
    const x = center.x;
    const y = center.y + WORKSTATION_DEPTH + 9 / zoom;
    context.fillStyle = "rgba(248, 249, 248, .94)";
    context.strokeStyle = "rgba(89, 98, 93, .62)";
    context.lineWidth = 1 / zoom;
    context.beginPath();
    context.roundRect(x - textWidth / 2 - paddingX, y - boxHeight / 2, textWidth + paddingX * 2, boxHeight, 4 / zoom);
    context.fill();
    context.stroke();
    context.fillStyle = "#404944";
    context.fillText(text, x, y);
  }
  context.restore();
}

function stableCurveSide(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2 === 0 ? -1 : 1;
}

function drawOrderLensEdges(
  context: CanvasRenderingContext2D,
  lens: MapLensSnapshot,
  catById: Map<string, CatState>,
  zoom: number,
) {
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const edge of lens.edges) {
    const sourceCat = catById.get(edge.sourceCatId);
    const targetCat = catById.get(edge.targetCatId);
    if (!sourceCat || !targetCat || sourceCat.id === targetCat.id) continue;
    const sourceCenter = worldToIso(sourceCat.position);
    const targetCenter = worldToIso(targetCat.position);
    const dx = targetCenter.x - sourceCenter.x;
    const dy = targetCenter.y - sourceCenter.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const unitX = dx / distance;
    const unitY = dy / distance;
    const trim = Math.min(22 / zoom, distance * 0.22);
    const start = { x: sourceCenter.x + unitX * trim, y: sourceCenter.y + unitY * trim - 8 / zoom };
    const end = { x: targetCenter.x - unitX * trim, y: targetCenter.y - unitY * trim - 8 / zoom };
    const bend = Math.max(24 / zoom, Math.min(94 / zoom, distance * 0.26));
    const side = stableCurveSide(edge.id);
    const normalX = -unitY;
    const normalY = unitX;
    const control = {
      x: (start.x + end.x) / 2 + normalX * bend * 0.28 * side,
      y: (start.y + end.y) / 2 + normalY * bend * 0.28 * side - bend,
    };

    const frequencyScale = Math.min(7, Math.log2(Math.max(1, edge.count ?? 1) + 1) * 1.25);
    context.globalAlpha = 0.88;
    context.strokeStyle = edge.color;
    context.lineWidth = (2.5 + frequencyScale) / zoom;
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.quadraticCurveTo(control.x, control.y, end.x, end.y);
    context.stroke();

    const tangentX = end.x - control.x;
    const tangentY = end.y - control.y;
    const tangentLength = Math.max(1, Math.hypot(tangentX, tangentY));
    const tx = tangentX / tangentLength;
    const ty = tangentY / tangentLength;
    const headLength = (8.5 + frequencyScale * 1.35) / zoom;
    const headWidth = (4.8 + frequencyScale * 0.85) / zoom;
    context.fillStyle = edge.color;
    context.beginPath();
    context.moveTo(end.x, end.y);
    context.lineTo(end.x - tx * headLength - ty * headWidth, end.y - ty * headLength + tx * headWidth);
    context.lineTo(end.x - tx * headLength + ty * headWidth, end.y - ty * headLength - tx * headWidth);
    context.closePath();
    context.fill();
  }
  context.restore();
}

function drawResourceMarker(context: CanvasRenderingContext2D, node: ResourceNode, dpr: number) {
  const center = worldToIso(node.position);
  const item = ITEM_BY_ID.get(node.itemId);
  drawWorldObjectBadge(context, center, item?.emoji ?? "📦", itemQualityPalette(node.itemId), dpr);
}

function drawBuildingMarker(context: CanvasRenderingContext2D, building: DeployedBuilding, dpr: number) {
  const center = worldToIso(building.position);
  const item = ITEM_BY_ID.get(building.itemId);
  drawWorldObjectBadge(context, center, item?.emoji ?? "🏗️", buildingQualityPalette(building.itemId), dpr);
}

function drawWorldObjectBadge(
  context: CanvasRenderingContext2D,
  tileCenter: Position,
  emojiText: string,
  quality: ItemQualityPalette,
  dpr: number,
  alpha = 1,
) {
  const centerX = tileCenter.x;
  const centerY = tileCenter.y - 23;
  const radius = 18;
  const emojiSize = 28;
  const emojiCanvasSize = emojiSize + 8;
  context.save();
  context.globalAlpha = alpha;

  const halo = context.createRadialGradient(centerX, centerY, radius * 0.35, centerX, centerY, radius + 10);
  halo.addColorStop(0, quality.haloInner);
  halo.addColorStop(1, quality.haloOuter);
  context.beginPath();
  context.arc(centerX, centerY, radius + 10, 0, Math.PI * 2);
  context.fillStyle = halo;
  context.fill();

  context.beginPath();
  context.ellipse(tileCenter.x, tileCenter.y + 4, 24, 9, 0, 0, Math.PI * 2);
  context.fillStyle = quality.haloInner;
  context.fill();

  const badge = context.createLinearGradient(centerX, centerY - radius, centerX, centerY + radius);
  badge.addColorStop(0, "rgba(255, 255, 252, .99)");
  badge.addColorStop(0.72, "rgba(255, 255, 252, .97)");
  badge.addColorStop(1, quality.topStops[1]);
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.fillStyle = badge;
  context.fill();
  context.strokeStyle = quality.accent;
  context.lineWidth = 1.8;
  context.stroke();

  context.beginPath();
  context.arc(centerX, centerY, radius - 3, Math.PI * 0.18, Math.PI * 0.82);
  context.strokeStyle = quality.topStops[0];
  context.lineWidth = 1.15;
  context.stroke();

  const emoji = getEmojiCanvas(emojiText, emojiSize, dpr);
  context.drawImage(
    emoji,
    centerX - emojiCanvasSize / 2,
    centerY - emojiCanvasSize / 2,
    emojiCanvasSize,
    emojiCanvasSize,
  );
  context.restore();
}

function drawLandmarkMarker(context: CanvasRenderingContext2D, landmark: DeployedLandmark, dpr: number) {
  const center = worldToIso(landmark.position);
  const definition = LANDMARK_BY_ID.get(landmark.landmarkId);
  const emoji = getEmojiCanvas(definition?.emoji ?? "🏛️", 38, dpr);
  context.save();
  context.beginPath();
  context.ellipse(center.x, center.y + 7, 30, 12, 0, 0, Math.PI * 2);
  context.fillStyle = "rgba(82, 126, 181, .14)";
  context.fill();
  context.strokeStyle = "rgba(76, 106, 147, .32)";
  context.lineWidth = 1.4;
  context.stroke();
  context.drawImage(emoji, center.x - 21, center.y - 45, 42, 42);
  context.restore();
}

function drawLandmarkAura(context: CanvasRenderingContext2D, position: Position, landmarkId: LandmarkId) {
  const radius = LANDMARK_BY_ID.get(landmarkId)?.radius ?? 2;
  context.save();
  for (let dx = -radius; dx <= radius; dx += 1) {
    const height = radius - Math.abs(dx);
    for (let dy = -height; dy <= height; dy += 1) {
      tracePolygon(context, tileDiamond({ x: position.x + dx, y: position.y + dy }));
      context.fillStyle = "rgba(101, 116, 205, .075)";
      context.fill();
      context.strokeStyle = "rgba(80, 96, 190, .23)";
      context.lineWidth = 0.9;
      context.stroke();
    }
  }
  context.restore();
}

function drawLandmarkPlacementPreview(
  context: CanvasRenderingContext2D,
  position: Position,
  landmarkId: LandmarkId,
  valid: boolean,
  dpr: number,
) {
  const center = worldToIso(position);
  tracePolygon(context, tileDiamond(position));
  context.fillStyle = valid ? "rgba(75, 109, 204, .24)" : "rgba(215, 92, 85, .24)";
  context.fill();
  context.strokeStyle = valid ? "rgba(57, 82, 170, .92)" : "rgba(188, 61, 54, .9)";
  context.lineWidth = 2.2;
  context.stroke();
  const definition = LANDMARK_BY_ID.get(landmarkId);
  const emoji = getEmojiCanvas(definition?.emoji ?? "🏛️", 40, dpr);
  context.save();
  context.globalAlpha = valid ? 0.92 : 0.5;
  context.drawImage(emoji, center.x - 22, center.y - 49, 44, 44);
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
  const item = ITEM_BY_ID.get(itemId);
  drawWorldObjectBadge(
    context,
    center,
    item?.emoji ?? "🏗️",
    buildingQualityPalette(itemId),
    dpr,
    valid ? 0.9 : 0.55,
  );
}

function drawBackdrop(context: CanvasRenderingContext2D, width: number, height: number) {
  context.clearRect(0, 0, width, height);
}

function workstationLift(cat: CatState): number {
  const activeItemId = cat.action && cat.action.type !== "wait" ? cat.action.itemId : null;
  return TILE_HEIGHT * workstationQualityVisual(activeItemId).liftTileFraction;
}

function workstationCenter(cat: CatState): Position {
  const center = worldToIso(cat.position);
  return { x: center.x, y: center.y - workstationLift(cat) };
}

function drawSplitOrderFloor(
  context: CanvasRenderingContext2D,
  position: Position,
  depth: number,
  zoom: number,
) {
  drawExtrudedDiamond(
    context,
    position,
    depth,
    workstationLensGradient(context, position, LENS_COLORS.red),
    LENS_COLORS.darkGreen.sideRight,
    LENS_COLORS.red.sideLeft,
    "#53645a",
    2.8 / zoom,
  );
  const [north, east, south] = tileDiamond(position);
  context.save();
  context.beginPath();
  context.moveTo(north.x, north.y);
  context.lineTo(east.x, east.y);
  context.lineTo(south.x, south.y);
  context.closePath();
  context.fillStyle = workstationLensGradient(context, position, LENS_COLORS.darkGreen);
  context.fill();
  context.strokeStyle = "rgba(255, 255, 255, .72)";
  context.lineWidth = 1.4 / zoom;
  context.beginPath();
  context.moveTo(north.x, north.y);
  context.lineTo(south.x, south.y);
  context.stroke();
  strokeDiamond(context, position, "#53645a", 2.8 / zoom);
  context.restore();
}

function drawOrderFloorItemSet(
  context: CanvasRenderingContext2D,
  itemIds: readonly string[],
  center: Position,
  dpr: number,
) {
  const visibleItemIds = itemIds.slice(0, 4);
  const offsets = visibleItemIds.length === 1
    ? [{ x: 0, y: 0 }]
    : visibleItemIds.length === 2
      ? [{ x: -9, y: 0 }, { x: 9, y: 0 }]
      : visibleItemIds.length === 3
        ? [{ x: -10, y: 4 }, { x: 10, y: 4 }, { x: 0, y: -7 }]
        : [{ x: -9, y: -6 }, { x: 9, y: -6 }, { x: -9, y: 7 }, { x: 9, y: 7 }];
  visibleItemIds.forEach((itemId, index) => {
    const item = ITEM_BY_ID.get(itemId);
    if (!item) return;
    const offset = offsets[index];
    const x = center.x + offset.x;
    const y = center.y + offset.y;
    context.save();
    context.globalAlpha = 0.88;
    context.fillStyle = "rgba(255, 255, 255, .86)";
    context.beginPath();
    context.arc(x, y, 8.2, 0, Math.PI * 2);
    context.fill();
    context.restore();
    const emoji = getEmojiCanvas(item.emoji, 16, dpr);
    context.drawImage(emoji, x - 8, y - 8, 16, 16);
  });
}

function drawDemandFloorItemSet(
  context: CanvasRenderingContext2D,
  orderFloor: MapLensOrderFloor,
  center: Position,
  dpr: number,
  maxVisible: number,
) {
  const visibleItemIds = orderFloor.demandItemIds.slice(0, maxVisible);
  const spacing = maxVisible <= 2 ? 17 : 18;
  const firstX = -((visibleItemIds.length - 1) * spacing) / 2;
  const targetsByItem = new Map(orderFloor.demandTargets.map((entry) => [entry.itemId, entry.targetItemIds]));
  visibleItemIds.forEach((itemId, index) => {
    const demandItem = ITEM_BY_ID.get(itemId);
    if (!demandItem) return;
    const x = center.x + firstX + index * spacing;
    const demandY = center.y - 7;
    context.save();
    context.fillStyle = "rgba(255, 255, 255, .88)";
    context.beginPath();
    context.arc(x, demandY, 7.4, 0, Math.PI * 2);
    context.fill();
    context.restore();
    const demandEmoji = getEmojiCanvas(demandItem.emoji, 14, dpr);
    context.drawImage(demandEmoji, x - 7, demandY - 7, 14, 14);

    const targetItemIds = targetsByItem.get(itemId) ?? [];
    if (targetItemIds.length === 0) return;
    const triangleY = center.y + 1;
    context.save();
    context.fillStyle = "rgba(82, 91, 86, .84)";
    context.beginPath();
    context.moveTo(x - 3, triangleY);
    context.lineTo(x + 3, triangleY);
    context.lineTo(x, triangleY + 4.5);
    context.closePath();
    context.fill();
    context.restore();

    const visibleTargets = targetItemIds.slice(0, 2);
    const targetSpacing = 9;
    const targetStartX = x - ((visibleTargets.length - 1) * targetSpacing) / 2;
    visibleTargets.forEach((targetItemId, targetIndex) => {
      const targetItem = ITEM_BY_ID.get(targetItemId);
      if (!targetItem) return;
      const targetX = targetStartX + targetIndex * targetSpacing;
      const targetY = center.y + 11;
      context.save();
      context.fillStyle = "rgba(224, 227, 225, .94)";
      context.beginPath();
      context.arc(targetX, targetY, 5.7, 0, Math.PI * 2);
      context.fill();
      context.restore();
      const targetEmoji = getEmojiCanvas(targetItem.emoji, 11, dpr);
      context.drawImage(targetEmoji, targetX - 5.5, targetY - 5.5, 11, 11);
    });
  });
}

function drawOrderFloorItems(
  context: CanvasRenderingContext2D,
  position: Position,
  orderFloor: MapLensOrderFloor,
  dpr: number,
) {
  const center = worldToIso(position);
  const hasDemand = orderFloor.demandItemIds.length > 0;
  const hasSupply = orderFloor.supplyItemIds.length > 0;
  if (hasDemand && hasSupply) {
    drawDemandFloorItemSet(context, orderFloor, { x: center.x - 32, y: center.y }, dpr, 2);
    drawOrderFloorItemSet(context, orderFloor.supplyItemIds, { x: center.x + 32, y: center.y + 2 }, dpr);
    return;
  }
  if (hasDemand) {
    drawDemandFloorItemSet(context, orderFloor, { x: center.x, y: center.y }, dpr, 3);
  } else if (hasSupply) {
    drawOrderFloorItemSet(context, orderFloor.supplyItemIds, { x: center.x, y: center.y + 3 }, dpr);
  }
}

function drawCatInventoryMarkers(
  context: CanvasRenderingContext2D,
  cat: CatState,
  dpr: number,
) {
  const entries = Object.entries(cat.inventory)
    .filter(([itemId, quantity]) => quantity > 0 && ITEM_BY_ID.has(itemId))
    .sort(([leftId], [rightId]) => itemQualityLevel(rightId) - itemQualityLevel(leftId)
      || leftId.localeCompare(rightId));
  if (entries.length === 0) return;

  const shown = entries.slice(0, 3);
  const overflowKinds = entries.length - shown.length;
  const badgeWidth = 29;
  const overflowWidth = overflowKinds > 0 ? 22 : 0;
  const gap = 3;
  const totalWidth = shown.length * badgeWidth + Math.max(0, shown.length - 1) * gap
    + (overflowKinds > 0 ? gap + overflowWidth : 0);
  const center = worldToIso(cat.position);
  const y = center.y + 10;
  let x = center.x - totalWidth / 2;

  context.save();
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.font = "800 7px 'Microsoft YaHei UI', system-ui";
  for (const [itemId, quantity] of shown) {
    const item = ITEM_BY_ID.get(itemId)!;
    context.beginPath();
    context.roundRect(x, y - 7, badgeWidth, 14, 5);
    context.fillStyle = "rgba(255, 255, 255, .9)";
    context.fill();
    context.strokeStyle = "rgba(112, 121, 115, .34)";
    context.lineWidth = 0.8;
    context.stroke();
    const emoji = getEmojiCanvas(item.emoji, 10, dpr);
    context.drawImage(emoji, x + 2, y - 5, 10, 10);
    context.fillStyle = "#58625b";
    context.fillText(`×${quantity}`, x + 13, y + 0.5);
    x += badgeWidth + gap;
  }
  if (overflowKinds > 0) {
    context.beginPath();
    context.roundRect(x, y - 7, overflowWidth, 14, 5);
    context.fillStyle = "rgba(245, 247, 246, .94)";
    context.fill();
    context.strokeStyle = "rgba(112, 121, 115, .3)";
    context.stroke();
    context.fillStyle = "#747d77";
    context.textAlign = "center";
    context.fillText(`+${overflowKinds}`, x + overflowWidth / 2, y + 0.5);
  }
  context.restore();
}

function drawCatStationBase(
  context: CanvasRenderingContext2D,
  cat: CatState,
  simTime: number,
  zoom: number,
  reducedMotion: boolean,
  dpr: number,
  lensColor?: LensColor,
  orderFloor?: MapLensOrderFloor,
  showInventory = false,
) {
  const lensActive = Boolean(lensColor || orderFloor);
  const activeItemId = !lensActive && cat.action && cat.action.type !== "wait" ? cat.action.itemId : null;
  const quality = activeItemId ? itemQualityPalette(activeItemId) : null;
  const visual = workstationQualityVisual(activeItemId);
  const hasQualityBorder = visual.level >= 1;
  const hasHighlightedBorder = visual.level >= 2;
  const lift = TILE_HEIGHT * visual.liftTileFraction;
  const depth = WORKSTATION_DEPTH + lift;
  const hasDemand = Boolean(orderFloor?.demandItemIds.length);
  const hasSupply = Boolean(orderFloor?.supplyItemIds.length);
  const splitOrderFloor = hasDemand && hasSupply;
  const floorLensColor = orderFloor
    ? hasDemand ? LENS_COLORS.red : hasSupply ? LENS_COLORS.darkGreen : LENS_COLORS.blue
    : lensColor;

  context.save();
  context.translate(0, -lift);
  const top = floorLensColor
    ? workstationLensGradient(context, cat.position, floorLensColor)
    : quality ? workstationTopGradient(context, cat.position, quality, simTime) : "#e5e7eb";
  if (splitOrderFloor) {
    drawSplitOrderFloor(context, cat.position, depth, zoom);
  } else {
    drawExtrudedDiamond(
      context,
      cat.position,
      depth,
      top,
      floorLensColor?.sideRight ?? quality?.sideRight ?? "#c6cbd1",
      floorLensColor?.sideLeft ?? quality?.sideLeft ?? "#b8bec5",
      floorLensColor?.border ?? (hasQualityBorder ? quality!.accent : "#aeb4bb"),
      floorLensColor ? 2.6 / zoom : visual.borderWidth / zoom,
    );
  }
  if (orderFloor) drawOrderFloorItems(context, cat.position, orderFloor, dpr);
  if (showInventory) drawCatInventoryMarkers(context, cat, dpr);

  if (!floorLensColor && quality && hasHighlightedBorder) {
    context.save();
    context.globalAlpha = 0.44;
    context.shadowColor = quality.accent;
    context.shadowBlur = visual.glowBlur;
    strokeDiamond(context, cat.position, quality.accent, visual.glowWidth / zoom);
    context.globalAlpha = 0.98;
    context.shadowBlur = 5;
    strokeDiamond(context, cat.position, quality.accent, visual.borderWidth / zoom);
    context.restore();
  }
  if (!floorLensColor && quality && visual.fullHighlight) {
    context.save();
    context.globalAlpha = 0.7;
    context.shadowColor = quality.accent;
    context.shadowBlur = 18;
    drawExtrudedDiamond(
      context,
      cat.position,
      depth,
      quality.haloInner,
      quality.haloInner,
      quality.haloInner,
      quality.accent,
      2.8 / zoom,
    );
    context.restore();
  }
  context.restore();

  const center = lensActive ? worldToIso(cat.position) : workstationCenter(cat);

  if (!lensActive && cat.action?.type === "pass" && cat.action.direction) {
    const pulse = reducedMotion ? 0.5 : (Math.sin(simTime / 260) + 1) / 2;
    drawDirectionArrow(context, center, cat.action.direction, pulse);
  }

}

function drawCatActor(
  context: CanvasRenderingContext2D,
  cat: CatState,
  simTime: number,
  sprite: HTMLImageElement,
  dpr: number,
  reducedMotion: boolean,
  lensActive: boolean,
) {
  const center = lensActive ? worldToIso(cat.position) : workstationCenter(cat);
  const visibleAction = cat.action?.type === "wait" ? null : cat.action;
  const showActionItem = Boolean(visibleAction && !lensActive);
  const frame = animationFrame(simTime, Boolean(visibleAction), reducedMotion);
  const motion = catMotion(cat, center, simTime, reducedMotion);
  const itemPosition = visibleAction ? actionItemPosition(visibleAction, center, simTime, reducedMotion) : null;
  if (showActionItem && visibleAction && itemPosition && visibleAction.type !== "pass" && motion.inFront) {
    drawAction(context, visibleAction, itemPosition, simTime, dpr, reducedMotion);
  }
  drawCatSprite(context, sprite, frame, motion.x, motion.y, motion.mirror);
  if (showActionItem && visibleAction && itemPosition && (visibleAction.type === "pass" || !motion.inFront)) {
    drawAction(context, visibleAction, itemPosition, simTime, dpr, reducedMotion);
  }
  if (!visibleAction && !lensActive) drawIdleIndicator(context, center, cat.lastDecision);
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
  const quality = itemQualityPalette(action.itemId);
  const color = quality.accent;

  context.save();
  context.beginPath();
  context.arc(x, y, 19 + pulse * 4, 0, Math.PI * 2);
  if (quality.id === "prism") {
    const prism = context.createConicGradient(reducedMotion ? 0 : simTime / 1_200, x, y);
    prism.addColorStop(0, "rgba(239, 186, 216, .38)");
    prism.addColorStop(.2, "rgba(199, 213, 247, .38)");
    prism.addColorStop(.4, "rgba(181, 229, 220, .38)");
    prism.addColorStop(.6, "rgba(239, 226, 169, .38)");
    prism.addColorStop(.8, "rgba(220, 196, 240, .38)");
    prism.addColorStop(1, "rgba(239, 186, 216, .38)");
    context.fillStyle = prism;
  } else {
    const halo = context.createRadialGradient(x, y, 4, x, y, 23);
    halo.addColorStop(0, quality.haloInner);
    halo.addColorStop(1, quality.haloOuter);
    context.fillStyle = halo;
  }
  context.fill();

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
  catById: ReadonlyMap<string, CatState>,
  events: FloatingEvent[],
  simTime: number,
  reducedMotion: boolean,
) {
  const perCat = new Map<string, FloatingEvent[]>();
  const valueEvents = events.filter((event) => event.kind !== "speech");
  for (const event of valueEvents) {
    const list = perCat.get(event.catId) ?? [];
    list.push(event);
    perCat.set(event.catId, list);
  }
  for (const list of perCat.values()) list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  for (const event of valueEvents) {
    const cat = catById.get(event.catId);
    if (!cat) continue;
    const age = Math.max(0, Math.min(1, (simTime - event.createdAt) / event.duration));
    const fade = age < 0.58 ? 1 : Math.max(0, 1 - (age - 0.58) / 0.42);
    const stack = perCat.get(event.catId) ?? [];
    const stackIndex = stack.findIndex((entry) => entry.id === event.id);
    const center = workstationCenter(cat);
    const rise = reducedMotion ? 8 : age * 24;
    const speaking = events.some((entry) => entry.catId === event.catId && speechEventIsVisible(entry, simTime));
    const x = center.x + (speaking ? 48 : 0);
    const y = center.y - (speaking ? 48 : 82) - stackIndex * 17 - rise;
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

interface SpeechBubbleLayout {
  event: FloatingEvent;
  anchor: Position;
  tailSide: "top" | "bottom";
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
}

function drawSpeechBubbles(
  context: CanvasRenderingContext2D,
  catById: ReadonlyMap<string, CatState>,
  events: FloatingEvent[],
  simTime: number,
  reducedMotion: boolean,
  camera: Camera,
  width: number,
  height: number,
  requestedScale: number,
  controlObstacles: readonly SpeechLayoutRectangle[],
) {
  const scale = Math.max(0.75, Math.min(1.6, requestedScale));
  const fontSize = 11 * scale;
  const lineHeight = 16 * scale;
  const horizontalPadding = 10 * scale;
  const verticalPadding = 8 * scale;
  const speechEvents = events.filter((event) => speechEventIsVisible(event, simTime))
    .sort((left, right) => {
      const leftCat = catById.get(left.catId);
      const rightCat = catById.get(right.catId);
      if (!leftCat || !rightCat) return left.id.localeCompare(right.id);
      return sceneDepthCompare(
        { position: leftCat.position, layer: 1, order: leftCat.createdIndex },
        { position: rightCat.position, layer: 1, order: rightCat.createdIndex },
      );
    });
  const activeQualityLevels = [...new Set([...catById.values()]
    .filter((cat) => cat.action?.type === "craft" || cat.action?.type === "pass")
    .map((cat) => itemQualityLevel(cat.action?.itemId)))]
    .sort((left, right) => right - left)
    .slice(0, 2);
  const protectedAreas: SpeechProtectedRectangle[] = [...catById.values()]
    .filter((cat) => cat.action && activeQualityLevels.includes(itemQualityLevel(cat.action.itemId)))
    .map((cat) => {
      const center = isoToScreen(workstationCenter(cat), camera, { width, height });
      const qualityRank = activeQualityLevels.indexOf(itemQualityLevel(cat.action?.itemId));
      const horizontalPadding = 8 + TILE_WIDTH * camera.zoom * .55;
      const topPadding = 20 + TILE_HEIGHT * camera.zoom * .82;
      const bottomPadding = 8 + (TILE_HEIGHT * .55 + WORKSTATION_DEPTH) * camera.zoom;
      return {
        x: center.x - horizontalPadding,
        y: center.y - topPadding,
        width: horizontalPadding * 2,
        height: topPadding + bottomPadding,
        weight: qualityRank === 0 ? 3 : 2,
      };
    });
  const layouts: SpeechBubbleLayout[] = [];
  context.save();
  context.font = `700 ${fontSize}px 'Microsoft YaHei UI', system-ui`;
  for (const event of speechEvents) {
    const cat = catById.get(event.catId);
    if (!cat) continue;
    const anchor = isoToScreen(workstationCenter(cat), camera, { width, height });
    if (anchor.x < -180 || anchor.x > width + 180 || anchor.y < -120 || anchor.y > height + 120) continue;
    const maxLineWidth = Math.min(202 * scale, Math.max(48, width - 32 * scale));
    const lines = wrapSpeechText(event.text, maxLineWidth, (value) => context.measureText(value).width);
    const textWidth = Math.max(...lines.map((line) => context.measureText(line).width));
    const bubbleWidth = Math.max(96 * scale, Math.min(222 * scale, Math.ceil(textWidth + horizontalPadding * 2)));
    const bubbleHeight = lines.length * lineHeight + verticalPadding * 2;
    const edge = 8 * scale;
    const { x, y, tailSide } = chooseSpeechBubblePlacement({
      anchor,
      bubbleWidth,
      bubbleHeight,
      viewportWidth: width,
      viewportHeight: height,
      edge,
      anchorGap: Math.max(35 * scale, 26 * camera.zoom),
      seed: hashString(event.id),
      occupied: [...controlObstacles, ...layouts],
      protectedAreas,
    });
    layouts.push({ event, anchor, tailSide, x, y, width: bubbleWidth, height: bubbleHeight, lines });
  }

  for (const layout of layouts) {
    const elapsed = Math.max(0, simTime - layout.event.createdAt);
    const remaining = Math.max(0, layout.event.duration - elapsed);
    const enter = reducedMotion ? 1 : Math.min(1, elapsed / 140);
    const alpha = Math.min(enter, remaining / 420);
    const tailX = Math.max(layout.x + 18 * scale, Math.min(layout.x + layout.width - 18 * scale, layout.anchor.x));
    const bubbleTop = layout.y;
    const bubbleBottom = layout.y + layout.height;
    const tailTipY = layout.tailSide === "bottom"
      ? Math.max(bubbleBottom + 5 * scale, layout.anchor.y - Math.max(13 * scale, 10 * camera.zoom))
      : Math.min(bubbleTop - 5 * scale, layout.anchor.y + Math.max(13 * scale, 10 * camera.zoom));
    context.save();
    context.globalAlpha = Math.max(0, Math.min(1, alpha));
    context.shadowColor = "rgba(31, 43, 36, .18)";
    context.shadowBlur = 9 * scale;
    context.shadowOffsetY = 3 * scale;
    context.beginPath();
    context.roundRect(layout.x, layout.y, layout.width, layout.height, 10 * scale);
    if (layout.tailSide === "bottom") {
      context.moveTo(tailX - 7 * scale, bubbleBottom - 1);
      context.lineTo(tailX, tailTipY);
      context.lineTo(tailX + 7 * scale, bubbleBottom - 1);
    } else {
      context.moveTo(tailX - 7 * scale, bubbleTop + 1);
      context.lineTo(tailX, tailTipY);
      context.lineTo(tailX + 7 * scale, bubbleTop + 1);
    }
    context.closePath();
    context.fillStyle = "rgba(255, 255, 255, .98)";
    context.fill();
    context.shadowColor = "transparent";
    context.strokeStyle = "rgba(91, 105, 96, .55)";
    context.lineWidth = 1;
    context.stroke();
    context.fillStyle = "#2f3732";
    context.font = `700 ${fontSize}px 'Microsoft YaHei UI', system-ui`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    layout.lines.forEach((line, index) => context.fillText(
      line,
      layout.x + layout.width / 2,
      layout.y + verticalPadding + index * lineHeight + lineHeight / 2,
    ));
    context.restore();
  }
  context.restore();
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

function workstationTopGradient(
  context: CanvasRenderingContext2D,
  position: Position,
  quality: ItemQualityPalette,
  simTime: number,
): CanvasGradient {
  const center = worldToIso(position);
  const prismAngle = quality.id === "prism" ? simTime / 4_000 * Math.PI * 2 : Math.atan2(TILE_HEIGHT, TILE_WIDTH);
  const gradientRadius = TILE_WIDTH * .5;
  const gradientX = Math.cos(prismAngle) * gradientRadius;
  const gradientY = Math.sin(prismAngle) * gradientRadius;
  const gradient = context.createLinearGradient(
    center.x - gradientX,
    center.y - gradientY,
    center.x + gradientX,
    center.y + gradientY,
  );
  if (quality.id === "prism") {
    const stops = [
      "#f6e5ee", "#e7e1f7", "#dcecf8", "#dcf1ea", "#f5edcf", "#f4dfdd", "#f6e5ee",
    ];
    for (let index = 0; index < stops.length; index += 1) {
      gradient.addColorStop(index / (stops.length - 1), stops[index]);
    }
  } else {
    gradient.addColorStop(0, quality.topStops[0]);
    gradient.addColorStop(.52, quality.topStops[1]);
    gradient.addColorStop(1, quality.topStops[2]);
  }
  return gradient;
}

function workstationLensGradient(
  context: CanvasRenderingContext2D,
  position: Position,
  lensColor: LensColor,
): CanvasGradient {
  const center = worldToIso(position);
  const gradient = context.createLinearGradient(
    center.x - TILE_WIDTH * 0.42,
    center.y - TILE_HEIGHT * 0.3,
    center.x + TILE_WIDTH * 0.42,
    center.y + TILE_HEIGHT * 0.3,
  );
  gradient.addColorStop(0, "#f5f4e9");
  gradient.addColorStop(0.18, lensColor.top);
  gradient.addColorStop(1, lensColor.sideRight);
  return gradient;
}

function drawExtrudedDiamond(
  context: CanvasRenderingContext2D,
  position: Position,
  depth: number,
  top: string | CanvasGradient,
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
  placingLandmarkId: LandmarkId | null,
  landmarkPlacementError: string | null,
) {
  if (hoveredTile) {
    const parcel = parcelForPosition(hoveredTile);
    const unlocked = unlockedParcels.some((entry) => parcelKey(entry) === parcelKey(parcel));
    const label = placingLandmarkId
      ? `${hoveredTile.x}, ${hoveredTile.y} · ${landmarkPlacementError ?? "可以建造"}`
      : placingBuildingItemId
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
  if (placingLandmarkId) {
    roundedPath(context, width / 2 - 92, 18, 184, 32, 9);
    context.fillStyle = "rgba(244, 246, 255, .97)";
    context.fill();
    context.strokeStyle = "rgba(71, 91, 177, .58)";
    context.stroke();
    context.fillStyle = "#3e519b";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = "800 12px 'Microsoft YaHei UI', system-ui";
    const definition = LANDMARK_BY_ID.get(placingLandmarkId);
    context.fillText(`建造 ${definition?.emoji ?? ""} ${definition?.name ?? placingLandmarkId}`, width / 2, 34);
  } else if (placingBuildingItemId) {
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
  return emojiCache.get(emoji, size, dpr, (ratio) => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil((size + 8) * ratio);
    canvas.height = Math.ceil((size + 8) * ratio);
    const context = canvas.getContext("2d")!;
    context.scale(ratio, ratio);
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `${size}px ${EMOJI_FONT}`;
    context.fillText(emoji, (size + 8) / 2, (size + 8) / 2 + 1);
    return canvas;
  });
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
