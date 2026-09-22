/**
 * Readiness model of the inactive startup screen (MVP Phase 1).
 *
 * The screen reports three things: whether the API answers, whether the local AI
 * core is reachable/installed/loaded, and the scenario state. Phase 1 has no
 * scenario endpoints, so the scenario part is the frozen empty state: no scenario,
 * revision 0, no vehicles, no orders and no running simulation. Loading readiness
 * never creates a scenario and never installs a model.
 */

import { getJson } from '../api/client';

export const FIXED_MODEL_NAME = 'qwen3:4b';

export type ScenarioStatus = 'IDLE' | 'READY' | 'OPTIMIZING' | 'RUNNING' | 'PAUSED';
export type ApiReachability = 'checking' | 'online' | 'offline';

export interface HealthStatus {
  status: string;
  service: string;
  version: string;
}

export interface AiStatus {
  serviceAvailable: boolean;
  modelInstalled: boolean;
  modelLoaded: boolean;
  modelName: string;
  installJob: unknown | null;
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
    installJob: candidate.installJob ?? null,
  };
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
  try {
    return toAiStatus(await getJson<unknown>('/api/ai/status', signal));
  } catch {
    return { ...INACTIVE_AI_STATUS };
  }
}
