import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FIXED_MODEL_NAME,
  INACTIVE_READINESS,
  loadAiStatus,
  loadReadiness,
  toAiStatus,
} from './readiness';

const AI_READY = {
  serviceAvailable: true,
  modelInstalled: true,
  modelLoaded: true,
  modelName: FIXED_MODEL_NAME,
  installJob: null,
};

interface RecordedCall {
  url: string;
  method: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(route: (url: string) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET' });
      return route(url);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('inactive readiness', () => {
  it('starts empty and inactive', () => {
    expect(INACTIVE_READINESS.scenarioStatus).toBe('IDLE');
    expect(INACTIVE_READINESS.scenarioRevision).toBe(0);
    expect(INACTIVE_READINESS.vehicleCount).toBe(0);
    expect(INACTIVE_READINESS.orderCount).toBe(0);
    expect(INACTIVE_READINESS.simulationRunning).toBe(false);
    expect(INACTIVE_READINESS.api).toBe('checking');
    expect(INACTIVE_READINESS.ai.modelName).toBe('qwen3:4b');
    expect(INACTIVE_READINESS.ai.modelInstalled).toBe(false);
    expect(INACTIVE_READINESS.ai.modelLoaded).toBe(false);
  });
});

describe('loadReadiness', () => {
  it('reads only the two readiness endpoints', async () => {
    const calls = stubFetch((url) =>
      url === '/health' ? jsonResponse({ status: 'ok', service: 'roboroute-api', version: '0.1.0' }) : jsonResponse(AI_READY),
    );

    const readiness = await loadReadiness();

    expect(calls).toEqual([
      { url: '/health', method: 'GET' },
      { url: '/api/ai/status', method: 'GET' },
    ]);
    expect(readiness.api).toBe('online');
    expect(readiness.ai).toEqual(AI_READY);
    expect(readiness.scenarioStatus).toBe('IDLE');
    expect(readiness.vehicleCount).toBe(0);
    expect(readiness.orderCount).toBe(0);
  });

  it('keeps the scenario inactive when the API is unreachable', async () => {
    stubFetch(() => {
      throw new Error('connection refused');
    });

    const readiness = await loadReadiness();

    expect(readiness.api).toBe('offline');
    expect(readiness.ai).toEqual(INACTIVE_READINESS.ai);
    expect(readiness.scenarioStatus).toBe('IDLE');
    expect(readiness.simulationRunning).toBe(false);
  });

  it('reports the API as online but the AI as unavailable when status fails', async () => {
    stubFetch((url) =>
      url === '/health'
        ? jsonResponse({ status: 'ok', service: 'roboroute-api', version: '0.1.0' })
        : jsonResponse({ error: 'boom' }, 500),
    );

    const readiness = await loadReadiness();

    expect(readiness.api).toBe('online');
    expect(readiness.ai.serviceAvailable).toBe(false);
    expect(readiness.ai.modelLoaded).toBe(false);
  });
});

describe('toAiStatus', () => {
  it('falls back to the inactive status for malformed payloads', () => {
    expect(toAiStatus(null)).toEqual(INACTIVE_READINESS.ai);
    expect(toAiStatus('qwen3:4b')).toEqual(INACTIVE_READINESS.ai);
    expect(toAiStatus({ serviceAvailable: 'yes' })).toEqual(INACTIVE_READINESS.ai);
  });

  it('keeps the model name reported by the backend', () => {
    expect(toAiStatus({ ...AI_READY, modelName: 'qwen3:4b' }).modelName).toBe('qwen3:4b');
  });
});

describe('loadAiStatus', () => {
  it('adopts the authoritative status the backend answered', async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        serviceAvailable: true,
        modelInstalled: true,
        modelLoaded: false,
        modelName: FIXED_MODEL_NAME,
        installJob: {
          jobId: 'job-1',
          state: 'COMPLETED',
          modelName: FIXED_MODEL_NAME,
          startedAt: '2026-09-22T09:00:00.000Z',
          finishedAt: '2026-09-22T09:05:00.000Z',
        },
      }),
    );

    const probe = await loadAiStatus();

    expect(calls).toEqual([{ url: '/api/ai/status', method: 'GET' }]);
    expect(probe.reachable).toBe(true);
    expect(probe.error).toBeNull();
    expect(probe.status).toMatchObject({
      serviceAvailable: true,
      modelInstalled: true,
      modelLoaded: false,
    });
    expect(probe.status.installJob?.state).toBe('COMPLETED');
  });

  it('reports the read failure instead of a status that claims the service is down', async () => {
    stubFetch(() => {
      throw new Error('Failed to fetch');
    });

    const probe = await loadAiStatus();

    expect(probe.reachable).toBe(false);
    expect(probe.status.serviceAvailable).toBe(false);
    expect(probe.error).toContain('Failed to fetch');
  });

  it('names the HTTP status when the backend rejects the read', async () => {
    stubFetch(() => jsonResponse({ detail: 'boom' }, 503));

    const probe = await loadAiStatus();

    expect(probe.reachable).toBe(false);
    expect(probe.error).toContain('HTTP 503');
  });

  it('drops an install job that does not carry an identity', () => {
    expect(toAiStatus({ ...AI_READY, installJob: { state: 'COMPLETED' } }).installJob).toBeNull();
    expect(toAiStatus({ ...AI_READY, installJob: 'job-1' }).installJob).toBeNull();
  });
});
