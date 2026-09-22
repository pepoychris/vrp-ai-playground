import { useCallback, useEffect, useState } from 'react';

import { StatusScreen } from './components/StatusScreen';
import { INACTIVE_READINESS, loadReadiness, type Readiness } from './state/readiness';

export function App() {
  const [readiness, setReadiness] = useState<Readiness>(INACTIVE_READINESS);
  const [refreshing, setRefreshing] = useState(false);

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
    />
  );
}
