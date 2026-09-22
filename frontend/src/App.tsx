import { useCallback, useEffect, useState } from 'react';

import { AssetReadinessPanel } from './components/AssetReadinessPanel';
import { SceneStage } from './components/SceneStage';
import { StatusScreen } from './components/StatusScreen';
import { INACTIVE_READINESS, loadReadiness, type Readiness } from './state/readiness';
import { useSceneAssets } from './state/use-scene-assets';

export function App() {
  const [readiness, setReadiness] = useState<Readiness>(INACTIVE_READINESS);
  const [refreshing, setRefreshing] = useState(false);
  const { readiness: assetReadiness, bundle, reload } = useSceneAssets();

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    try {
      const next = await loadReadiness(signal);
      if (!signal?.aborted) {
        setReadiness(next);
      }
    } finally {
      if (!signal?.aborted) {
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  return (
    <StatusScreen
      readiness={readiness}
      refreshing={refreshing}
      onRefresh={() => {
        void refresh();
      }}
      scene={
        <>
          <AssetReadinessPanel readiness={assetReadiness} onReload={reload} />
          <SceneStage bundle={bundle} />
        </>
      }
    />
  );
}
