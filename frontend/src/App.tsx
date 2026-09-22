import { useCallback, useEffect, useState } from 'react';

import { AssetReadinessPanel } from './components/AssetReadinessPanel';
import { SceneStage } from './components/SceneStage';
import { ScenarioControls } from './components/ScenarioControls';
import { StatusScreen } from './components/StatusScreen';
import { createScenario, deployFleet, generateOrders, resetScenario } from './api/client';
import {
  persistScenario,
  readPersistedScenario,
  validateOrderCount,
  validateSeed,
  validateVehicleCount,
  type ScenarioSnapshot,
} from './scenario/scenario';
import { INACTIVE_READINESS, loadReadiness, type Readiness } from './state/readiness';
import { useSceneAssets } from './state/use-scene-assets';

export function App() {
  const [readiness, setReadiness] = useState<Readiness>(INACTIVE_READINESS);
  const [refreshing, setRefreshing] = useState(false);
  const [scenario, setScenario] = useState<ScenarioSnapshot | null>(() => readPersistedScenario());
  const [scenarioBusy, setScenarioBusy] = useState(false);
  const [scenarioError, setScenarioError] = useState<string | null>(null);
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
    persistScenario(scenario);
  }, [scenario]);

  const applyScenarioCommand = useCallback(
    async (action: 'fleet' | 'orders', count: number, seed: number) => {
      const validation = action === 'fleet' ? validateVehicleCount(count) : validateOrderCount(count);
      const seedError = validateSeed(seed);
      if (validation || seedError) {
        setScenarioError(validation ?? seedError);
        return;
      }
      setScenarioBusy(true);
      setScenarioError(null);
      try {
        let active = scenario;
        if (!active || active.seed !== seed) {
          active = await createScenario<ScenarioSnapshot>(seed);
        }
        const next = action === 'fleet'
          ? await deployFleet<ScenarioSnapshot>(active.scenarioId, count)
          : await generateOrders<ScenarioSnapshot>(active.scenarioId, count);
        setScenario(next);
      } catch (error) {
        setScenarioError(error instanceof Error ? error.message : 'Scenario command failed.');
      } finally {
        setScenarioBusy(false);
      }
    },
    [scenario],
  );

  const handleReset = useCallback(async () => {
    if (!scenario) return;
    setScenarioBusy(true);
    setScenarioError(null);
    try {
      await resetScenario(scenario.scenarioId);
      setScenario(null);
    } catch (error) {
      setScenarioError(error instanceof Error ? error.message : 'Reset failed.');
    } finally {
      setScenarioBusy(false);
    }
  }, [scenario]);

  const displayReadiness = scenario
    ? {
        ...readiness,
        scenarioStatus: scenario.status,
        scenarioRevision: scenario.scenarioRevision,
        vehicleCount: scenario.vehicles.length,
        orderCount: scenario.orders.length,
        simulationRunning: scenario.simulation.running,
      }
    : readiness;

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  return (
    <StatusScreen
      readiness={displayReadiness}
      refreshing={refreshing}
      onRefresh={() => {
        void refresh();
      }}
      scene={
        <>
          <ScenarioControls
            snapshot={scenario}
            busy={scenarioBusy}
            error={scenarioError}
            onDeployFleet={(count, seed) => void applyScenarioCommand('fleet', count, seed)}
            onGenerateOrders={(count, seed) => void applyScenarioCommand('orders', count, seed)}
            onReset={() => void handleReset()}
          />
          <AssetReadinessPanel readiness={assetReadiness} onReload={reload} />
          <SceneStage bundle={bundle} />
        </>
      }
    />
  );
}
