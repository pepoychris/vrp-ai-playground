import type { ReactNode } from 'react';

import type { AiStatus, Readiness, ScenarioStatus } from '../state/readiness';

export interface StatusScreenProps {
  readiness: Readiness;
  refreshing: boolean;
  onRefresh: () => void;
  /** Optional extra panels, such as the fixture readiness and scene preview of Phase 2. */
  scene?: ReactNode;
}

const SCENARIO_LABELS: Record<ScenarioStatus, string> = {
  IDLE: 'Inactive (IDLE)',
  READY: 'Ready',
  OPTIMIZING: 'Optimizing',
  RUNNING: 'Running',
  PAUSED: 'Paused',
};

const API_LABELS: Record<Readiness['api'], string> = {
  checking: 'Checking',
  online: 'Online',
  offline: 'Unavailable',
};

function readinessTone(ready: boolean): string {
  return ready ? 'state state--ok' : 'state state--off';
}

function StatusRow({
  label,
  detail,
  value,
  tone,
}: {
  label: string;
  detail?: string;
  value: string;
  tone: string;
}) {
  return (
    <div className="row">
      <div className="row__term">
        <span className="row__label">{label}</span>
        {detail ? <span className="row__detail">{detail}</span> : null}
      </div>
      <span className={tone}>{value}</span>
    </div>
  );
}

function AiRows({ ai }: { ai: AiStatus }) {
  return (
    <>
      <StatusRow
        label="AI service (Ollama)"
        detail="Reachable from the internal stack network only"
        value={ai.serviceAvailable ? 'Available' : 'Unavailable'}
        tone={readinessTone(ai.serviceAvailable)}
      />
      <StatusRow
        label="Model installed"
        detail={ai.modelName}
        value={ai.modelInstalled ? 'Yes' : 'No'}
        tone={readinessTone(ai.modelInstalled)}
      />
      <StatusRow
        label="Model loaded"
        detail="Loaded only when the user asks for it"
        value={ai.modelLoaded ? 'Yes' : 'No'}
        tone={readinessTone(ai.modelLoaded)}
      />
    </>
  );
}

export function StatusScreen({ readiness, refreshing, onRefresh, scene }: StatusScreenProps) {
  return (
    <div className="screen">
      <header className="screen__header">
        <div>
          <h1>RoboRoute Nexus</h1>
          <p className="screen__subtitle">3D last-mile control tower</p>
        </div>
        <button type="button" className="refresh" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? 'Refreshing' : 'Refresh'}
        </button>
      </header>

      <main className="screen__body">
        <section className="panel" aria-labelledby="system-heading">
          <h2 id="system-heading">System status</h2>
          <StatusRow
            label="API"
            detail="GET /health"
            value={API_LABELS[readiness.api]}
            tone={readinessTone(readiness.api === 'online')}
          />
          <StatusRow
            label="Simulation"
            detail={`${readiness.vehicleCount} vehicles, ${readiness.orderCount} orders`}
            value={readiness.simulationRunning ? 'Running' : 'Stopped'}
            tone={readinessTone(readiness.simulationRunning)}
          />
          <AiRows ai={readiness.ai} />
        </section>

        <section className="panel" aria-labelledby="scenario-heading">
          <h2 id="scenario-heading">Scenario</h2>
          <StatusRow
            label="Status"
            detail={`Revision ${readiness.scenarioRevision}`}
            value={SCENARIO_LABELS[readiness.scenarioStatus]}
            tone="state state--idle"
          />
          <p className="panel__note">
            No active scenario. The city stays inactive with no fleet and no orders
            deployed.
          </p>
        </section>

        <section className="panel panel--quiet" aria-labelledby="notes-heading">
          <h2 id="notes-heading">Notes</h2>
          <ul className="notes">
            <li>The AI model is never downloaded or preloaded without a user action.</li>
            <li>The browser cannot choose the model: the backend fixes it to qwen3:4b.</li>
            <li>This screen only calls GET /health and GET /api/ai/status.</li>
          </ul>
        </section>

        {scene}
      </main>

      <footer className="screen__footer">The control tower is standing by.</footer>
    </div>
  );
}
