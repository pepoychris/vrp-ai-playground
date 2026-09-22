import { readinessSummary, type AssetReadinessState } from '../state/asset-readiness';

export interface AssetReadinessPanelProps {
  readiness: AssetReadinessState;
  onReload: () => void;
}

const STATUS_LABELS: Record<AssetReadinessState['status'], string> = {
  idle: 'Waiting',
  loading: 'Loading',
  ready: 'Ready',
  degraded: 'Degraded',
  failed: 'Unavailable',
};

const STATUS_TONES: Record<AssetReadinessState['status'], string> = {
  idle: 'state state--idle',
  loading: 'state state--loading',
  ready: 'state state--ok',
  degraded: 'state state--degraded',
  failed: 'state state--off',
};

export function AssetReadinessPanel({ readiness, onReload }: AssetReadinessPanelProps) {
  const percent = Math.round(Math.min(Math.max(readiness.ratio, 0), 1) * 100);
  const busy = readiness.status === 'loading' || readiness.status === 'idle';

  return (
    <section className="panel" aria-labelledby="assets-heading">
      <h2 id="assets-heading">3D assets</h2>
      <div className="row">
        <div className="row__term">
          <span className="row__label">Fixture library</span>
          <span className="row__detail">Local fixtures served from this origin</span>
        </div>
        <span className={STATUS_TONES[readiness.status]}>{STATUS_LABELS[readiness.status]}</span>
      </div>

      <div
        className="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Fixture asset loading progress"
      >
        <span className="progress__fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="panel__note">{readinessSummary(readiness)}</p>

      {readiness.error ? <p className="panel__error">{readiness.error}</p> : null}

      {readiness.failures.length > 0 ? (
        <ul className="notes notes--error">
          {readiness.failures.map((failure) => (
            <li key={failure.id}>
              {failure.id}: {failure.reason}
            </li>
          ))}
        </ul>
      ) : null}

      <button type="button" className="refresh refresh--inline" onClick={onReload} disabled={busy}>
        {busy ? 'Loading assets' : 'Reload assets'}
      </button>
    </section>
  );
}
