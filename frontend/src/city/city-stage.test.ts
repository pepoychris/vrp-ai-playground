/**
 * Phase 3 city stage.
 *
 * The stage has to be a faithful reading of the dataset: one road segment per edge
 * carrying its own `roadEdgeId`, blocks and buildings generated from the file, a single
 * instanced mesh for the repeated buildings, and the same result every time it is built.
 */

import { Mesh, Object3D } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { loadSceneAssets, type SceneAssetBundle } from '../scene/load-assets';
import {
  createFetchStub,
  installProgressEventShim,
  manifestForHeadless,
} from '../scene/local-fixtures';
import { ResourceRegistry } from '../scene/resources';

import { createCityGround, buildCityStage, createBuildingInstances, findFirstMesh } from './city-stage';
import { CITY_DATASET, cityBuildingCount } from './dataset';

installProgressEventShim();

async function loadBundle(): Promise<SceneAssetBundle> {
  vi.stubGlobal('fetch', vi.fn(createFetchStub().fetch));
  return loadSceneAssets({ assets: manifestForHeadless() });
}

function instanceCounts(root: Object3D): { meshes: number; instances: number } {
  let meshes = 0;
  let instances = 0;
  root.traverse((object) => {
    const mesh = object as Mesh & { isInstancedMesh?: boolean; count?: number };
    if (!mesh.isMesh) return;
    meshes += 1;
    instances += mesh.isInstancedMesh ? (mesh.count ?? 0) : 1;
  });
  return { meshes, instances };
}

describe('city ground', () => {
  it('covers the city bounds plus the declared margin', () => {
    const ground = createCityGround();
    const parameters = (ground.geometry as unknown as { parameters: { width: number; height: number } })
      .parameters;
    const margin = CITY_DATASET.presentation.groundMarginMeters;

    expect(ground.name).toBe('CityGround');
    expect(ground.rotation.x).toBeCloseTo(-Math.PI / 2, 9);
    expect(parameters.width).toBeCloseTo(
      CITY_DATASET.bounds.maxX - CITY_DATASET.bounds.minX + margin * 2,
      6,
    );
    expect(parameters.height).toBeCloseTo(
      CITY_DATASET.bounds.maxZ - CITY_DATASET.bounds.minZ + margin * 2,
      6,
    );
  });
});

describe('city stage without assets', () => {
  const stage = buildCityStage({ bundle: null });

  it('still builds the whole city with a fallback building geometry', () => {
    expect(stage.blockCount).toBe(CITY_DATASET.blocks.length);
    expect(stage.buildingCount).toBe(cityBuildingCount());
    expect(stage.buildings.count).toBe(cityBuildingCount());
    expect(stage.buildings.userData.usedAsset).toBe(false);
    expect(stage.roadEdgeIds.length).toBe(CITY_DATASET.edges.length);
  });

  it('reports the landmark it could not place instead of failing', () => {
    expect(stage.landmarkCount).toBe(0);
    expect(stage.missingAssetIds).toEqual(['depotLandmark']);
    expect(stage.landmarks.children).toHaveLength(0);
  });
});

describe('city stage with the Phase 2 assets', () => {
  it('reuses the fixture geometry and places the singular depot landmark', async () => {
    const bundle = await loadBundle();

    const stage = buildCityStage({ bundle });

    expect(stage.missingAssetIds).toEqual([]);
    expect(stage.landmarkCount).toBe(1);
    expect(stage.buildings.userData.usedAsset).toBe(true);
    expect(stage.landmarks.children[0].name).toMatch(/L-DEPOT-depotLandmark/);
    expect(stage.landmarks.children[0].userData.nodeId).toBe('N-032');

    const fixtureMesh = findFirstMesh(bundle.assets.get('buildingFixture')!.scene);
    expect(stage.buildings.geometry).toBe(fixtureMesh?.geometry);
    expect(stage.buildings.material).toBe(fixtureMesh?.material);
  });

  it('places the depot landmark on the depot node with its dataset scale', async () => {
    const bundle = await loadBundle();
    const depot = CITY_DATASET.nodes.find((node) => node.kind === 'DEPOT')!;

    const stage = buildCityStage({ bundle });
    const landmark = stage.landmarks.children[0];

    expect(landmark.position.x).toBeCloseTo(depot.position.x, 9);
    expect(landmark.position.z).toBeCloseTo(depot.position.z, 9);
    expect(landmark.scale.x).toBeCloseTo(CITY_DATASET.landmarks[0].scale, 9);
  });
});

describe('road segments keep their identity', () => {
  it('maps every rendered segment to its stable roadEdgeId', () => {
    const stage = buildCityStage({ bundle: null });
    const ids = stage.roadEdgeIds;
    const ranges = stage.roadEdgeRanges;

    expect(ids).toEqual([...CITY_DATASET.edges.map((edge) => edge.edgeId)].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ranges.map((range) => range.edgeId)).toEqual(ids);
    expect(stage.roads.userData.roadEdgeIds).toEqual(ids);
    for (const range of ranges) {
      expect(range.vertexCount).toBe(6);
      expect(range.triangleCount).toBe(4);
    }
  });
});

describe('repeated geometry', () => {
  it('uses one instanced mesh for every building and one for every block', () => {
    const stage = buildCityStage({ bundle: null });

    expect(stage.buildings.isInstancedMesh).toBe(true);
    expect(stage.blocks.isInstancedMesh).toBe(true);
    expect(stage.blocks.count).toBe(CITY_DATASET.blocks.length);
    const counts = instanceCounts(stage.root);
    expect(counts.meshes).toBe(4);
    expect(counts.instances).toBe(2 + CITY_DATASET.blocks.length + cityBuildingCount());
  });

  it('derives a block pad matrix from the dataset block', () => {
    const stage = buildCityStage({ bundle: null });
    const block = CITY_DATASET.blocks[0];
    const matrix = stage.blocks.instanceMatrix.array;

    expect(Array.from(matrix.slice(12, 15))).toEqual([
      block.center.x,
      0,
      block.center.z,
    ]);
    // Instance matrices are stored in a Float32Array, so single precision is the limit.
    expect(matrix[0]).toBeCloseTo(block.size.x, 4);
    expect(matrix[10]).toBeCloseTo(block.size.z, 4);
  });

  it('places every building from the file, with no fallback when the asset is loaded', async () => {
    const bundle = await loadBundle();
    const withAssets = buildCityStage({ bundle });
    const expected = CITY_DATASET.blocks.flatMap((block) => block.buildings);

    expect(withAssets.buildings.count).toBe(expected.length);
    const matrix = withAssets.buildings.instanceMatrix.array;
    expected.forEach((building, index) => {
      const offset = index * 16;
      expect(matrix[offset + 12]).toBeCloseTo(building.x, 4);
      expect(matrix[offset + 14]).toBeCloseTo(building.z, 4);
      // The instance is rotated about Y, so the scale is the length of its first column.
      expect(
        Math.hypot(matrix[offset], matrix[offset + 1], matrix[offset + 2]),
      ).toBeCloseTo(building.scale, 4);
    });
  });
});

describe('determinism', () => {
  it('produces identical instance matrices on every build', () => {
    const first = buildCityStage({ bundle: null });
    const second = buildCityStage({ bundle: null });

    expect(Array.from(second.buildings.instanceMatrix.array)).toEqual(
      Array.from(first.buildings.instanceMatrix.array),
    );
    expect(Array.from(second.blocks.instanceMatrix.array)).toEqual(
      Array.from(first.blocks.instanceMatrix.array),
    );
    expect(second.roadEdgeIds).toEqual(first.roadEdgeIds);
  });

  it('falls back deterministically when the bundle only has some assets', async () => {
    const bundle = await loadBundle();
    const withoutBuilding: SceneAssetBundle = {
      ...bundle,
      assets: new Map([...bundle.assets].filter(([id]) => id !== 'buildingFixture')),
    };

    const stage = buildCityStage({ bundle: withoutBuilding });

    expect(stage.buildings.userData.usedAsset).toBe(false);
    expect(stage.buildings.count).toBe(cityBuildingCount());
    expect(stage.landmarkCount).toBe(1);
  });
});

describe('resource ownership', () => {
  it('disposes every unique resource exactly once', () => {
    const stage = buildCityStage({ bundle: null });
    const registry = ResourceRegistry.from(stage.root);
    const usage = registry.usage;

    const report = registry.dispose();

    expect(report.alreadyDisposed).toBe(false);
    expect(report.geometryCount).toBe(usage.geometryCount);
    expect(report.materialCount).toBe(usage.materialCount);
    expect(report.textureCount).toBe(0);
    expect(registry.dispose().alreadyDisposed).toBe(true);
  });

  it('creates one building instance mesh even for an empty placement list', () => {
    const empty = createBuildingInstances(
      { ...CITY_DATASET, blocks: [] },
      null,
    );

    expect(empty.count).toBe(0);
    expect(empty.mesh.isInstancedMesh).toBe(true);
  });
});
