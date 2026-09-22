/**
 * The Phase 3 city stage.
 *
 * Everything visible is derived from `robot-city.json`: the ground plane, one merged
 * road surface that keeps every `roadEdgeId`, the block pads, the buildings (a single
 * `InstancedMesh`, never one mesh per building), the singular depot landmark and the
 * empty route layer a later phase fills.
 *
 * Buildings reuse the Phase 2 `buildingFixture` geometry and material when the asset
 * bundle provides them, so the city inherits the fixture visual identity instead of
 * inventing a second one; a deterministic fallback box keeps the stage buildable when
 * the library is missing.
 */

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import type { Object3D } from 'three';

import { RENDER_BUDGET, type AssetId } from '../scene/assets';
import { evaluateBudget, measureObject3D, type BudgetReport, type ResourceUsage } from '../scene/budget';
import { CITY_TOKENS, LIGHTING } from '../scene/design-tokens';
import type { SceneAssetBundle } from '../scene/load-assets';
import { instantiateShared } from '../scene/resources';

import { CITY_DATASET, type CityDataset, type RoadNetwork } from './dataset';
import { buildRoadMesh, createRouteLayer, type RoadEdgeRange } from './road-visuals';

export interface CityStageOptions {
  dataset?: CityDataset;
  /** Loaded Phase 2 assets. Without them the stage still builds, in fallback clothing. */
  bundle?: SceneAssetBundle | null;
}

export interface CityStageBuild {
  root: Group;
  ground: Mesh;
  roads: Mesh;
  roadEdgeIds: readonly string[];
  roadEdgeRanges: readonly RoadEdgeRange[];
  blocks: InstancedMesh;
  buildings: InstancedMesh;
  landmarks: Object3D;
  routes: Object3D;
  blockCount: number;
  buildingCount: number;
  landmarkCount: number;
  missingAssetIds: readonly AssetId[];
}

export interface CityStageReport extends CityStageBuild {
  usage: ResourceUsage;
  budget: BudgetReport;
}

const Y_AXIS = new Vector3(0, 1, 0);
const BLOCK_PAD_GEOMETRY = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);

export function findFirstMesh(root: Object3D): Mesh | null {
  let found: Mesh | null = null;
  root.traverse((object) => {
    if (found) return;
    const mesh = object as Mesh;
    if (mesh.isMesh) found = mesh;
  });
  return found;
}

/** Deterministic stand-in for the building fixture, used only when it did not load. */
export function fallbackBuildingGeometry(): BufferGeometry {
  return new BoxGeometry(2.4, 1.2, 2.4).translate(0, 0.6, 0);
}

export function createCityGround(dataset: CityDataset = CITY_DATASET): Mesh {
  const margin = dataset.presentation.groundMarginMeters;
  const width = dataset.bounds.maxX - dataset.bounds.minX + margin * 2;
  const depth = dataset.bounds.maxZ - dataset.bounds.minZ + margin * 2;
  const ground = new Mesh(
    new PlaneGeometry(width, depth),
    new MeshStandardMaterial({
      color: new Color(LIGHTING.ground.color),
      roughness: LIGHTING.ground.roughness,
      metalness: LIGHTING.ground.metalness,
    }),
  );
  ground.name = 'CityGround';
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(
    (dataset.bounds.minX + dataset.bounds.maxX) / 2,
    0,
    (dataset.bounds.minZ + dataset.bounds.maxZ) / 2,
  );
  return ground;
}

function blockSurfaceColorHex(kind: CityDataset['blocks'][number]['kind']): string {
  if (kind === 'PARK') return CITY_TOKENS.surfaceColors.parkSurface;
  if (kind === 'PLAZA') return CITY_TOKENS.surfaceColors.plazaSurface;
  return CITY_TOKENS.surfaceColors.blockPad;
}

/**
 * Block pads: one instanced mesh for every block, coloured per kind through the
 * instance colour buffer. A block is presentation only; the depot itself stays a node.
 */
export function createBlockPads(dataset: CityDataset = CITY_DATASET): InstancedMesh {
  const pads = new InstancedMesh(
    BLOCK_PAD_GEOMETRY,
    new MeshStandardMaterial({ roughness: 0.96, metalness: 0.0 }),
    dataset.blocks.length,
  );
  pads.name = 'CityBlocks';
  const matrix = new Matrix4();
  const color = new Color();
  dataset.blocks.forEach((block, index) => {
    matrix.compose(
      new Vector3(block.center.x, 0, block.center.z),
      new Quaternion().setFromAxisAngle(Y_AXIS, 0),
      new Vector3(block.size.x, dataset.presentation.blockPadHeightMeters, block.size.z),
    );
    pads.setMatrixAt(index, matrix);
    pads.setColorAt(index, color.set(blockSurfaceColorHex(block.kind)));
  });
  pads.instanceMatrix.needsUpdate = true;
  if (pads.instanceColor) pads.instanceColor.needsUpdate = true;
  pads.userData.blockIds = dataset.blocks.map((block) => block.blockId);
  pads.userData.blockKinds = dataset.blocks.map((block) => block.kind);
  return pads;
}

/**
 * One instanced mesh for every building placement in the dataset. `scale` and
 * `rotationYDegrees` come from the dataset, so an identical dataset always produces
 * identical instance matrices.
 */
export function createBuildingInstances(
  dataset: CityDataset = CITY_DATASET,
  bundle: SceneAssetBundle | null = null,
): { mesh: InstancedMesh; count: number; usedAsset: boolean } {
  const placements = dataset.blocks.flatMap((block) =>
    block.buildings.map((building) => ({ blockId: block.blockId, building })),
  );
  const fixture = bundle?.assets.get(dataset.presentation.buildingAssetId);
  const fixtureMesh = fixture ? findFirstMesh(fixture.scene) : null;
  const geometry = fixtureMesh?.geometry ?? fallbackBuildingGeometry();
  const material =
    (fixtureMesh?.material as MeshStandardMaterial | MeshStandardMaterial[] | undefined) ??
    new MeshStandardMaterial({
      color: new Color(CITY_TOKENS.surfaceColors.blockPad),
      roughness: 0.9,
      metalness: 0.0,
    });

  const mesh = new InstancedMesh(geometry, material, Math.max(placements.length, 1));
  mesh.name = 'CityBuildings';
  mesh.count = placements.length;
  const matrix = new Matrix4();
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  placements.forEach((placement, index) => {
    position.set(
      placement.building.x,
      dataset.presentation.blockPadHeightMeters,
      placement.building.z,
    );
    quaternion.setFromAxisAngle(Y_AXIS, (placement.building.rotationYDegrees * Math.PI) / 180);
    scale.setScalar(placement.building.scale);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.userData.blockIds = placements.map((placement) => placement.blockId);
  mesh.userData.assetId = dataset.presentation.buildingAssetId;
  mesh.userData.usedAsset = Boolean(fixtureMesh);
  return { mesh, count: placements.length, usedAsset: Boolean(fixtureMesh) };
}

/** Singular landmarks: the depot today, plus whatever a later phase adds to the file. */
export function createLandmarkProps(
  dataset: CityDataset = CITY_DATASET,
  bundle: SceneAssetBundle | null = null,
): { root: Group; missingAssetIds: AssetId[]; placed: number } {
  const root = new Group();
  root.name = 'CityLandmarks';
  const missing = new Set<AssetId>();
  let placed = 0;
  for (const landmark of dataset.landmarks) {
    const loaded = bundle?.assets.get(landmark.assetId);
    const node = dataset.nodes.find((candidate) => candidate.nodeId === landmark.nodeId);
    if (!loaded || !node) {
      missing.add(landmark.assetId);
      continue;
    }
    const instance = instantiateShared(loaded.scene);
    instance.position.set(node.position.x, node.position.y, node.position.z);
    instance.rotation.y = (landmark.rotationYDegrees * Math.PI) / 180;
    instance.scale.setScalar(landmark.scale);
    instance.name = `${landmark.landmarkId}-${landmark.assetId}`;
    instance.userData.landmarkId = landmark.landmarkId;
    instance.userData.nodeId = landmark.nodeId;
    root.add(instance);
    placed += 1;
  }
  return { root, missingAssetIds: [...missing], placed };
}

export function buildCityStage(options: CityStageOptions = {}): CityStageBuild {
  const dataset = options.dataset ?? CITY_DATASET;
  const bundle = options.bundle ?? null;
  const network: RoadNetwork = {
    dataset,
    nodes: new Map(dataset.nodes.map((node) => [node.nodeId, node])),
    edges: new Map(dataset.edges.map((edge) => [edge.edgeId, edge])),
    depotNodeId: dataset.nodes.find((node) => node.kind === 'DEPOT')?.nodeId ?? '',
    deliveryNodeIds: dataset.nodes
      .filter((node) => node.kind === 'DELIVERY')
      .map((node) => node.nodeId)
      .sort(),
    nodeIds: dataset.nodes.map((node) => node.nodeId).sort(),
    edgeIds: dataset.edges.map((edge) => edge.edgeId).sort(),
  };

  const root = new Group();
  root.name = 'CityRoot';
  const ground = createCityGround(dataset);
  const roads = buildRoadMesh(network);
  const blocks = createBlockPads(dataset);
  const buildings = createBuildingInstances(dataset, bundle);
  const landmarks = createLandmarkProps(dataset, bundle);
  const routes = createRouteLayer();

  root.add(ground, roads.mesh, blocks, buildings.mesh, landmarks.root, routes);

  return {
    root,
    ground,
    roads: roads.mesh,
    roadEdgeIds: roads.edgeIds,
    roadEdgeRanges: roads.ranges,
    blocks,
    buildings: buildings.mesh,
    landmarks: landmarks.root,
    routes,
    blockCount: dataset.blocks.length,
    buildingCount: buildings.count,
    landmarkCount: landmarks.placed,
    missingAssetIds: landmarks.missingAssetIds,
  };
}

export function buildCityStageReport(options: CityStageOptions = {}): CityStageReport {
  const stage = buildCityStage(options);
  const usage = measureObject3D(stage.root);
  const budget = evaluateBudget('phase-3-city-stage', usage, RENDER_BUDGET.city);
  return { ...stage, usage, budget };
}
