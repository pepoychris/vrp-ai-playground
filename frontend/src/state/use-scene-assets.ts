/**
 * React binding for the fixture readiness model.
 *
 * The Three.js loader is imported dynamically so the first paint of the control tower
 * never waits for the 3D bundle.
 */

import { useCallback, useEffect, useState } from 'react';

import type { SceneAssetBundle } from '../scene/load-assets';
import {
  INITIAL_ASSET_READINESS,
  loadAssetReadiness,
  type AssetReadinessState,
} from './asset-readiness';

export interface SceneAssetsHook {
  readiness: AssetReadinessState;
  bundle: SceneAssetBundle | null;
  reload: () => void;
}

export function useSceneAssets(): SceneAssetsHook {
  const [readiness, setReadiness] = useState<AssetReadinessState>(INITIAL_ASSET_READINESS);
  const [bundle, setBundle] = useState<SceneAssetBundle | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setBundle(null);
    void loadAssetReadiness({
      onUpdate: (next) => {
        if (!cancelled) setReadiness(next);
      },
    }).then((result) => {
      if (cancelled) return;
      setReadiness(result.readiness);
      setBundle(result.bundle);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const reload = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  return { readiness, bundle, reload };
}
