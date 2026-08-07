import type { CatState, DeployedBuilding, DeployedLandmark, GameState, Position, ResourceNode } from "../game/types";
import { sceneDepthCompare } from "./isometric";
import { actorScenePosition } from "./gameCanvasGeometry";

export type SceneEntry =
  | { kind: "resource"; position: Position; layer: number; order: number; node: ResourceNode }
  | { kind: "building"; position: Position; layer: number; order: number; building: DeployedBuilding }
  | { kind: "landmark"; position: Position; layer: number; order: number; landmark: DeployedLandmark }
  | { kind: "actor"; position: Position; layer: number; order: number; cat: CatState };

export interface SceneBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface SceneReadModel {
  visibleCats: CatState[];
  scene: SceneEntry[];
  stationBases: CatState[];
  catById: Map<string, CatState>;
}

export function rebuildSceneReadModel(
  state: Pick<GameState, "cats" | "resourceNodes" | "buildings" | "landmarks" | "simTime">,
  bounds: SceneBounds,
  reducedMotion: boolean,
  scratch: SceneReadModel,
): void {
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
}
