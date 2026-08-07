import { useEffect, useRef, useState } from "react";
import catSpriteUrl from "../assets/cat-workshop-sprite.png?url";
import { ITEM_BY_ID } from "../game/catalog";
import type { GameController } from "../game/controller";
import {
  catLiquidationPreview,
  formatMoney,
  PLAYER_RESOURCE_CREATION_COST,
} from "../game/engine";
import { landmarkDisplayName, LANDMARK_BY_ID, NAMED_LANDMARK_EMOJI, NAMED_LANDMARK_WOOD_COST } from "../game/landmarks";
import { speechEventIsVisible } from "../game/speech";
import type { LandmarkId, Position } from "../game/types";
import { isPositionUnlocked, parcelForPosition } from "../game/world";
import {
  MAP_SCALE_MAX,
  MAP_SCALE_MIN,
} from "./uiPreferences";
import type { Camera } from "./isometric";
import type { MapLensId, WealthLensMode } from "./mapLenses";
import {
  collectSpeechControlObstacles,
  createRenderScratch,
  drawWorld,
  type GroundLayerCache,
  type RenderScratch,
} from "./GameCanvasRenderer";
import { contextTargetAtPoint, pointToWorldTile, type CanvasContextTarget } from "./gameCanvasGeometry";
import {
  canCreateResourceAt,
  canOfferAddCatAt,
  ownedBuildingOptionsAt,
  resourceCreationOptionsAt,
} from "./gameCanvasContextMenu";
import {
  beginCanvasDrag,
  panCameraForDrag,
  updateCanvasDrag,
  zoomCameraAtPoint,
  type CanvasDragState,
} from "./gameCanvasInput";
import { EmojiIcon } from "./EmojiIcon";

const DEFAULT_CAMERA: Camera = { x: 32, y: 28, zoom: 1.08 };
const CANVAS_FRAME_INTERVAL_MS = 1000 / 60;

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
  wealthLensMode: WealthLensMode;
  wealthLensWindowMs: number;
}

interface TileActionMenu {
  tile: Position;
  target: CanvasContextTarget;
  x: number;
  y: number;
  verticalAlign: "above" | "below";
}

interface LandmarkNameEditor {
  mode: "create" | "rename";
  value: string;
  error: string | null;
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
  wealthLensMode,
  wealthLensWindowMs,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camera = useRef<Camera>({ ...DEFAULT_CAMERA, zoom: DEFAULT_CAMERA.zoom * mapScale });
  const hoveredTile = useRef<Position | null>(null);
  const drag = useRef<CanvasDragState | null>(null);
  const groundCache = useRef<GroundLayerCache>({});
  const renderScratch = useRef<RenderScratch>(createRenderScratch());
  const renderOptions = useRef({ selectedCatId, expansionMode, placingBuildingItemId, placingLandmarkId, speechScale, mapLensId, mapLensItemId, wealthLensMode, wealthLensWindowMs });
  renderOptions.current = { selectedCatId, expansionMode, placingBuildingItemId, placingLandmarkId, speechScale, mapLensId, mapLensItemId, wealthLensMode, wealthLensWindowMs };
  const [tileActionMenu, setTileActionMenu] = useState<TileActionMenu | null>(null);
  const [landmarkNameEditor, setLandmarkNameEditor] = useState<LandmarkNameEditor | null>(null);
  const [pendingDestructiveAction, setPendingDestructiveAction] = useState<string | null>(null);

  const closeTileActionMenu = () => {
    setTileActionMenu(null);
    setLandmarkNameEditor(null);
    setPendingDestructiveAction(null);
  };

  useEffect(() => {
    camera.current.zoom = DEFAULT_CAMERA.zoom * mapScale;
  }, [mapScale]);

  useEffect(() => {
    const dismissTileActionMenu = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-testid='tile-action-menu']")) return;
      closeTileActionMenu();
    };
    window.addEventListener("pointerdown", dismissTileActionMenu, true);
    return () => window.removeEventListener("pointerdown", dismissTileActionMenu, true);
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
        options.wealthLensMode,
        options.wealthLensWindowMs,
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
    return pointToWorldTile(
      { x: clientX - rect.left, y: clientY - rect.top },
      camera.current,
      { width: rect.width, height: rect.height },
      controller.state.cats,
    );
  };

  const contextTargetAt = (clientX: number, clientY: number): Pick<TileActionMenu, "tile" | "target"> => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const viewport = { width: rect.width, height: rect.height };
    const local = { x: clientX - rect.left, y: clientY - rect.top };
    return contextTargetAtPoint(local, camera.current, viewport, controller.state);
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

  const placementMode = { placingBuildingItemId, placingLandmarkId, expansionMode };
  const contextBuildingOptions = tileActionMenu?.target.kind === "empty" ? ownedBuildingOptionsAt(controller.state, tileActionMenu.tile) : [];
  const contextResourceOptions = tileActionMenu?.target.kind === "empty" ? resourceCreationOptionsAt(controller.state, tileActionMenu.tile) : [];
  const contextTarget = tileActionMenu?.target;
  const contextCatId = contextTarget?.kind === "cat" ? contextTarget.id : null;
  const contextResourceId = contextTarget?.kind === "resource" ? contextTarget.id : null;
  const contextBuildingId = contextTarget?.kind === "building" ? contextTarget.id : null;
  const contextLandmarkId = contextTarget?.kind === "landmark" ? contextTarget.id : null;
  const contextCat = contextCatId ? controller.state.cats.find((cat) => cat.id === contextCatId) : undefined;
  const contextResource = contextResourceId ? controller.state.resourceNodes.find((node) => node.id === contextResourceId) : undefined;
  const contextBuilding = contextBuildingId ? controller.state.buildings.find((building) => building.id === contextBuildingId) : undefined;
  const contextLandmark = contextLandmarkId ? controller.state.landmarks.find((landmark) => landmark.id === contextLandmarkId) : undefined;
  const contextCatLiquidation = contextCat ? catLiquidationPreview(controller.state, contextCat) : null;

  return (
    <>
    <canvas
      id="game-canvas"
      ref={canvasRef}
      data-testid="game-canvas"
      data-map-scale={mapScale}
      tabIndex={0}
      aria-label={window.catWorkshopDesktop ? "等距猫咪工坊。普通模式左键拖动桌宠、滚轮缩放整体；地图模式改为平移和缩放地图。右键空地或对象打开世界管理菜单。" : "等距猫咪工坊。左键拖拽平移，滚轮缩放地图，右键空地或对象打开世界管理菜单。"}
      onContextMenu={(event) => {
        event.preventDefault();
        const { tile, target } = contextTargetAt(event.clientX, event.clientY);
        hoveredTile.current = tile;
        if (placingBuildingItemId || placingLandmarkId || expansionMode) {
          closeTileActionMenu();
          return;
        }
        const canAddCat = target.kind === "empty" && canOfferAddCatAt(controller.state, tile, placementMode);
        const buildingOptions = target.kind === "empty" ? ownedBuildingOptionsAt(controller.state, tile) : [];
        const canCreateLandmark = target.kind === "empty"
          && (controller.state.playerBuildingInventory.wood ?? 0) >= NAMED_LANDMARK_WOOD_COST;
        const canCreateResource = target.kind === "empty" && canCreateResourceAt(controller.state, tile);
        if (target.kind === "empty" && !canAddCat && !canCreateLandmark && !canCreateResource
          && !buildingOptions.some((option) => !option.failure)) {
          closeTileActionMenu();
          return;
        }
        const rect = canvasRef.current!.getBoundingClientRect();
        const localY = event.clientY - rect.top;
        const scaleHost = canvasRef.current!.closest(".pet-window") ?? document.documentElement;
        const controlScale = Number.parseFloat(getComputedStyle(scaleHost).getPropertyValue("--pet-control-scale")) || 1;
        const horizontalInset = Math.min(rect.width / 2, Math.max(112, 126 * controlScale));
        setLandmarkNameEditor(null);
        setPendingDestructiveAction(null);
        setTileActionMenu({
          tile,
          target,
          x: Math.max(horizontalInset, Math.min(rect.width - horizontalInset, event.clientX - rect.left)),
          y: Math.max(12, Math.min(rect.height - 12, localY)),
          verticalAlign: localY > rect.height * 0.55 ? "above" : "below",
        });
      }}
      onPointerDown={(event) => {
        canvasRef.current?.focus();
        if (event.button !== 0) return;
        canvasRef.current?.setPointerCapture(event.pointerId);
        const nativeWindow = Boolean(window.catWorkshopDesktop) && !placingBuildingItemId && !placingLandmarkId && !expansionMode;
        drag.current = beginCanvasDrag({ x: event.clientX, y: event.clientY }, camera.current, nativeWindow);
        if (nativeWindow) window.catWorkshopDesktop?.beginWindowDrag(event.screenX, event.screenY);
      }}
      onPointerMove={(event) => {
        hoveredTile.current = pointToTile(event.clientX, event.clientY);
        if (!drag.current) return;
        const { dx, dy } = updateCanvasDrag(drag.current, { x: event.clientX, y: event.clientY });
        if (drag.current.nativeWindow) {
          window.catWorkshopDesktop?.moveWindowDrag(event.screenX, event.screenY);
          return;
        }
        panCameraForDrag(camera.current, drag.current, dx, dy);
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
        const nextScale = zoomCameraAtPoint(
          camera.current,
          pointer,
          { width: rect.width, height: rect.height },
          event.deltaY,
          DEFAULT_CAMERA.zoom,
          MAP_SCALE_MIN,
          MAP_SCALE_MAX,
        );
        hoveredTile.current = pointToTile(event.clientX, event.clientY);
        onMapScaleChange(nextScale);
      }}
    />
    {tileActionMenu && <div
      className={`pet-tile-action-menu ${tileActionMenu.verticalAlign}`}
      data-testid="tile-action-menu"
      role="menu"
      aria-label={`地块 ${tileActionMenu.tile.x}, ${tileActionMenu.tile.y} 操作`}
      style={{ left: tileActionMenu.x, top: tileActionMenu.y }}
    >
      <small>{tileActionMenu.target.kind === "empty" ? "空地" : "对象"} · ({tileActionMenu.tile.x}, {tileActionMenu.tile.y})</small>
      {tileActionMenu.target.kind === "empty" && canOfferAddCatAt(controller.state, tileActionMenu.tile, placementMode) && <button
        className="add-cat-action"
        data-testid="add-cat-menu"
        role="menuitem"
        onClick={() => {
          addCatAt(tileActionMenu.tile);
          closeTileActionMenu();
        }}
      >＋ 新增猫咪</button>}
      {contextBuildingOptions.map(({ itemId, quantity, failure }) => {
        const item = ITEM_BY_ID.get(itemId);
        return <button
          key={itemId}
          className="place-building-action"
          data-testid={`context-place-building-${itemId}`}
          data-placement-valid={failure ? "false" : "true"}
          role="menuitem"
          disabled={Boolean(failure)}
          title={failure ?? `在此搭建${item?.name ?? itemId}`}
          onClick={() => {
            const result = controller.placeBuilding(itemId, tileActionMenu.tile);
            onBuildingPlacementResult({ itemId, position: { ...tileActionMenu.tile }, ...result });
            if (result.ok) closeTileActionMenu();
          }}
        ><span><EmojiIcon emoji={item?.emoji ?? "🏗️"} label={item?.name} /></span><b>搭建{item?.name ?? itemId}</b><i>×{quantity}</i></button>;
      })}
      {tileActionMenu.target.kind === "empty" && (controller.state.playerBuildingInventory.wood ?? 0) >= NAMED_LANDMARK_WOOD_COST && (
        landmarkNameEditor?.mode === "create" ? <form className="tile-landmark-name-form" data-testid="create-landmark-form" onSubmit={(event) => {
          event.preventDefault();
          const result = controller.placeNamedLandmark(landmarkNameEditor.value, tileActionMenu.tile);
          if (result.ok) closeTileActionMenu();
          else setLandmarkNameEditor((current) => current ? { ...current, error: result.error ?? "创建失败" } : current);
        }}>
          <label htmlFor="new-landmark-name">给地标起一个唯一名称</label>
          <input
            id="new-landmark-name"
            data-testid="new-landmark-name"
            autoFocus
            maxLength={20}
            value={landmarkNameEditor.value}
            onChange={(event) => setLandmarkNameEditor({ ...landmarkNameEditor, value: event.target.value, error: null })}
            placeholder="例如：东区"
          />
          {landmarkNameEditor.error && <span className="tile-action-error" role="alert">{landmarkNameEditor.error}</span>}
          <div><button type="submit">消耗木材×1 创建</button><button type="button" onClick={() => setLandmarkNameEditor(null)}>取消</button></div>
        </form> : <button
          className="create-landmark-action"
          data-testid="create-landmark-menu"
          role="menuitem"
          onClick={() => setLandmarkNameEditor({ mode: "create", value: "", error: null })}
        ><span><EmojiIcon emoji={NAMED_LANDMARK_EMOJI} /></span><b>创建地标</b><i>木材 −1</i></button>
      )}
      {contextResourceOptions.map(({ itemId, quantity, failure }) => {
        const item = ITEM_BY_ID.get(itemId);
        return <button
          key={`resource-${itemId}`}
          className="create-resource-action"
          data-testid={`create-resource-${itemId}`}
          data-placement-valid={failure ? "false" : "true"}
          role="menuitem"
          disabled={Boolean(failure)}
          title={failure ?? `消耗 ${PLAYER_RESOURCE_CREATION_COST} 份${item?.name ?? itemId}创建资源中心`}
          onClick={() => {
            const result = controller.createResource(itemId, tileActionMenu.tile);
            if (result.ok) closeTileActionMenu();
          }}
        ><span><EmojiIcon emoji={item?.emoji ?? "❔"} label={item?.name} /></span><b>创建{item?.name ?? itemId}资源</b><i>−{PLAYER_RESOURCE_CREATION_COST} / {quantity}</i></button>;
      })}
      {contextCat && contextCatLiquidation && <>
        <div className="tile-object-title"><span><EmojiIcon emoji="🐈" /></span><strong>猫咪 #{contextCat.createdIndex + 1}</strong></div>
        <div className="tile-liquidation-preview" data-testid="context-cat-liquidation">
          <span>可清算资产 <b>{formatMoney(contextCatLiquidation.assetsCents)}</b></span>
          <span>偿还债务 <b>{formatMoney(contextCatLiquidation.debtRepaidCents)}</b></span>
          <span>国库变化 <b>{contextCatLiquidation.treasuryDeltaCents >= 0 ? "+" : "−"}{formatMoney(Math.abs(contextCatLiquidation.treasuryDeltaCents))}</b></span>
        </div>
        <button
          className="danger-action"
          data-testid="context-remove-cat"
          disabled={controller.state.cats.length <= 1}
          role="menuitem"
          onClick={() => {
            const key = `cat:${contextCat.id}`;
            if (pendingDestructiveAction !== key) {
              setPendingDestructiveAction(key);
              return;
            }
            const result = controller.removeCat(contextCat.id);
            if (result.ok) closeTileActionMenu();
          }}
        ><span><EmojiIcon emoji="🧾" /></span><b>{controller.state.cats.length <= 1 ? "至少保留一只猫咪" : pendingDestructiveAction === `cat:${contextCat.id}` ? "确认删除并完成清算" : "删除猫咪并清算"}</b><i>{pendingDestructiveAction === `cat:${contextCat.id}` ? "再次点击" : "完整审计"}</i></button>
      </>}
      {contextResource && <>
        <div className="tile-object-title"><span><EmojiIcon emoji={ITEM_BY_ID.get(contextResource.itemId)?.emoji ?? "❔"} /></span><strong>{ITEM_BY_ID.get(contextResource.itemId)?.name ?? contextResource.itemId}资源中心</strong></div>
        <button className="danger-action" data-testid="context-remove-resource" role="menuitem" onClick={() => {
          const key = `resource:${contextResource.id}`;
          if (pendingDestructiveAction !== key) return setPendingDestructiveAction(key);
          const result = controller.removeResource(contextResource.id);
          if (result.ok) closeTileActionMenu();
        }}><span><EmojiIcon emoji="⛏️" /></span><b>{pendingDestructiveAction === `resource:${contextResource.id}` ? "确认移除资源中心" : "移除资源中心"}</b><i>不返还材料</i></button>
      </>}
      {contextBuilding && <>
        <div className="tile-object-title"><span><EmojiIcon emoji={ITEM_BY_ID.get(contextBuilding.itemId)?.emoji ?? "🏗️"} /></span><strong>{ITEM_BY_ID.get(contextBuilding.itemId)?.name ?? contextBuilding.itemId}</strong></div>
        <button className="danger-action" data-testid="context-dismantle-building" role="menuitem" onClick={() => {
          const key = `building:${contextBuilding.id}`;
          if (pendingDestructiveAction !== key) return setPendingDestructiveAction(key);
          const result = controller.dismantleBuilding(contextBuilding.id);
          if (result.ok) closeTileActionMenu();
        }}><span><EmojiIcon emoji="🧰" /></span><b>{pendingDestructiveAction === `building:${contextBuilding.id}` ? "确认拆除建筑" : "拆除建筑"}</b><i>退回仓库</i></button>
      </>}
      {contextLandmark && <>
        <div className="tile-object-title"><span><EmojiIcon emoji={contextLandmark.landmarkId ? LANDMARK_BY_ID.get(contextLandmark.landmarkId)?.emoji ?? "🏛️" : NAMED_LANDMARK_EMOJI} /></span><strong>{landmarkDisplayName(contextLandmark)}</strong></div>
        {landmarkNameEditor?.mode === "rename" ? <form className="tile-landmark-name-form" data-testid="rename-landmark-form" onSubmit={(event) => {
          event.preventDefault();
          const result = controller.renameLandmark(contextLandmark.id, landmarkNameEditor.value);
          if (result.ok) closeTileActionMenu();
          else setLandmarkNameEditor((current) => current ? { ...current, error: result.error ?? "改名失败" } : current);
        }}>
          <label htmlFor="rename-landmark-name">地标名称必须全世界唯一</label>
          <input
            id="rename-landmark-name"
            data-testid="rename-landmark-name"
            autoFocus
            maxLength={20}
            value={landmarkNameEditor.value}
            onChange={(event) => setLandmarkNameEditor({ ...landmarkNameEditor, value: event.target.value, error: null })}
          />
          {landmarkNameEditor.error && <span className="tile-action-error" role="alert">{landmarkNameEditor.error}</span>}
          <div><button type="submit">保存名称</button><button type="button" onClick={() => setLandmarkNameEditor(null)}>取消</button></div>
        </form> : <button className="rename-landmark-action" data-testid="context-rename-landmark" role="menuitem" onClick={() => (
          setLandmarkNameEditor({ mode: "rename", value: landmarkDisplayName(contextLandmark), error: null })
        )}><span><EmojiIcon emoji="✏️" /></span><b>重命名地标</b><i>法规可读取</i></button>}
        <button className="danger-action" data-testid="context-dismantle-landmark" role="menuitem" onClick={() => {
          const key = `landmark:${contextLandmark.id}`;
          if (pendingDestructiveAction !== key) return setPendingDestructiveAction(key);
          const result = controller.dismantleLandmark(contextLandmark.id);
          if (result.ok) closeTileActionMenu();
        }}><span><EmojiIcon emoji="🧰" /></span><b>{pendingDestructiveAction === `landmark:${contextLandmark.id}` ? "确认拆除地标" : "拆除地标"}</b><i>{contextLandmark.landmarkId ? "返还半数建材" : "木材不返还"}</i></button>
      </>}
    </div>}
    </>
  );
}
