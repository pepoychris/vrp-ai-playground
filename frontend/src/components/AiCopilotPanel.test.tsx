import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { ScenarioSnapshot } from '../scenario/scenario';
import {
  INITIAL_INSTALL_PROGRESS,
  type AiChatAnswer,
  type AiReport,
  type InstallProgress,
} from '../state/ai-copilot';
import { INACTIVE_AI_STATUS, type AiStatus } from '../state/readiness';
import { AiCopilotPanel } from './AiCopilotPanel';

const noop = () => undefined;

/**
 * Static markup check for one button's disabled state.
 *
 * The panel adds `title` tooltips, so the rendered attribute order is not fixed: matching
 * the label alone would be brittle.
 */
function isButtonDisabled(markup: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<button[^>]*\\bdisabled=""[^>]*>${escaped}</button>`).test(markup);
}

function snapshot(scenarioRevision = 5): ScenarioSnapshot {
  return {
    scenarioId: 's-1',
    scenarioRevision,
    previousRevision: scenarioRevision - 1,
    status: 'READY',
    seed: 20260922,
    graph: { cityId: 'robot-city', graphVersion: 1, nodes: [], edges: [] },
    vehicles: [],
    orders: [],
    barriers: [],
    blockedEdgeIds: [],
    routePlan: null,
    kpis: null,
    simulation: { running: false, speedMultiplier: 1, tick: 0, elapsedSeconds: 0 },
    appliedCommand: null,
    emittedAt: '2026-09-22T09:08:02.140Z',
  };
}

interface Overrides {
  snapshot?: ScenarioSnapshot | null;
  status?: AiStatus;
  statusChecking?: boolean;
  statusError?: string | null;
  install?: InstallProgress;
  installing?: boolean;
  installBusy?: boolean;
  proposalBusy?: boolean;
  error?: string | null;
  notice?: string | null;
  answer?: AiChatAnswer | null;
  answerStale?: boolean;
  report?: AiReport | null;
}

function render(overrides: Overrides = {}): string {
  return renderToStaticMarkup(
    <AiCopilotPanel
      snapshot={overrides.snapshot === undefined ? snapshot() : overrides.snapshot}
      status={overrides.status ?? INACTIVE_AI_STATUS}
      statusChecking={overrides.statusChecking ?? false}
      statusError={overrides.statusError ?? null}
      install={overrides.install ?? INITIAL_INSTALL_PROGRESS}
      installing={overrides.installing ?? false}
      installBusy={overrides.installBusy ?? false}
      activating={false}
      chatBusy={false}
      reportBusy={false}
      proposalBusy={overrides.proposalBusy ?? false}
      error={overrides.error ?? null}
      notice={overrides.notice ?? null}
      answer={overrides.answer ?? null}
      answerStale={overrides.answerStale ?? false}
      report={overrides.report ?? null}
      onRetryStatus={noop}
      onInstall={noop}
      onActivate={noop}
      onAsk={noop}
      onGenerateReport={noop}
      onDownloadReport={noop}
      onConfirmProposal={noop}
      onRejectProposal={noop}
    />,
  );
}

describe('AiCopilotPanel', () => {
  it('separates service, model and core state and never names a model choice', () => {
    const markup = render({
      status: { ...INACTIVE_AI_STATUS, serviceAvailable: true, modelInstalled: true },
    });

    expect(markup).toContain('Service Available');
    expect(markup).toContain('Model Installed');
    expect(markup).toContain('Core Not loaded');
    // The panel reports the AI state without exposing the model list or Ollama itself.
    expect(markup).not.toMatch(/qwen3:\d/i);
    expect(markup).not.toMatch(/ollama/i);
    expect(markup).not.toMatch(/11434/);
    expect(markup).not.toMatch(/<select/i);
  });

  it('offers the install button only while the model is missing', () => {
    const missing = render({ status: INACTIVE_AI_STATUS });
    expect(missing).toContain('>Install Qwen Core</button>');
    expect(isButtonDisabled(missing, 'Install Qwen Core')).toBe(false);

    const installed = render({
      status: { ...INACTIVE_AI_STATUS, serviceAvailable: true, modelInstalled: true },
    });
    expect(isButtonDisabled(installed, 'Install Qwen Core')).toBe(true);
  });

  it('enables the activation as soon as the model is installed but not loaded', () => {
    const markup = render({
      status: { ...INACTIVE_AI_STATUS, serviceAvailable: true, modelInstalled: true },
    });

    expect(markup).toContain('Service Available');
    expect(markup).toContain('Model Installed');
    expect(markup).toContain('Core Not loaded');
    // The reported bug: the button stayed dead while the API said the model was installed.
    expect(isButtonDisabled(markup, 'Activate AI core')).toBe(false);
  });

  it('disables the activation once the core is loaded', () => {
    const markup = render({
      status: {
        ...INACTIVE_AI_STATUS,
        serviceAvailable: true,
        modelInstalled: true,
        modelLoaded: true,
      },
    });

    expect(isButtonDisabled(markup, 'Activate AI core')).toBe(true);
  });

  it('explains a recoverable status read failure and offers a retry', () => {
    const markup = render({ statusError: 'The AI status could not be read: Failed to fetch' });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('The AI status could not be read: Failed to fetch');
    expect(markup).toContain('Retry AI status');
  });

  it('explains an unreachable AI service without claiming the scenario is broken', () => {
    const markup = render({ status: INACTIVE_AI_STATUS });

    expect(markup).toContain('Service Unavailable');
    expect(markup).toContain('The local AI service is not answering');
    expect(markup).toContain('stays fully usable');
    // A failed service probe is a state, not the recoverable read error.
    expect(markup).not.toContain('Retry AI status');
  });

  it('renders the install progress the stream reported', () => {
    const markup = render({
      install: {
        state: 'DOWNLOADING',
        modelName: 'qwen3:4b',
        percent: 42.5,
        statusText: 'pulling 3e4cb1417446',
        error: null,
        eventSeq: 7,
      },
      installing: true,
    });

    expect(markup).toContain('42.5% Downloading');
    expect(markup).toContain('progressbar');
    expect(markup).toContain('aria-valuenow="43"');
    expect(markup).toContain('resumes from this screen if the connection drops');
    // The status text is Ollama's own wording, normalized by the backend.
    expect(markup).toContain('pulling 3e4cb1417446');
  });

  it('shows a retry label and the failure detail after a failed download', () => {
    const markup = render({
      install: {
        state: 'FAILED',
        modelName: 'qwen3:4b',
        percent: null,
        statusText: '',
        error: 'pull access denied',
        eventSeq: 9,
      },
    });

    expect(markup).toContain('Retry Qwen Core install');
    expect(markup).toContain('Download failed');
    expect(markup).toContain('pull access denied');
  });

  it('grounds the chat on the visible revision and hides it without a scenario', () => {
    expect(render()).toContain('Answers are grounded on revision 5');

    const empty = render({ snapshot: null });
    expect(empty).toContain('Create a colony first');
    expect(empty).toMatch(/disabled/);
  });

  it('renders the answer, its grounded fields and the proposal human gate', () => {
    const markup = render({
      answer: {
        answer: 'La ruta de R-01 se recalculo tras la intervencion.',
        usedRevision: 5,
        references: ['kpis.economicCostCents', 'blockedEdgeIds'],
        proposal: {
          proposalId: 'prop-1',
          kind: 'SET_VEHICLE_UNAVAILABLE',
          summary: 'Retirar R-02 por bateria baja.',
          payload: { vehicleId: 'R-02' },
          status: 'PENDING',
          revisionToApply: 5,
        },
        timingsMs: { total: 2841 },
      },
    });

    expect(markup).toContain('Answer · revision 5');
    // The measured latency the backend reported, never an estimate made by the browser.
    expect(markup).toContain('· 2.8 s');
    expect(markup).toContain('La ruta de R-01 se recalculo');
    expect(markup).toContain('kpis.economicCostCents');
    expect(markup).toContain('Take one robot out of service');
    expect(markup).toContain('Retirar R-02 por bateria baja.');
    expect(markup).toContain('target R-02');
    expect(markup).toContain('Confirm and apply');
    expect(markup).toContain('Reject proposal');
    // No action happens before the human confirms it.
    expect(markup).toContain('prop-1');
  });

  it('replaces the gate with the resolved status once a proposal is decided', () => {
    const markup = render({
      answer: {
        answer: 'ok',
        usedRevision: 5,
        references: [],
        proposal: {
          proposalId: 'prop-1',
          kind: 'REQUEST_REOPTIMIZATION',
          summary: 'Recalcular.',
          payload: {},
          status: 'CONFIRMED',
          revisionToApply: 4,
        },
        timingsMs: {},
      },
    });

    expect(markup).toContain('Proposal confirmed.');
    expect(markup).not.toContain('Confirm and apply');
  });

  it('warns when the answer belongs to an older revision', () => {
    const markup = render({
      snapshot: snapshot(9),
      answer: {
        answer: 'ok',
        usedRevision: 5,
        references: [],
        proposal: null,
        timingsMs: {},
      },
      answerStale: true,
    });

    expect(markup).toContain('no longer current');
    expect(markup).toContain('role="alert"');
  });

  it('enables the report download only after a report exists', () => {
    const withoutReport = render();
    expect(withoutReport).toContain('disabled="">Download report (Markdown)</button>');

    const withReport = render({
      report: {
        scenarioRevision: 5,
        generatedAt: '2026-09-22T09:08:02.140Z',
        markdown: '# Turno',
        report: {},
        schemaVersion: '1.0.0',
      },
    });

    expect(withReport).toContain('Schema 1.0.0 · revision 5');
    expect(withReport).toContain('A/B comparison');
  });

  it('renders the AI error and the notice through their live regions', () => {
    const markup = render({
      error: 'The local AI service is not reachable.',
      notice: 'Proposal rejected. No action was executed.',
    });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('The local AI service is not reachable.');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('No action was executed.');
  });

  it('does not call the network while rendering', () => {
    const fetchStub = vi.fn(() => {
      throw new Error('the copilot panel must not fetch while rendering');
    });
    vi.stubGlobal('fetch', fetchStub);

    render();

    expect(fetchStub).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
