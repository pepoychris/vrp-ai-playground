import { describe, expect, it } from 'vitest';

import {
  INITIAL_INSTALL_PROGRESS,
  aiReadinessCopy,
  canActivateCore,
  describeAnswerTimings,
  describeAiError,
  describeProposalKind,
  installProgressDetail,
  installProgressLabel,
  installProgressFromStatus,
  installProgressRatio,
  isInstallTerminal,
  isInstalling,
  mergeAiStatus,
  parseAiProposal,
  parseChatResponse,
  parseInstallEvent,
  parseShiftReport,
  proposalTarget,
  reduceInstallProgress,
  reportDownload,
  reportFileName,
  type InstallProgress,
} from './ai-copilot';
import { FIXED_MODEL_NAME, INACTIVE_AI_STATUS, type AiStatus } from './readiness';

function frame(payload: unknown, eventSeq = 1): unknown {
  return { type: 'ai.install', eventSeq, payload };
}

function progress(overrides: Partial<InstallProgress> = {}): InstallProgress {
  return { ...INITIAL_INSTALL_PROGRESS, ...overrides };
}

function aiStatus(overrides: Partial<AiStatus> = {}): AiStatus {
  return { ...INACTIVE_AI_STATUS, ...overrides };
}

function completedJob() {
  return {
    jobId: 'job-1',
    state: 'COMPLETED',
    modelName: FIXED_MODEL_NAME,
    startedAt: '2026-09-22T09:00:00.000Z',
    finishedAt: '2026-09-22T09:05:00.000Z',
  };
}

describe('install progress', () => {
  it('parses a normalized frame and keeps the fixed model when it is absent', () => {
    const parsed = parseInstallEvent(
      frame({ state: 'DOWNLOADING', percent: 42.5, statusText: 'pulling 3e4cb1417446' }),
    );

    expect(parsed).toMatchObject({
      state: 'DOWNLOADING',
      modelName: 'qwen3:4b',
      percent: 42.5,
      statusText: 'pulling 3e4cb1417446',
      error: null,
      eventSeq: 1,
    });
  });

  it('clamps an out-of-range percentage into 0..100', () => {
    expect(parseInstallEvent(frame({ state: 'DOWNLOADING', percent: 140 }))?.percent).toBe(100);
    expect(parseInstallEvent(frame({ state: 'DOWNLOADING', percent: -5 }))?.percent).toBe(0);
  });

  it('round-trips a failure so the panel can explain it', () => {
    const parsed = parseInstallEvent(
      frame({ state: 'FAILED', percent: null, statusText: '', error: 'pull failed' }),
    );

    expect(parsed?.state).toBe('FAILED');
    expect(parsed?.error).toBe('pull failed');
    expect(installProgressDetail(progress({ state: 'FAILED', error: 'pull failed' }))).toBe(
      'pull failed',
    );
  });

  it('ignores anything that is not a well-formed ai.install frame', () => {
    expect(parseInstallEvent(null)).toBeNull();
    expect(parseInstallEvent('ai.install')).toBeNull();
    expect(parseInstallEvent({ type: 'ai.status', payload: { state: 'IDLE' } })).toBeNull();
    expect(parseInstallEvent(frame({ state: 'SOMETHING_ELSE' }))).toBeNull();
    expect(parseInstallEvent(frame(null))).toBeNull();
  });

  it('never moves the progress backwards when a frame is replayed or reordered', () => {
    const current = progress({ state: 'DOWNLOADING', percent: 60, eventSeq: 7 });

    expect(reduceInstallProgress(current, progress({ state: 'IDLE', eventSeq: 3 }))).toBe(current);
    expect(reduceInstallProgress(current, progress({ state: 'DOWNLOADING', eventSeq: 7 }))).toBe(
      current,
    );

    const newer = progress({ state: 'VERIFYING', percent: 100, eventSeq: 8 });
    expect(reduceInstallProgress(current, newer)).toBe(newer);
  });

  it('classifies the running and terminal states', () => {
    expect(isInstalling(progress({ state: 'DOWNLOADING' }))).toBe(true);
    expect(isInstalling(progress({ state: 'VERIFYING' }))).toBe(true);
    expect(isInstalling(progress({ state: 'IDLE' }))).toBe(false);
    expect(isInstallTerminal(progress({ state: 'COMPLETED' }))).toBe(true);
    expect(isInstallTerminal(progress({ state: 'FAILED' }))).toBe(true);
    expect(isInstallTerminal(progress({ state: 'DOWNLOADING' }))).toBe(false);
  });

  it('turns the state into a bar ratio and a human label', () => {
    expect(installProgressRatio(progress({ state: 'DOWNLOADING', percent: 25 }))).toBe(0.25);
    // A completed job with no percentage still renders a full bar.
    expect(installProgressRatio(progress({ state: 'COMPLETED', percent: null }))).toBe(1);
    expect(installProgressRatio(progress({ state: 'IDLE', percent: null }))).toBeNull();

    expect(installProgressLabel(progress({ state: 'IDLE' }))).toBe('Not started');
    expect(
      installProgressLabel(progress({ state: 'DOWNLOADING', percent: 42.5, statusText: 'pull' })),
    ).toBe('42.5% Downloading · pull');
    expect(installProgressLabel(progress({ state: 'COMPLETED' }))).toBe('Installed');
    expect(installProgressLabel(progress({ state: 'FAILED' }))).toBe('Download failed');
  });
});

describe('chat envelopes', () => {
  it('parses a grounded answer and keeps only string references', () => {
    const parsed = parseChatResponse({
      answer: 'La ruta cambio por la barrera B-1.',
      usedRevision: 5,
      references: ['kpis.economicCostCents', 7, null, 'blockedEdgeIds'],
      proposal: null,
      timingsMs: { total: 2841, load: 'nope', eval: 2100 },
    });

    expect(parsed).toMatchObject({
      answer: 'La ruta cambio por la barrera B-1.',
      usedRevision: 5,
      references: ['kpis.economicCostCents', 'blockedEdgeIds'],
      proposal: null,
      timingsMs: { total: 2841, eval: 2100 },
    });
  });

  it('rejects an envelope with no usable answer or revision', () => {
    expect(parseChatResponse(null)).toBeNull();
    expect(parseChatResponse({ usedRevision: 1 })).toBeNull();
    expect(parseChatResponse({ answer: 'x' })).toBeNull();
    expect(parseChatResponse({ answer: '', usedRevision: 1 })).toBeNull();
  });

  it('treats a malformed embedded proposal as no proposal', () => {
    const parsed = parseChatResponse({
      answer: 'ok',
      usedRevision: 2,
      references: [],
      proposal: { proposalId: 'p-1', kind: 'TELEPORT_VEHICLE', summary: 's', status: 'PENDING' },
    });

    expect(parsed?.proposal).toBeNull();
  });

  it('parses a pending proposal and exposes its target', () => {
    const proposal = parseAiProposal({
      proposalId: 'prop-1',
      kind: 'SET_VEHICLE_UNAVAILABLE',
      summary: 'Retirar R-02 por bateria baja.',
      payload: { vehicleId: 'R-02' },
      status: 'PENDING',
      revisionToApply: 5,
    });

    expect(proposal).toMatchObject({ kind: 'SET_VEHICLE_UNAVAILABLE', status: 'PENDING' });
    expect(proposal && proposalTarget(proposal)).toBe('R-02');
    expect(proposalTarget({ ...proposal!, payload: {} })).toBeNull();
    expect(describeProposalKind('REQUEST_REOPTIMIZATION')).toBe('Recompute the plan');
  });

  it('rejects a proposal whose status or id is missing', () => {
    expect(parseAiProposal({ proposalId: '', kind: 'DELAY_VEHICLE', summary: 's', status: 'PENDING' })).toBeNull();
    expect(parseAiProposal({ proposalId: 'p', kind: 'DELAY_VEHICLE', summary: 's', status: 'MAYBE' })).toBeNull();
    expect(parseAiProposal({ proposalId: 'p', kind: 'DELAY_VEHICLE', summary: '', status: 'PENDING' })).toBeNull();
  });
});

describe('shift reports', () => {
  const report = {
    scenarioRevision: 5,
    generatedAt: '2026-09-22T09:08:02.140Z',
    markdown: '# Turno\n\nSin incidencias.',
    report: { summary: 'ok' },
    schemaVersion: '1.0.0',
  };

  it('parses the frozen report envelope', () => {
    expect(parseShiftReport(report)).toMatchObject({
      scenarioRevision: 5,
      schemaVersion: '1.0.0',
    });
  });

  it('rejects a report that is missing a required field', () => {
    expect(parseShiftReport(null)).toBeNull();
    expect(parseShiftReport({ ...report, markdown: '' })).toBeNull();
    expect(parseShiftReport({ ...report, generatedAt: undefined })).toBeNull();
    expect(parseShiftReport({ ...report, schemaVersion: 1 })).toBeNull();
  });

  it('names the download after the revision it describes', () => {
    const parsed = parseShiftReport(report)!;

    expect(reportFileName(parsed)).toBe('roboroute-shift-report-r5.md');
    expect(reportDownload(parsed)).toEqual({
      fileName: 'roboroute-shift-report-r5.md',
      content: report.markdown,
    });
  });
});

describe('error copy', () => {
  it('translates the frozen error codes into an explanation', () => {
    expect(describeAiError('AI_MODEL_NOT_INSTALLED', 'fallback')).toMatch(/Install Qwen Core/);
    expect(describeAiError('AI_OUTPUT_INVALID', 'fallback')).toMatch(/contract rejects/);
    expect(describeAiError('MODEL_OVERRIDE_FORBIDDEN', 'fallback')).toMatch(/fixed/);
  });

  it('falls back to the backend message for an unknown code', () => {
    expect(describeAiError('SOMETHING_NEW', 'the backend said so')).toBe('the backend said so');
    expect(describeAiError(null, 'the backend said so')).toBe('the backend said so');
  });

  it('never leaks a model choice or an Ollama URL in the status copy', () => {
    const copy = aiReadinessCopy({
      ...INACTIVE_AI_STATUS,
      serviceAvailable: true,
      modelInstalled: true,
    });

    expect(copy).toEqual({ service: 'Available', installed: 'Installed', loaded: 'Not loaded' });
    expect(Object.values(copy).join(' ')).not.toMatch(/qwen|ollama|11434/i);
  });
});

describe('authoritative status synchronization', () => {
  it('adopts the model the backend reports as installed', () => {
    const merged = mergeAiStatus(
      INACTIVE_AI_STATUS,
      aiStatus({ serviceAvailable: true, modelInstalled: true }),
    );

    expect(merged).toMatchObject({
      serviceAvailable: true,
      modelInstalled: true,
      modelLoaded: false,
    });
    // The reported bug: Available + Installed + Not loaded must activate.
    expect(canActivateCore(merged)).toBe(true);
  });

  it('never lets a delayed frame un-install or un-load a confirmed model', () => {
    const confirmed = aiStatus({
      serviceAvailable: true,
      modelInstalled: true,
      modelLoaded: true,
    });

    const stale = mergeAiStatus(confirmed, aiStatus({ serviceAvailable: true }));

    expect(stale.modelInstalled).toBe(true);
    expect(stale.modelLoaded).toBe(true);
    expect(canActivateCore(stale)).toBe(false);
  });

  it('keeps the last known model state when the service stops answering', () => {
    const confirmed = mergeAiStatus(
      INACTIVE_AI_STATUS,
      aiStatus({ serviceAvailable: true, modelInstalled: true }),
    );

    const offline = mergeAiStatus(confirmed, aiStatus());

    expect(offline.serviceAvailable).toBe(false);
    // An unreachable service says nothing about what is on disk.
    expect(offline.modelInstalled).toBe(true);
    expect(offline.modelName).toBe(FIXED_MODEL_NAME);
  });

  it('seeds the terminal install state a reloaded page never streamed', () => {
    const seeded = installProgressFromStatus(
      aiStatus({ serviceAvailable: true, modelInstalled: true, installJob: completedJob() }),
      progress(),
    );

    expect(seeded.state).toBe('COMPLETED');
    expect(seeded.percent).toBe(100);
    expect(installProgressLabel(seeded)).toBe('Installed');
    expect(installProgressRatio(seeded)).toBe(1);
  });

  it('never replaces progress the stream already owns', () => {
    const live = progress({ state: 'DOWNLOADING', percent: 42.5, eventSeq: 7 });
    const seeded = installProgressFromStatus(
      aiStatus({ serviceAvailable: true, installJob: completedJob() }),
      live,
    );

    expect(seeded).toBe(live);
  });

  it('seeds a running job and a failed job from the status summary', () => {
    const running = installProgressFromStatus(
      aiStatus({
        serviceAvailable: true,
        installJob: { ...completedJob(), state: 'DOWNLOADING', finishedAt: null },
      }),
      progress(),
    );
    expect(running.state).toBe('DOWNLOADING');

    const failed = installProgressFromStatus(
      aiStatus({
        serviceAvailable: true,
        installJob: { ...completedJob(), state: 'FAILED', finishedAt: null },
      }),
      progress(),
    );
    expect(failed.state).toBe('FAILED');
    expect(installProgressDetail(failed)).toMatch(/start it again/);
  });

  it('ignores an absent or unknown job without disturbing the panel', () => {
    const idle = progress();

    expect(installProgressFromStatus(aiStatus(), idle)).toBe(idle);
    expect(
      installProgressFromStatus(
        aiStatus({ installJob: { ...completedJob(), state: 'SOMETHING_ELSE' } }),
        idle,
      ),
    ).toBe(idle);
  });

  it('reports the measured answer latency, and nothing when it is unusable', () => {
    expect(describeAnswerTimings({ total: 2841 })).toBe('2.8 s');
    expect(describeAnswerTimings({})).toBeNull();
    expect(describeAnswerTimings({ total: 0 })).toBeNull();
    expect(describeAnswerTimings({ total: Number.NaN })).toBeNull();
  });

  it('requires an installed model before the core can be activated', () => {
    expect(canActivateCore(aiStatus())).toBe(false);
    expect(canActivateCore(aiStatus({ modelInstalled: true }))).toBe(true);
    expect(canActivateCore(aiStatus({ modelInstalled: true, modelLoaded: true }))).toBe(false);
  });
});
