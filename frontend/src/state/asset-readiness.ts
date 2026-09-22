/**
 * Readiness model for the Phase 2 fixture assets.
 *
 * Loading is recoverable by design: a fixture that fails is reported while the rest of
 * the library still becomes usable. The state transitions are pure functions so the UI
 * can be checked without a browser or a WebGL context.
 */

import { ASSET_MANIFEST } from '../scene/assets';
import type { AssetFailure, LoadSceneAssetsOptions, SceneAssetBundle } from '../scene/load-assets';

export type AssetReadinessStatus = 'idle' | 'loading' | 'ready' | 'degraded' | 'failed';

export interface AssetReadinessState {
  status: AssetReadinessStatus;
  loadedItems: number;
  totalItems: number;
  ratio: number;
  currentUrl: string | null;
  failures: readonly AssetFailure[];
  error: string | null;
}

export const EXPECTED_ASSET_COUNT = ASSET_MANIFEST.length;

export const INITIAL_ASSET_READINESS: AssetReadinessState = {
  status: 'idle',
  loadedItems: 0,
  totalItems: EXPECTED_ASSET_COUNT,
  ratio: 0,
  currentUrl: null,
  failures: [],
  error: null,
};

export interface AssetLoadProgressSnapshot {
  loadedItems: number;
  totalItems: number;
  ratio: number;
  currentUrl: string | null;
}

export function readinessFromProgress(
  progress: AssetLoadProgressSnapshot,
  failures: readonly AssetFailure[] = [],
): AssetReadinessState {
  return {
    status: 'loading',
    loadedItems: progress.loadedItems,
    totalItems: Math.max(progress.totalItems, EXPECTED_ASSET_COUNT),
    ratio: progress.ratio,
    currentUrl: progress.currentUrl,
    failures,
    error: null,
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface AssetReadinessResult {
  readiness: AssetReadinessState;
  bundle: SceneAssetBundle | null;
}

export interface LoadAssetReadinessOptions extends LoadSceneAssetsOptions {
  onUpdate?: (state: AssetReadinessState) => void;
  /** Injection point: defaults to a dynamic import of the real loader. */
  load?: (options: LoadSceneAssetsOptions) => Promise<SceneAssetBundle>;
}

export async function loadAssetReadiness(
  options: LoadAssetReadinessOptions = {},
): Promise<AssetReadinessResult> {
  const { onUpdate, load, ...loadOptions } = options;
  const loadBundle = load ?? (await import('../scene/load-assets')).loadSceneAssets;

  onUpdate?.({ ...INITIAL_ASSET_READINESS, status: 'loading' });
  try {
    const bundle = await loadBundle({
      ...loadOptions,
      onProgress: (progress) => {
        onUpdate?.(readinessFromProgress(progress));
        loadOptions.onProgress?.(progress);
      },
    });
    const readiness: AssetReadinessState = {
      status: bundle.status,
      loadedItems: bundle.assets.size,
      totalItems: EXPECTED_ASSET_COUNT,
      ratio: Math.min(bundle.assets.size / EXPECTED_ASSET_COUNT, 1),
      currentUrl: null,
      failures: bundle.failures,
      error: null,
    };
    onUpdate?.(readiness);
    return { readiness, bundle };
  } catch (error) {
    const readiness: AssetReadinessState = {
      ...INITIAL_ASSET_READINESS,
      status: 'failed',
      error: describeError(error),
    };
    onUpdate?.(readiness);
    return { readiness, bundle: null };
  }
}

export function readinessSummary(state: AssetReadinessState): string {
  switch (state.status) {
    case 'idle':
      return 'Waiting to load';
    case 'loading':
      return `Loading ${state.loadedItems} of ${state.totalItems}`;
    case 'ready':
      return `${state.totalItems} of ${state.totalItems} loaded`;
    case 'degraded':
      return `${state.loadedItems} of ${state.totalItems} loaded, ${state.failures.length} failed`;
    case 'failed':
      return 'No fixture asset could be loaded';
    default:
      return 'Unknown';
  }
}
