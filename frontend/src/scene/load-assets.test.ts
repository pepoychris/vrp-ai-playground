import { afterEach, describe, expect, it, vi } from 'vitest';

import { ASSET_BASE_PATH } from './assets';
import {
  HEADLESS_FIXTURE_ORIGIN,
  createFetchStub,
  installProgressEventShim,
  manifestForHeadless,
} from './local-fixtures';
import { loadSceneAssets, type AssetLoadProgress } from './load-assets';

installProgressEventShim();

const ASSETS = manifestForHeadless();

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(options: { missing?: readonly string[] } = {}) {
  const stub = createFetchStub(options);
  vi.stubGlobal('fetch', vi.fn(stub.fetch));
  return stub;
}

describe('loadSceneAssets', () => {
  it('loads every fixture through the real GLTFLoader and LoadingManager', async () => {
    const stub = stubFetch();
    const progress: AssetLoadProgress[] = [];

    const bundle = await loadSceneAssets({
      assets: ASSETS,
      onProgress: (entry) => progress.push(entry),
    });

    expect(bundle.status).toBe('ready');
    expect(bundle.assets.size).toBe(ASSETS.length);
    expect(bundle.failures).toEqual([]);
    expect(stub.calls).toHaveLength(ASSETS.length);

    for (const asset of ASSETS) {
      const loaded = bundle.assets.get(asset.id);
      expect(loaded, `${asset.id} should be loaded`).toBeDefined();
      expect(loaded?.url).toBe(`${HEADLESS_FIXTURE_ORIGIN}${ASSET_BASE_PATH}/${asset.fileName}`);
      expect(loaded?.scene.getObjectByName(asset.rootNode)).toBeTruthy();
    }
  });

  it('requests only same-origin fixture URLs', async () => {
    const stub = stubFetch();

    await loadSceneAssets({ assets: ASSETS });

    expect(stub.calls.length).toBeGreaterThan(0);
    for (const url of stub.calls) {
      expect(url.startsWith(`${HEADLESS_FIXTURE_ORIGIN}${ASSET_BASE_PATH}/`)).toBe(true);
    }
  });

  it('reports real progress that only grows and ends complete', async () => {
    stubFetch();
    const progress: AssetLoadProgress[] = [];

    await loadSceneAssets({ assets: ASSETS, onProgress: (entry) => progress.push(entry) });

    expect(progress.length).toBeGreaterThan(ASSETS.length);
    for (const entry of progress) {
      expect(entry.ratio).toBeGreaterThanOrEqual(0);
      expect(entry.ratio).toBeLessThanOrEqual(1);
      expect(entry.totalItems).toBeGreaterThanOrEqual(ASSETS.length);
    }
    const loadedCounts = progress.map((entry) => entry.loadedItems);
    expect([...loadedCounts].sort((a, b) => a - b)).toEqual(loadedCounts);
    expect(
      progress.some((entry) => entry.loadedItems > 0 && entry.loadedItems < ASSETS.length),
    ).toBe(true);
    const final = progress.at(-1);
    expect(final?.loadedItems).toBe(ASSETS.length);
    expect(final?.ratio).toBe(1);
    // Byte progress comes from the file loads, not from a simulated timer.
    expect(progress.some((entry) => entry.bytesLoaded > 0)).toBe(true);
  });

  it('keeps the healthy fixtures when one file is missing', async () => {
    const missingAsset = ASSETS[2];
    stubFetch({ missing: [missingAsset.fileName] });

    const bundle = await loadSceneAssets({ assets: ASSETS });

    expect(bundle.status).toBe('degraded');
    expect(bundle.assets.size).toBe(ASSETS.length - 1);
    expect(bundle.assets.has(missingAsset.id)).toBe(false);
    expect(bundle.failures).toHaveLength(1);
    expect(bundle.failures[0].url).toBe(missingAsset.url);
    expect(bundle.failures[0].reason.length).toBeGreaterThan(0);
  });

  it('reports a total failure when no fixture can be loaded', async () => {
    stubFetch({ missing: ASSETS.map((asset) => asset.fileName) });

    const bundle = await loadSceneAssets({ assets: ASSETS });

    expect(bundle.status).toBe('failed');
    expect(bundle.assets.size).toBe(0);
    expect(bundle.failures).toHaveLength(ASSETS.length);
  });

  it('separates authored clips from deterministic placeholders', async () => {
    stubFetch();

    const bundle = await loadSceneAssets({ assets: ASSETS });

    const vehicle = bundle.assets.get('robotVehicle');
    expect(vehicle?.authoredClipCount).toBe(2);
    expect(vehicle?.placeholderClipCount).toBe(0);
    expect(vehicle?.clips.map((clip) => clip.clipName).sort()).toEqual(['idle', 'move']);
    expect(vehicle?.clips.every((clip) => clip.authored)).toBe(true);
    expect(vehicle?.clips[0].clip.tracks.length).toBeGreaterThan(0);

    const depot = bundle.assets.get('depotLandmark');
    expect(depot?.authoredClipCount).toBe(0);
    expect(depot?.placeholderClipCount).toBe(1);
    expect(depot?.clips[0].clipName).toBe('idle');
    expect(depot?.clips[0].authored).toBe(false);
    expect(depot?.clips[0].clip.tracks.length).toBeGreaterThan(0);
  });

  it('is deterministic: the same fixture load yields the same clip tracks', async () => {
    stubFetch();
    const first = await loadSceneAssets({ assets: ASSETS });
    const second = await loadSceneAssets({ assets: ASSETS });

    const signature = (bundle: Awaited<ReturnType<typeof loadSceneAssets>>) =>
      [...bundle.assets.values()].map((asset) => ({
        id: asset.id,
        clips: asset.clips.map((clip) => ({
          name: clip.clipName,
          duration: clip.clip.duration,
          values: clip.clip.tracks.map((track) => [...track.values]),
        })),
      }));

    expect(signature(second)).toEqual(signature(first));
  });
});
