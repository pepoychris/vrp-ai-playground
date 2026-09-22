import { useState } from 'react';

import {
  DEFAULT_SEED,
  MAX_ORDERS,
  MAX_VEHICLES,
  MIN_ORDERS,
  MIN_VEHICLES,
  type ScenarioSnapshot,
  routePlanSummary,
} from '../scenario/scenario';

export interface ScenarioControlsProps {
  snapshot: ScenarioSnapshot | null;
  busy: boolean;
  error: string | null;
  onDeployFleet: (count: number, seed: number) => void;
  onGenerateOrders: (count: number, seed: number) => void;
  onOptimize: () => void;
  onReset: () => void;
}

export function ScenarioControls({
  snapshot,
  busy,
  error,
  onDeployFleet,
  onGenerateOrders,
  onOptimize,
  onReset,
}: ScenarioControlsProps) {
  const [vehicleCount, setVehicleCount] = useState(2);
  const [orderCount, setOrderCount] = useState(6);
  const [seed, setSeed] = useState(DEFAULT_SEED);

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
          {snapshot.routePlan && snapshot.kpis && snapshot.routePlan.scenarioRevision === snapshot.scenarioRevision && snapshot.kpis.scenarioRevision === snapshot.scenarioRevision ? (
            <section className="route-summary" aria-label="Route and KPI summary">
              <p className="panel__note">
                {routePlanSummary(snapshot.routePlan).headline} · {routePlanSummary(snapshot.routePlan).detail} · revision {snapshot.scenarioRevision}
              </p>
              <div className="card-grid">
                <article className="robot-card"><strong>{snapshot.kpis.economicCostCents} cents</strong><span>Economic cost</span></article>
                <article className="robot-card"><strong>{snapshot.kpis.distanceTotalMeters.toFixed(0)} m</strong><span>Planned distance</span></article>
                <article className="robot-card"><strong>{snapshot.kpis.ordersUnassigned}</strong><span>Unassigned orders</span></article>
              </div>
              {snapshot.routePlan.vehicles.filter((route) => route.stops.length > 0).map((route) => (
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
