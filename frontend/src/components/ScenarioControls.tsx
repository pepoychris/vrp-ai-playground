import { useState } from 'react';

import {
  DEFAULT_SEED,
  MAX_ORDERS,
  MAX_VEHICLES,
  MIN_ORDERS,
  MIN_VEHICLES,
  type ScenarioSnapshot,
} from '../scenario/scenario';

export interface ScenarioControlsProps {
  snapshot: ScenarioSnapshot | null;
  busy: boolean;
  error: string | null;
  onDeployFleet: (count: number, seed: number) => void;
  onGenerateOrders: (count: number, seed: number) => void;
  onReset: () => void;
}

export function ScenarioControls({
  snapshot,
  busy,
  error,
  onDeployFleet,
  onGenerateOrders,
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
        </div>
      ) : (
        <p className="panel__note">No active colony. Deploy a fleet or generate orders to create one.</p>
      )}
    </section>
  );
}
