import { describe, expect, it } from 'vitest';

import type { AssetFailure, LoadSceneAssetsOptions, SceneAssetBundle } from '../scene/load-assets';
import {
  EXPECTED_ASSET_COUNT,
  INITIAL_ASSET_READINESS,
  loadAssetReadiness,
  readinessFromProgress,
  readinessSummary,
  type AssetReadinessState,
} from './asset-readiness';

const FAILURE: AssetFailure = {
  id: 'barrier',
  url: '/assets/models/barrier.glb',
  reason: 'HTTP 404',
};

function fakeBundle(overrides: Partial<SceneAssetBundle> = {}): SceneAssetBundle {
  return {
    status: 'ready',
    assets: new Map(),
    failures: [],
    progress: {
      loadedItems: EXPECTED_ASSET_COUNT,
      totalItems: EXPECTED_ASSET_COUNT,
      ratio: 1,
      currentUrl: null,
      bytesLoaded: 0,
      bytesTotal: null,
    },
    ...overrides,
  };
}

function assetsMap(size: number): SceneAssetBundle['assets'] {
  const ids = ['robotVehicle', 'robotClaw', 'barrier', 'depotLandmark', 'buildingFixture'] as const;
  return new Map(ids.slice(0, size).map((id) => [id, { id } as never]));
}

describe('readinessFromProgress', () => {
  it('maps a manager snapshot onto the loading state', () => {
    const state = readinessFromProgress({
      loadedItems: 2,
      totalItems: EXPECTED_ASSET_COUNT,
      ratio: 0.4,
      currentUrl: '/assets/models/robot-claw.glb',
    });

    expect(state.status).toBe('loading');
    expect(state.loadedItems).toBe(2);
    expect(state.ratio).toBeCloseTo(0.4, 6);
    expect(state.currentUrl).toBe('/assets/models/robot-claw.glb');
    expect(state.error).toBeNull();
  });

  it('never reports fewer fixtures than the manifest declares', () => {
    expect(readinessFromProgress({ loadedItems: 0, totalItems: 0, ratio: 0, currentUrl: null }).totalItems).toBe(
      EXPECTED_ASSET_COUNT,
    );
  });
});

describe('readinessSummary', () => {
  it('describes each status', () => {
    expect(readinessSummary(INITIAL_ASSET_READINESS)).toBe('Waiting to load');
    expect(
      readinessSummary({ ...INITIAL_ASSET_READINESS, status: 'loading', loadedItems: 2 }),
    ).toBe(`Loading 2 of ${EXPECTED_ASSET_COUNT}`);
    expect(readinessSummary({ ...INITIAL_ASSET_READINESS, status: 'ready' })).toBe(
      `${EXPECTED_ASSET_COUNT} of ${EXPECTED_ASSET_COUNT} loaded`,
    );
    expect(
      readinessSummary({
        ...INITIAL_ASSET_READINESS,
        status: 'degraded',
        loadedItems: 4,
        failures: [FAILURE],
      }),
    ).toBe(`4 of ${EXPECTED_ASSET_COUNT} loaded, 1 failed`);
    expect(readinessSummary({ ...INITIAL_ASSET_READINESS, status: 'failed' })).toBe(
      'No fixture asset could be loaded',
    );
  });
});

describe('loadAssetReadiness', () => {
  it('walks loading to ready and forwards every real progress step', async () => {
    const updates: AssetReadinessState[] = [];

    const result = await loadAssetReadiness({
      onUpdate: (state) => updates.push(state),
      load: async (options: LoadSceneAssetsOptions) => {
        options.onProgress?.({
          loadedItems: 0,
          totalItems: EXPECTED_ASSET_COUNT,
          ratio: 0,
          currentUrl: '/assets/models/robot-vehicle.glb',
          bytesLoaded: 0,
          bytesTotal: null,
        });
        options.onProgress?.({
          loadedItems: 3,
          totalItems: EXPECTED_ASSET_COUNT,
          ratio: 0.6,
          currentUrl: '/assets/models/barrier.glb',
          bytesLoaded: 512,
          bytesTotal: 2048,
        });
        return fakeBundle({ assets: assetsMap(EXPECTED_ASSET_COUNT) });
      },
    });

    expect(updates[0]).toEqual({ ...INITIAL_ASSET_READINESS, status: 'loading' });
    expect(updates.some((state) => state.loadedItems === 3 && state.status === 'loading')).toBe(true);
    expect(result.readiness.status).toBe('ready');
    expect(result.readiness.ratio).toBe(1);
    expect(result.bundle).not.toBeNull();
  });

  it('reports a degraded library with the failing fixtures', async () => {
    const result = await loadAssetReadiness({
      load: async () =>
        fakeBundle({
          status: 'degraded',
          assets: assetsMap(EXPECTED_ASSET_COUNT - 1),
          failures: [FAILURE],
        }),
    });

    expect(result.readiness.status).toBe('degraded');
    expect(result.readiness.loadedItems).toBe(EXPECTED_ASSET_COUNT - 1);
    expect(result.readiness.failures).toEqual([FAILURE]);
    expect(result.readiness.ratio).toBeCloseTo((EXPECTED_ASSET_COUNT - 1) / EXPECTED_ASSET_COUNT, 6);
  });

  it('reports a failed load without throwing', async () => {
    const result = await loadAssetReadiness({
      load: async () => {
        throw new Error('asset pipeline exploded');
      },
    });

    expect(result.readiness.status).toBe('failed');
    expect(result.readiness.error).toBe('asset pipeline exploded');
    expect(result.bundle).toBeNull();
  });

  it('starts in the loading state before the loader resolves', async () => {
    const updates: AssetReadinessState[] = [];
    const result = await loadAssetReadiness({
      onUpdate: (state) => updates.push(state),
      load: async () => fakeBundle({ assets: assetsMap(EXPECTED_ASSET_COUNT) }),
    });

    expect(updates[0].status).toBe('loading');
    expect(result.readiness.status).toBe('ready');
  });
});
