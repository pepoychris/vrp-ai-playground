/**
 * Pure state helpers for the local AI copilot.
 *
 * Everything here is data in, data out: the install-progress reducer, the parsing of the
 * AI envelopes and the copy the panel shows. Keeping it out of React means the recovery
 * logic (a reconnect replays the current install state) is testable without a DOM.
 *
 * The browser never chooses the model, never talks to Ollama and never invents a metric:
 * it renders what the backend validated.
 */

import { FIXED_MODEL_NAME, type AiStatus } from './readiness';

export type InstallState = 'IDLE' | 'DOWNLOADING' | 'VERIFYING' | 'COMPLETED' | 'FAILED';

export const INSTALLING_STATES: readonly InstallState[] = ['DOWNLOADING', 'VERIFYING'];

export interface InstallProgress {
  state: InstallState;
  modelName: string;
  percent: number | null;
  statusText: string;
  error: string | null;
  /** Sequence of the last applied frame, so a replayed or out-of-order frame is ignored. */
  eventSeq: number;
}

export const INITIAL_INSTALL_PROGRESS: InstallProgress = {
  state: 'IDLE',
  modelName: FIXED_MODEL_NAME,
  percent: null,
  statusText: 'Not started',
  error: null,
  eventSeq: -1,
};

const INSTALL_STATES: readonly InstallState[] = [
  'IDLE',
  'DOWNLOADING',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
];

function asInstallState(value: unknown): InstallState | null {
  return typeof value === 'string' && (INSTALL_STATES as readonly string[]).includes(value)
    ? (value as InstallState)
    : null;
}

function asPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

/**
 * Read one `ai.install` SSE payload.
 *
 * Returns `null` for anything that is not a well-formed frame, so a malformed event can
 * never blank the progress the user is already looking at.
 */
export function parseInstallEvent(raw: unknown): InstallProgress | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const envelope = raw as { type?: unknown; eventSeq?: unknown; payload?: unknown };
  if (envelope.type !== 'ai.install') return null;
  const payload = envelope.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const body = payload as Record<string, unknown>;
  const state = asInstallState(body.state);
  if (state === null) return null;
  return {
    state,
    modelName: typeof body.modelName === 'string' ? body.modelName : FIXED_MODEL_NAME,
    percent: asPercent(body.percent),
    statusText: typeof body.statusText === 'string' ? body.statusText : '',
    error: typeof body.error === 'string' && body.error ? body.error : null,
    eventSeq: typeof envelope.eventSeq === 'number' ? envelope.eventSeq : -1,
  };
}

/**
 * Apply one install frame.
 *
 * Frames are ordered by `eventSeq`, so the stream can be reconnected, replayed or
 * delivered out of order without ever moving the progress bar backwards.
 */
export function reduceInstallProgress(
  current: InstallProgress,
  next: InstallProgress,
): InstallProgress {
  if (next.eventSeq >= 0 && next.eventSeq <= current.eventSeq) return current;
  return next;
}

export function isInstalling(progress: InstallProgress): boolean {
  return INSTALLING_STATES.includes(progress.state);
}

export function isInstallTerminal(progress: InstallProgress): boolean {
  return progress.state === 'COMPLETED' || progress.state === 'FAILED';
}

/** A 0..1 ratio for the progress bar, or `null` while the backend cannot compute one. */
export function installProgressRatio(progress: InstallProgress): number | null {
  if (progress.percent === null) {
    return progress.state === 'COMPLETED' ? 1 : null;
  }
  return progress.percent / 100;
}

export function installProgressLabel(progress: InstallProgress): string {
  const percent = progress.percent === null ? '' : `${progress.percent.toFixed(1)}% `;
  switch (progress.state) {
    case 'IDLE':
      return 'Not started';
    case 'DOWNLOADING':
      return `${percent}Downloading${progress.statusText ? ` · ${progress.statusText}` : ''}`;
    case 'VERIFYING':
      return `${percent}Verifying${progress.statusText ? ` · ${progress.statusText}` : ''}`;
    case 'COMPLETED':
      return 'Installed';
    case 'FAILED':
      return 'Download failed';
    default:
      return progress.statusText;
  }
}

export function installProgressDetail(progress: InstallProgress): string {
  switch (progress.state) {
    case 'IDLE':
      return 'The model is downloaded only when you ask for it.';
    case 'DOWNLOADING':
      return 'The download resumes from this screen if the connection drops.';
    case 'VERIFYING':
      return 'Checking that the downloaded weights are complete.';
    case 'COMPLETED':
      return 'The model is stored in the local Ollama volume.';
    case 'FAILED':
      return progress.error ?? 'The download failed. You can start it again.';
    default:
      return '';
  }
}

// --------------------------------------------------------------------------------------
// Chat and reports
// --------------------------------------------------------------------------------------

export type ProposalKind =
  | 'SET_VEHICLE_UNAVAILABLE'
  | 'DELAY_VEHICLE'
  | 'REQUEST_REOPTIMIZATION';

export type ProposalStatus = 'PENDING' | 'CONFIRMED' | 'REJECTED';

export interface AiProposal {
  proposalId: string;
  kind: ProposalKind;
  summary: string;
  payload: Record<string, unknown>;
  status: ProposalStatus;
  revisionToApply: number | null;
}

export interface AiChatAnswer {
  answer: string;
  usedRevision: number;
  references: string[];
  proposal: AiProposal | null;
  timingsMs: Record<string, number>;
}

export interface AiReport {
  scenarioRevision: number;
  generatedAt: string;
  markdown: string;
  report: Record<string, unknown>;
  schemaVersion: string;
}

const PROPOSAL_KINDS: readonly ProposalKind[] = [
  'SET_VEHICLE_UNAVAILABLE',
  'DELAY_VEHICLE',
  'REQUEST_REOPTIMIZATION',
];
const PROPOSAL_STATUSES: readonly ProposalStatus[] = ['PENDING', 'CONFIRMED', 'REJECTED'];

export function parseAiProposal(raw: unknown): AiProposal | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const kind = candidate.kind;
  const status = candidate.status;
  if (typeof candidate.proposalId !== 'string' || !candidate.proposalId) return null;
  if (typeof kind !== 'string' || !(PROPOSAL_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  if (typeof status !== 'string' || !(PROPOSAL_STATUSES as readonly string[]).includes(status)) {
    return null;
  }
  if (typeof candidate.summary !== 'string' || !candidate.summary) return null;
  return {
    proposalId: candidate.proposalId,
    kind: kind as ProposalKind,
    summary: candidate.summary,
    payload:
      typeof candidate.payload === 'object' && candidate.payload !== null
        ? (candidate.payload as Record<string, unknown>)
        : {},
    status: status as ProposalStatus,
    revisionToApply:
      typeof candidate.revisionToApply === 'number' ? candidate.revisionToApply : null,
  };
}

export function parseChatResponse(raw: unknown): AiChatAnswer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.answer !== 'string' || !candidate.answer) return null;
  if (typeof candidate.usedRevision !== 'number') return null;
  const timings: Record<string, number> = {};
  if (typeof candidate.timingsMs === 'object' && candidate.timingsMs !== null) {
    for (const [key, value] of Object.entries(candidate.timingsMs as Record<string, unknown>)) {
      if (typeof value === 'number') timings[key] = value;
    }
  }
  return {
    answer: candidate.answer,
    usedRevision: candidate.usedRevision,
    references: Array.isArray(candidate.references)
      ? candidate.references.filter((item): item is string => typeof item === 'string')
      : [],
    proposal: parseAiProposal(candidate.proposal),
    timingsMs: timings,
  };
}

export function parseShiftReport(raw: unknown): AiReport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.markdown !== 'string' || !candidate.markdown) return null;
  if (typeof candidate.scenarioRevision !== 'number') return null;
  if (typeof candidate.generatedAt !== 'string') return null;
  if (typeof candidate.schemaVersion !== 'string') return null;
  return {
    scenarioRevision: candidate.scenarioRevision,
    generatedAt: candidate.generatedAt,
    markdown: candidate.markdown,
    report:
      typeof candidate.report === 'object' && candidate.report !== null
        ? (candidate.report as Record<string, unknown>)
        : {},
    schemaVersion: candidate.schemaVersion,
  };
}

export function reportFileName(report: AiReport): string {
  return `roboroute-shift-report-r${report.scenarioRevision}.md`;
}

/** The report download as pure data, so the trigger itself stays a one-liner. */
export function reportDownload(report: AiReport): { fileName: string; content: string } {
  return { fileName: reportFileName(report), content: report.markdown };
}

export function proposalTarget(proposal: AiProposal): string | null {
  const target = proposal.payload.vehicleId;
  return typeof target === 'string' && target ? target : null;
}

export function describeProposalKind(kind: ProposalKind): string {
  switch (kind) {
    case 'SET_VEHICLE_UNAVAILABLE':
      return 'Take one robot out of service';
    case 'DELAY_VEHICLE':
      return 'Delay one robot';
    case 'REQUEST_REOPTIMIZATION':
      return 'Recompute the plan';
    default:
      return kind;
  }
}

// --------------------------------------------------------------------------------------
// Errors and status copy
// --------------------------------------------------------------------------------------

const AI_ERROR_COPY: Record<string, string> = {
  AI_SERVICE_UNAVAILABLE:
    'The local AI service is not reachable. Your scenario is safe; try again in a moment.',
  AI_MODEL_NOT_INSTALLED: 'Install Qwen Core before using the copilot.',
  AI_MODEL_NOT_LOADED: 'Activate the AI core before asking.',
  AI_INSTALL_IN_PROGRESS: 'A download is already running.',
  AI_OUTPUT_INVALID:
    'The model answered with something the contract rejects. Ask again.',
  MODEL_OVERRIDE_FORBIDDEN: 'The model and its options are fixed by the backend.',
  PROPOSAL_NOT_FOUND: 'That proposal no longer matches the current scenario revision.',
  SCENARIO_NOT_FOUND: 'The scenario is gone. Create it again and ask once more.',
  VALIDATION_ERROR: 'The request was rejected as invalid.',
};

export function describeAiError(code: string | null, fallback: string): string {
  if (code && AI_ERROR_COPY[code]) return AI_ERROR_COPY[code];
  return fallback;
}

export function aiReadinessCopy(status: AiStatus): {
  service: string;
  installed: string;
  loaded: string;
} {
  return {
    service: status.serviceAvailable ? 'Available' : 'Unavailable',
    installed: status.modelInstalled ? 'Installed' : 'Not installed',
    loaded: status.modelLoaded ? 'Loaded' : 'Not loaded',
  };
}
