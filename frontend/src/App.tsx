import { useCallback, useEffect, useRef, useState } from 'react';

import { AssetReadinessPanel } from './components/AssetReadinessPanel';
import { SceneStage } from './components/SceneStage';
import { ScenarioControls } from './components/ScenarioControls';
import { StatusScreen } from './components/StatusScreen';
import {
  createScenario,
  createCommandId,
  deployFleet,
  generateOrders,
  optimizeScenario,
  pauseSimulation,
  relocateVehicle,
  resetScenario,
  startSimulation,
} from './api/client';
import type { CityPoint } from './city/dataset';
import {
  acceptCommandResponse,
  acceptSnapshot,
  beginCommand,
  createRevisionGuard,
  settleCommand,
} from './scenario/revision-guard';
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
  // One guard per session: it keeps the highest applied revision and drops stale
  // payloads without ever showing them to the user as an error.
  const guardRef = useRef(createRevisionGuard());

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

  /**
   * Apply a snapshot that answers a command.
   *
   * The frozen rules apply: a payload with a lower revision is discarded, and a response
   * whose `commandId` is not the pending one is discarded too. A discard is not an error.
   */
  const applyCommandResponse = useCallback(
    (next: ScenarioSnapshot, expectedCommandId: string | null) => {
      const decision = acceptCommandResponse(guardRef.current, next, expectedCommandId);
      guardRef.current = decision.state;
      if (!decision.accepted) return false;
      setScenario(next);
      return true;
    },
    [],
  );

  const applyFetchedSnapshot = useCallback((next: ScenarioSnapshot) => {
    const decision = acceptSnapshot(guardRef.current, next);
    guardRef.current = decision.state;
    if (!decision.accepted) return false;
    setScenario(next);
    return true;
  }, []);

  const runCommand = useCallback(
    async (commandId: string | null, action: () => Promise<ScenarioSnapshot>) => {
      if (commandId) guardRef.current = beginCommand(guardRef.current, commandId);
      setScenarioBusy(true);
      setScenarioError(null);
      try {
        const next = await action();
        applyCommandResponse(next, commandId);
      } catch (error) {
        setScenarioError(error instanceof Error ? error.message : 'Scenario command failed.');
      } finally {
        guardRef.current = settleCommand(guardRef.current, commandId);
        setScenarioBusy(false);
      }
    },
    [applyCommandResponse],
  );

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
          applyFetchedSnapshot(active);
        }
        const next = action === 'fleet'
          ? await deployFleet<ScenarioSnapshot>(active.scenarioId, count)
          : await generateOrders<ScenarioSnapshot>(active.scenarioId, count);
        applyFetchedSnapshot(next);
      } catch (error) {
        setScenarioError(error instanceof Error ? error.message : 'Scenario command failed.');
      } finally {
        setScenarioBusy(false);
      }
    },
    [applyFetchedSnapshot, scenario],
  );

  const handleReset = useCallback(async () => {
    if (!scenario) return;
    setScenarioBusy(true);
    setScenarioError(null);
    try {
      await resetScenario(scenario.scenarioId);
      guardRef.current = createRevisionGuard();
      setScenario(null);
    } catch (error) {
      setScenarioError(error instanceof Error ? error.message : 'Reset failed.');
    } finally {
      setScenarioBusy(false);
    }
  }, [scenario]);

  const handleOptimize = useCallback(async () => {
    if (!scenario) return;
    const commandId = createCommandId();
    await runCommand(commandId, () =>
      optimizeScenario<ScenarioSnapshot>(scenario.scenarioId, scenario.scenarioRevision, {
        commandId,
      }),
    );
  }, [runCommand, scenario]);

  const handleStartSimulation = useCallback(
    async (speedMultiplier: number) => {
      if (!scenario) return;
      const commandId = createCommandId();
      await runCommand(commandId, () =>
        startSimulation<ScenarioSnapshot>(
          scenario.scenarioId,
          scenario.scenarioRevision,
          speedMultiplier,
          { commandId },
        ),
      );
    },
    [runCommand, scenario],
  );

  const handlePauseSimulation = useCallback(async () => {
    if (!scenario) return;
    const commandId = createCommandId();
    await runCommand(commandId, () =>
      pauseSimulation<ScenarioSnapshot>(scenario.scenarioId, scenario.scenarioRevision, {
        commandId,
      }),
    );
  }, [runCommand, scenario]);

  /**
   * One claw drop, called once per accepted release.
   *
   * The server snaps the point and re-plans once. An out-of-radius drop answers 422 and
   * publishes nothing, so the local view simply keeps the vehicle on its node.
   */
  const handleRelocateVehicle = useCallback(
    async (vehicleId: string, position: CityPoint) => {
      if (!scenario) return;
      const commandId = createCommandId();
      await runCommand(commandId, () =>
        relocateVehicle<ScenarioSnapshot>(
          scenario.scenarioId,
          vehicleId,
          { x: position.x, y: position.y, z: position.z },
          scenario.scenarioRevision,
          { commandId },
        ),
      );
    },
    [runCommand, scenario],
  );

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
            onOptimize={() => void handleOptimize()}
            onStartSimulation={(speedMultiplier) => void handleStartSimulation(speedMultiplier)}
            onPauseSimulation={() => void handlePauseSimulation()}
            onReset={() => void handleReset()}
          />
          <AssetReadinessPanel readiness={assetReadiness} onReload={reload} />
          <SceneStage
            bundle={bundle}
            snapshot={scenario}
            onRelocateVehicle={(vehicleId, position) => void handleRelocateVehicle(vehicleId, position)}
          />
        </>
      }
    />
  );
}
