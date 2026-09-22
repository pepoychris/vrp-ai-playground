/**
 * Readiness model of the inactive startup screen (MVP Phase 1).
 *
 * The screen reports three things: whether the API answers, whether the local AI
 * core is reachable/installed/loaded, and the scenario state. Phase 1 has no
 * scenario endpoints, so the scenario part is the frozen empty state: no scenario,
 * revision 0, no vehicles, no orders and no running simulation. Loading readiness
 * never creates a scenario and never installs a model.
 */

import { HttpError, getJson } from '../api/client';

export const FIXED_MODEL_NAME = 'qwen3:4b';

export type ScenarioStatus = 'IDLE' | 'READY' | 'OPTIMIZING' | 'RUNNING' | 'PAUSED';
export type ApiReachability = 'checking' | 'online' | 'offline';

export interface HealthStatus {
  status: string;
  service: string;
  version: string;
}

/**
 * The frozen `installJob` summary: `GET /api/ai/status` carries no percentage, only the
 * job identity and its state. Progress comes from the event stream.
 */
export interface AiInstallJob {
  jobId: string;
  state: string;
  modelName: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface AiStatus {
  serviceAvailable: boolean;
  modelInstalled: boolean;
  modelLoaded: boolean;
  modelName: string;
  installJob: AiInstallJob | null;
}

/**
 * One authoritative read of `GET /api/ai/status`.
 *
 * `reachable` separates "the backend answered and says the service is down" from "the
 * status could not be read at all". The panel needs both facts: the first is a state to
 * render, the second is a recoverable error to explain and offer to retry.
 */
export interface AiStatusProbe {
  reachable: boolean;
  status: AiStatus;
  /** Why the probe failed, when it did. `null` on a successful read. */
  error: string | null;
}

export interface Readiness {
  api: ApiReachability;
  ai: AiStatus;
  scenarioStatus: ScenarioStatus;
  scenarioRevision: number;
  vehicleCount: number;
  orderCount: number;
  simulationRunning: boolean;
}

export const INACTIVE_AI_STATUS: AiStatus = {
  serviceAvailable: false,
  modelInstalled: false,
  modelLoaded: false,
  modelName: FIXED_MODEL_NAME,
  installJob: null,
};

export const INACTIVE_READINESS: Readiness = {
  api: 'checking',
  ai: INACTIVE_AI_STATUS,
  scenarioStatus: 'IDLE',
  scenarioRevision: 0,
  vehicleCount: 0,
  orderCount: 0,
  simulationRunning: false,
};

export function toAiStatus(raw: unknown): AiStatus {
  if (typeof raw !== 'object' || raw === null) {
    return { ...INACTIVE_AI_STATUS };
  }

  const candidate = raw as Partial<AiStatus>;
  return {
    serviceAvailable: candidate.serviceAvailable === true,
    modelInstalled: candidate.modelInstalled === true,
    modelLoaded: candidate.modelLoaded === true,
    modelName: typeof candidate.modelName === 'string' ? candidate.modelName : FIXED_MODEL_NAME,
    installJob: toInstallJob(candidate.installJob),
  };
}

function toInstallJob(raw: unknown): AiInstallJob | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.jobId !== 'string' || typeof candidate.state !== 'string') return null;
  return {
    jobId: candidate.jobId,
    state: candidate.state,
    modelName:
      typeof candidate.modelName === 'string' ? candidate.modelName : FIXED_MODEL_NAME,
    startedAt: typeof candidate.startedAt === 'string' ? candidate.startedAt : '',
    finishedAt: typeof candidate.finishedAt === 'string' ? candidate.finishedAt : null,
  };
}

/**
 * Read the AI status once, without ever throwing.
 *
 * The hook that owns the copilot panel calls this on mount, after an install and after an
 * activation, so the panel mirrors the backend instead of the frames it happened to see.
 */
export async function loadAiStatus(signal?: AbortSignal): Promise<AiStatusProbe> {
  try {
    const status = toAiStatus(await getJson<unknown>('/api/ai/status', signal));
    return { reachable: true, status, error: null };
  } catch (failure) {
    return {
      reachable: false,
      status: { ...INACTIVE_AI_STATUS },
      error: describeProbeError(failure),
    };
  }
}

function describeProbeError(failure: unknown): string {
  if (failure instanceof HttpError) {
    return `The backend answered HTTP ${failure.status} for the AI status.`;
  }
  if (failure instanceof Error) {
    return `The AI status could not be read: ${failure.message}`;
  }
  return 'The AI status could not be read.';
}

export async function loadReadiness(signal?: AbortSignal): Promise<Readiness> {
  return {
    ...INACTIVE_READINESS,
    api: await probeApi(signal),
    ai: await probeAi(signal),
  };
}

async function probeApi(signal?: AbortSignal): Promise<ApiReachability> {
  try {
    await getJson<HealthStatus>('/health', signal);
    return 'online';
  } catch {
    return 'offline';
  }
}

async function probeAi(signal?: AbortSignal): Promise<AiStatus> {
  return (await loadAiStatus(signal)).status;
}
