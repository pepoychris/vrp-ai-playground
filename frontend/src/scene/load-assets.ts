/**
 * Local-only asset loading for the Phase 2 fixture pipeline.
 *
 * Progress comes from the Three.js LoadingManager and the real file loads it tracks:
 * there is no timer, no simulated percentage and no external URL. A failing fixture is
 * recorded and the remaining fixtures still load, which is what makes the readiness
 * surface recoverable instead of fatal.
 */

import { LoadingManager } from 'three';
import type { AnimationClip, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { resolveAssetClips, type ResolvedClip } from './animation-clips';
import { ASSET_MANIFEST, type AssetDefinition, type AssetId } from './assets';

export interface GltfAsset {
  scene: Object3D;
  animations: readonly AnimationClip[];
}

export interface AssetLoadProgress {
  loadedItems: number;
  totalItems: number;
  ratio: number;
  currentUrl: string | null;
  bytesLoaded: number;
  bytesTotal: number | null;
}

export interface LoadedAsset {
  id: AssetId;
  fileName: string;
  url: string;
  rootNode: string;
  asset: AssetDefinition;
  scene: Object3D;
  clips: readonly ResolvedClip[];
  authoredClipCount: number;
  placeholderClipCount: number;
}

export interface AssetFailure {
  id: AssetId;
  url: string;
  reason: string;
}

export type SceneAssetStatus = 'ready' | 'degraded' | 'failed';

export interface SceneAssetBundle {
  status: SceneAssetStatus;
  assets: ReadonlyMap<AssetId, LoadedAsset>;
  failures: readonly AssetFailure[];
  progress: AssetLoadProgress;
}

export interface LoadSceneAssetsOptions {
  /** Injection point for tests and headless checks. */
  manager?: LoadingManager;
  assets?: readonly AssetDefinition[];
  onProgress?: (progress: AssetLoadProgress) => void;
  onAssetLoaded?: (asset: LoadedAsset) => void;
  loadAsset?: (asset: AssetDefinition) => Promise<GltfAsset>;
}

interface ByteProgressEvent {
  loaded?: number;
  total?: number;
  lengthComputable?: boolean;
}

export function createAssetLoadingManager(): LoadingManager {
  return new LoadingManager();
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { message?: string; type?: string };
    if (candidate.message) return candidate.message;
    if (candidate.type) return candidate.type;
  }
  return String(error);
}

export function createGltfAssetLoader(
  manager: LoadingManager,
  onBytes?: (url: string, event: ByteProgressEvent) => void,
): (asset: AssetDefinition) => Promise<GltfAsset> {
  const loader = new GLTFLoader(manager);
  return (asset) =>
    new Promise<GltfAsset>((resolve, reject) => {
      loader.load(
        asset.url,
        (gltf) => resolve(gltf as unknown as GltfAsset),
        (event) => onBytes?.(asset.url, event as ByteProgressEvent),
        (error) => reject(error instanceof Error ? error : new Error(describeError(error))),
      );
    });
}

interface ProgressTracker {
  progress(): AssetLoadProgress;
  reportBytes(url: string, event: ByteProgressEvent): void;
  itemErrors(): readonly string[];
}

function createProgressTracker(
  manager: LoadingManager,
  expectedTotal: number,
  onProgress?: (progress: AssetLoadProgress) => void,
): ProgressTracker {
  let trackedRatio = 0;
  let currentUrl: string | null = null;
  const byteProgress = new Map<string, { loaded: number; total: number }>();
  const errors: string[] = [];

  const progress = (): AssetLoadProgress => {
    let bytesLoaded = 0;
    let bytesTotal: number | null = 0;
    for (const entry of byteProgress.values()) {
      bytesLoaded += entry.loaded;
      if (bytesTotal === null || entry.total <= 0) {
        bytesTotal = null;
      } else {
        bytesTotal += entry.total;
      }
    }
    return {
      loadedItems: Math.round(trackedRatio * expectedTotal),
      totalItems: expectedTotal,
      ratio: trackedRatio,
      currentUrl,
      bytesLoaded,
      bytesTotal,
    };
  };

  const emit = () => onProgress?.(progress());

  manager.onStart = (url) => {
    currentUrl = url;
    emit();
  };
  manager.onProgress = (url, loaded, total) => {
    currentUrl = url;
    // GLTFLoader registers one extra tracked item per file (the parse pass), and the
    // manager only counts items that already started. The manager ratio is therefore
    // the reliable signal, and it is clamped so a newly started file can never move a
    // progress bar backwards.
    if (total > 0) {
      trackedRatio = Math.max(trackedRatio, Math.min(loaded / total, 1));
    }
    emit();
  };
  manager.onError = (url) => {
    errors.push(url);
  };

  return {
    progress,
    itemErrors: () => errors,
    reportBytes(url, event) {
      const loaded = Number(event.loaded ?? 0);
      const total = event.lengthComputable === false ? 0 : Number(event.total ?? 0);
      const previous = byteProgress.get(url);
      byteProgress.set(url, {
        loaded: Math.max(previous?.loaded ?? 0, loaded),
        total: Math.max(previous?.total ?? 0, total),
      });
      emit();
    },
  };
}

export async function loadSceneAssets(
  options: LoadSceneAssetsOptions = {},
): Promise<SceneAssetBundle> {
  const assets = options.assets ?? ASSET_MANIFEST;
  const manager = options.manager ?? createAssetLoadingManager();
  const tracker = createProgressTracker(manager, assets.length, options.onProgress);
  const loadAsset = options.loadAsset ?? createGltfAssetLoader(manager, tracker.reportBytes);

  const settled = await Promise.all(
    assets.map(async (asset) => {
      try {
        const gltf = await loadAsset(asset);
        const clips = resolveAssetClips(asset, gltf.scene, gltf.animations);
        const loaded: LoadedAsset = {
          id: asset.id,
          fileName: asset.fileName,
          url: asset.url,
          rootNode: asset.rootNode,
          asset,
          scene: gltf.scene,
          clips,
          authoredClipCount: clips.filter((clip) => clip.authored).length,
          placeholderClipCount: clips.filter((clip) => !clip.authored).length,
        };
        options.onAssetLoaded?.(loaded);
        return { kind: 'loaded' as const, loaded };
      } catch (error) {
        return {
          kind: 'failure' as const,
          failure: {
            id: asset.id,
            url: asset.url,
            reason: describeError(error),
          } satisfies AssetFailure,
        };
      }
    }),
  );

  const loadedAssets = new Map<AssetId, LoadedAsset>();
  const failures: AssetFailure[] = [];
  for (const entry of settled) {
    if (entry.kind === 'loaded') {
      loadedAssets.set(entry.loaded.id, entry.loaded);
    } else {
      failures.push(entry.failure);
    }
  }

  const status: SceneAssetStatus =
    loadedAssets.size === 0 ? 'failed' : failures.length > 0 ? 'degraded' : 'ready';
  const finalProgress: AssetLoadProgress = {
    ...tracker.progress(),
    loadedItems: assets.length,
    totalItems: assets.length,
    ratio: 1,
    currentUrl: null,
  };
  options.onProgress?.(finalProgress);

  return { status, assets: loadedAssets, failures, progress: finalProgress };
}
