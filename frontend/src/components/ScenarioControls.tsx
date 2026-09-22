import { useState } from 'react';

import {
  DEFAULT_SEED,
  MAX_BARRIERS,
  MAX_ORDERS,
  MAX_VEHICLES,
  MIN_ORDERS,
  MIN_VEHICLES,
  type ScenarioSnapshot,
  routePlanSummary,
} from '../scenario/scenario';
import { barrierImpact, describeBarrierImpactReason } from '../scenario/barriers';
import {
  DEFAULT_SIMULATION_SPEED,
  SIMULATION_SPEED_CHOICES,
  currentRoutePlan,
  simulationClockLabel,
} from '../scenario/simulation';

export interface ScenarioControlsProps {
  snapshot: ScenarioSnapshot | null;
  busy: boolean;
  error: string | null;
  /** True while the closure tool is armed: the next drag closes one road edge. */
  barrierToolArmed: boolean;
  selectedBarrierId: string | null;
  onDeployFleet: (count: number, seed: number) => void;
  onGenerateOrders: (count: number, seed: number) => void;
  onOptimize: () => void;
  onStartSimulation: (speedMultiplier: number) => void;
  onPauseSimulation: () => void;
  onToggleBarrierTool: () => void;
  onSelectBarrier: (barrierId: string | null) => void;
  onRemoveBarrier: (barrierId: string) => void;
  onReset: () => void;
}

export function ScenarioControls({
  snapshot,
  busy,
  error,
  barrierToolArmed,
  selectedBarrierId,
  onDeployFleet,
  onGenerateOrders,
  onOptimize,
  onStartSimulation,
  onPauseSimulation,
  onToggleBarrierTool,
  onSelectBarrier,
  onRemoveBarrier,
  onReset,
}: ScenarioControlsProps) {
  const [vehicleCount, setVehicleCount] = useState(2);
  const [orderCount, setOrderCount] = useState(6);
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [speedMultiplier, setSpeedMultiplier] = useState<number>(DEFAULT_SIMULATION_SPEED);

  const plan = snapshot ? currentRoutePlan(snapshot) : null;
  const running = Boolean(snapshot?.simulation.running);
  const canSimulate = Boolean(snapshot && snapshot.vehicles.length > 0);
  const closures = snapshot?.barriers ?? [];
  const closureLimitReached = closures.length >= MAX_BARRIERS;
  const impact = snapshot ? barrierImpact(snapshot) : null;

  return (
    <section className="panel scenario-controls" aria-labelledby="scenario-controls-heading">
      <h2 id="scenario-controls-heading">Colony controls</h2>
      <div className="control-grid">
        <label>
          Vehicles
          <input aria-label="Vehicle count" type="number" min={MIN_VEHICLES} max={MAX_VEHICLES} value={vehicleCount} onChange={(event) => setVehicleCount(Number(event.target.value))} />
        </label>
        <label>
          Orders
          <input aria-label="Order count" type="number" min={MIN_ORDERS} max={MAX_ORDERS} value={orderCount} onChange={(event) => setOrderCount(Number(event.target.value))} />
        </label>
        <label>
          Seed
          <input aria-label="Scenario seed" type="number" min={0} max={0xffffffff} value={seed} onChange={(event) => setSeed(Number(event.target.value))} />
        </label>
      </div>
      <div className="button-row">
        <button type="button" className="refresh" disabled={busy} onClick={() => onDeployFleet(vehicleCount, seed)}>
          Deploy Fleet
        </button>
        <button type="button" className="refresh" disabled={busy} onClick={() => onGenerateOrders(orderCount, seed)}>
          Generate Orders
        </button>
        <button type="button" className="refresh" disabled={busy || !snapshot || snapshot.vehicles.length === 0 || snapshot.orders.length === 0} onClick={onOptimize}>
          Optimize Routes
        </button>
        <button type="button" className="refresh" disabled={busy || !snapshot} onClick={onReset}>
          Reset Colony
        </button>
      </div>
      <div className="control-grid simulation-controls">
        <label>
          Simulation speed
          <select
            aria-label="Simulation speed"
            value={speedMultiplier}
            onChange={(event) => setSpeedMultiplier(Number(event.target.value))}
            disabled={busy || !canSimulate}
          >
            {SIMULATION_SPEED_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                x{choice}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="button-row">
        <button
          type="button"
          className="refresh"
          disabled={
            busy ||
            !canSimulate ||
            (running && speedMultiplier === snapshot?.simulation.speedMultiplier)
          }
          onClick={() => onStartSimulation(speedMultiplier)}
        >
          {running
            ? 'Apply Speed'
            : snapshot && snapshot.simulation.tick > 0
              ? 'Resume Simulation'
              : 'Start Simulation'}
        </button>
        <button
          type="button"
          className="refresh"
          disabled={busy || !running}
          onClick={onPauseSimulation}
        >
          Pause Simulation
        </button>
      </div>
      {snapshot ? (
        <p className="panel__note">{simulationClockLabel(snapshot.simulation)}</p>
      ) : null}
      <section className="closure-tools" aria-label="Road closures">
        <h3 className="closure-tools__heading">Robotic barriers</h3>
        <div className="button-row">
          <button
            type="button"
            className={barrierToolArmed ? 'refresh refresh--armed' : 'refresh'}
            aria-pressed={barrierToolArmed}
            disabled={busy || !snapshot}
            onClick={onToggleBarrierTool}
          >
            {barrierToolArmed ? 'Closure tool armed' : 'Arm closure tool'}
          </button>
        </div>
        <p className="panel__note">
          {barrierToolArmed
            ? 'Drag on the city to close the nearest road edge; the preview turns green on a ' +
              'valid road and red when no road is close enough. Esc cancels the drag.'
            : 'Arm the tool, then drag on the city to drop one barrier on a road edge. A ' +
              'closure blocks the road in both directions.'}
        </p>
        {closureLimitReached ? (
          <p className="panel__note">
            {MAX_BARRIERS} of {MAX_BARRIERS} closures active · remove one to close another road.
          </p>
        ) : null}
        {closures.length > 0 ? (
          <ul className="closure-list" aria-label="Active road closures">
            {closures.map((barrier) => {
              const selected = barrier.barrierId === selectedBarrierId;
              return (
                <li
                  className={selected ? 'closure-card closure-card--selected' : 'closure-card'}
                  key={barrier.barrierId}
                >
                  <button
                    type="button"
                    className="closure-card__select"
                    aria-pressed={selected}
                    onClick={() => onSelectBarrier(selected ? null : barrier.barrierId)}
                  >
                    <strong>{barrier.barrierId}</strong>
                    <span>Road {barrier.blockedEdgeId} · both directions</span>
                    <span>Placed at revision {barrier.placedAtRevision}</span>
                  </button>
                  <button
                    type="button"
                    className="refresh closure-card__remove"
                    disabled={busy}
                    onClick={() => onRemoveBarrier(barrier.barrierId)}
                  >
                    Reopen road
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="panel__note">No road closures.</p>
        )}
        {impact?.active ? (
          <div className="closure-impact" role="status" aria-label="Closure impact">
            <p className="panel__note">
              {impact.edgeIds.length} closed road{impact.edgeIds.length === 1 ? '' : 's'} ·{' '}
              {impact.vehicles.length} affected vehicle
              {impact.vehicles.length === 1 ? '' : 's'} · {impact.orders.length} affected order
              {impact.orders.length === 1 ? '' : 's'}
            </p>
            {impact.orders.map((order) => (
              <p className="panel__note" key={order.orderId}>
                {order.orderId}: {describeBarrierImpactReason(order.reason)}
              </p>
            ))}
          </div>
        ) : null}
      </section>
      {busy ? <p className="panel__note">Applying scenario command…</p> : null}
      {error ? <p className="panel__error" role="alert">{error}</p> : null}
      {snapshot ? (
        <div className="scenario-summary">
          <p className="panel__note">Seed {snapshot.seed} · Revision {snapshot.scenarioRevision}</p>
          <div className="card-grid" aria-label="Fleet cards">
            {snapshot.vehicles.map((vehicle) => (
              <article className="robot-card" key={vehicle.vehicleId}>
                <strong>{vehicle.vehicleId}</strong>
                <span>Robot · {vehicle.status}</span>
                <span>Inventory {vehicle.loadKilograms.toFixed(1)} / {vehicle.capacityKilograms.toFixed(1)} kg</span>
                <span>Capacity {vehicle.capacityCubicMeters.toFixed(2)} m³</span>
                <span>Energy {vehicle.batteryPercent.toFixed(0)}%</span>
              </article>
            ))}
          </div>
          {snapshot.orders.length > 0 ? <p className="panel__note">{snapshot.orders.length} orders on reachable delivery nodes.</p> : null}
          {plan && snapshot.kpis && snapshot.kpis.scenarioRevision === snapshot.scenarioRevision ? (
            <section className="route-summary" aria-label="Route and KPI summary">
              <p className="panel__note">
                {routePlanSummary(plan).headline} · {routePlanSummary(plan).detail} · revision {snapshot.scenarioRevision}
              </p>
              <div className="card-grid">
                <article className="robot-card"><strong>{snapshot.kpis.economicCostCents} cents</strong><span>Economic cost</span></article>
                <article className="robot-card"><strong>{snapshot.kpis.distanceTotalMeters.toFixed(0)} m</strong><span>Planned distance</span></article>
                <article className="robot-card"><strong>{snapshot.kpis.ordersUnassigned}</strong><span>Unassigned orders</span></article>
              </div>
              {plan.vehicles.filter((route) => route.stops.length > 0).map((route) => (
                <p className="panel__note" key={route.vehicleId}>
                  {route.vehicleId}: {route.stops.length} stops · {route.distanceMeters.toFixed(0)} m · {route.driveSeconds}s
                </p>
              ))}
            </section>
          ) : null}
        </div>
      ) : (
        <p className="panel__note">No active colony. Deploy a fleet or generate orders to create one.</p>
      )}
    </section>
  );
}
