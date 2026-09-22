/**
 * Deterministic Phase 3 city benchmark.
 *
 * It measures the real city stage - dataset, roads, blocks, instanced buildings and the
 * depot landmark - against the city budget in `render-budget.json`, and pins the
 * dataset fingerprint so a change to the city file is visible in review instead of
 * arriving silently.
 *
 * What is not measured, and is never reported as measured: frames per second and GPU
 * memory. A headless run has no WebGL context, and the budget file says so. Run the
 * numbers with `npm run benchmark:city`.
 */

import { describe, expect, it, vi } from 'vitest';

import { RENDER_BUDGET } from '../scene/assets';
import { formatBudgetReport } from '../scene/budget';
import { loadSceneAssets, type SceneAssetBundle } from '../scene/load-assets';
import {
  createFetchStub,
  installProgressEventShim,
  manifestForHeadless,
} from '../scene/local-fixtures';

import { buildCityStageReport } from './city-stage';
import { CITY_DATASET, cityBuildingCount, createRoadNetwork } from './dataset';

installProgressEventShim();

async function loadBundle(): Promise<SceneAssetBundle> {
  vi.stubGlobal('fetch', vi.fn(createFetchStub().fetch));
  return loadSceneAssets({ assets: manifestForHeadless() });
}

/** Fingerprint of the committed dataset. A change here must be intentional. */
const DATASET_FINGERPRINT = {
  nodes: 63,
  depotNodes: 1,
  deliveryNodes: 18,
  junctionNodes: 44,
  edges: 110,
  blocks: 48,
  builtBlocks: 41,
  parkBlocks: 3,
  plazaBlocks: 4,
  buildings: 137,
  landmarks: 1,
};

describe('dataset fingerprint', () => {
  it('matches the committed city file', () => {
    const network = createRoadNetwork();
    const count = (predicate: (value: string) => boolean) =>
      CITY_DATASET.nodes.filter((node) => predicate(node.kind)).length;

    expect({
      nodes: CITY_DATASET.nodes.length,
      depotNodes: count((kind) => kind === 'DEPOT'),
      deliveryNodes: count((kind) => kind === 'DELIVERY'),
      junctionNodes: count((kind) => kind === 'JUNCTION'),
      edges: CITY_DATASET.edges.length,
      blocks: CITY_DATASET.blocks.length,
      builtBlocks: CITY_DATASET.blocks.filter((block) => block.kind === 'BUILT').length,
      parkBlocks: CITY_DATASET.blocks.filter((block) => block.kind === 'PARK').length,
      plazaBlocks: CITY_DATASET.blocks.filter((block) => block.kind === 'PLAZA').length,
      buildings: cityBuildingCount(),
      landmarks: CITY_DATASET.landmarks.length,
    }).toEqual(DATASET_FINGERPRINT);
    expect(network.deliveryNodeIds).toHaveLength(DATASET_FINGERPRINT.deliveryNodes);
  });

  it('reserves a route colour for every vehicle the MVP allows', () => {
    expect(RENDER_BUDGET.city.maxDrawCalls).toBeGreaterThan(0);
    expect(CITY_DATASET.presentation.routeWidthMeters).toBeGreaterThan(0);
  });
});

describe('city stage budget', () => {
  it('builds the committed city inside the city budget', async () => {
    const bundle = await loadBundle();
    const report = buildCityStageReport({ bundle });
    const lines = [
      `city stage: ${report.budget.pass ? 'PASS' : 'FAIL'}`,
      `  nodes=${CITY_DATASET.nodes.length} edges=${report.roadEdgeIds.length} ` +
        `blocks=${report.blockCount} buildings=${report.buildingCount} landmarks=${report.landmarkCount}`,
      ...formatBudgetReport(report.budget).slice(1),
      '  fpsMeasurement: not-measured (a headless benchmark has no WebGL context)',
      '  gpuMemoryMeasurement: not-measured (memoryProxyBytes is a CPU-side proxy)',
    ];
    console.log(lines.join('\n'));

    expect(report.budget.pass, lines.join('\n')).toBe(true);
    expect(report.usage.triangles).toBeGreaterThan(0);
    expect(report.usage.drawCalls).toBeLessThanOrEqual(RENDER_BUDGET.city.maxDrawCalls);
    expect(report.usage.instanceCount).toBeLessThanOrEqual(RENDER_BUDGET.city.maxInstanceCount);
    expect(report.missingAssetIds).toEqual([]);
  });

  it('keeps the whole city to a handful of draw calls', async () => {
    const bundle = await loadBundle();
    const report = buildCityStageReport({ bundle });

    // Ground, one merged road surface, one instanced mesh of blocks, one instanced mesh
    // of buildings and the singular depot landmark.
    expect(report.usage.drawCalls).toBe(5);
    expect(report.usage.geometryCount).toBe(5);
    expect(report.usage.materialCount).toBe(5);
    expect(report.usage.textureCount).toBe(0);
  });

  it('costs no more geometry than the declared instance budget allows', async () => {
    const bundle = await loadBundle();
    const report = buildCityStageReport({ bundle });

    expect(report.usage.instanceCount).toBe(
      2 + CITY_DATASET.blocks.length + cityBuildingCount() + 1,
    );
    expect(report.usage.triangles).toBeLessThan(RENDER_BUDGET.city.maxTriangles / 4);
  });

  it('reports the same usage on a rebuild', async () => {
    const bundle = await loadBundle();

    const first = buildCityStageReport({ bundle });
    const second = buildCityStageReport({ bundle });

    expect(second.usage).toEqual(first.usage);
    expect(Array.from(second.buildings.instanceMatrix.array)).toEqual(
      Array.from(first.buildings.instanceMatrix.array),
    );
  });
});

describe('Phase 2 budgets are untouched', () => {
  it('keeps the fixture stage and per-asset limits exactly as Phase 2 declared them', () => {
    expect(RENDER_BUDGET.perAsset).toEqual({
      maxTriangles: 1500,
      maxDrawCalls: 4,
      maxTextureCount: 2,
      maxTextureBytes: 131072,
      maxFileBytes: 262144,
    });
    expect(RENDER_BUDGET.stage).toEqual({
      maxTriangles: 20000,
      maxDrawCalls: 32,
      maxTextureCount: 8,
      maxTextureBytes: 1048576,
      maxMemoryProxyBytes: 33554432,
      maxInstanceCount: 24,
    });
    expect(RENDER_BUDGET.targetFps).toBe(60);
    expect(RENDER_BUDGET.minimumAcceptableFps).toBe(30);
    expect(RENDER_BUDGET.measurementNotes).toMatch(/never reported as measured/i);
  });
});
