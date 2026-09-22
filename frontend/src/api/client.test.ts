import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createScenario,
  DisallowedRequestError,
  deployFleet,
  generateOrders,
  HttpError,
  READ_ONLY_PATHS,
  getJson,
  isReadOnlyPath,
  resetScenario,
} from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('read-only surface', () => {
  it('only allows the two Phase 1 read endpoints', () => {
    expect([...READ_ONLY_PATHS]).toEqual(['/health', '/api/ai/status']);
  });

  it('recognises the allowed paths and rejects business paths', () => {
    expect(isReadOnlyPath('/health')).toBe(true);
    expect(isReadOnlyPath('/api/ai/status')).toBe(true);
    expect(isReadOnlyPath('/api/scenarios')).toBe(false);
    expect(isReadOnlyPath('/api/ai/model/install')).toBe(false);
    expect(isReadOnlyPath('/api/ai/chat')).toBe(false);
  });

  it('does not reach the network for a disallowed path', async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);

    await expect(getJson('/api/scenarios')).rejects.toBeInstanceOf(DisallowedRequestError);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('performs GET requests for allowed paths', async () => {
    const fetchStub = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchStub);

    await expect(getJson('/health')).resolves.toEqual({ status: 'ok' });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0][1]).toMatchObject({ method: 'GET' });
  });

  it('reports a non-2xx response as an HttpError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 })),
    );

    await expect(getJson('/api/ai/status')).rejects.toBeInstanceOf(HttpError);
  });
});

describe('Phase 4 mutations', () => {
  it('uses explicit JSON commands for scenario generation and reset', async () => {
    const fetchStub = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ scenarioId: 's-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchStub);

    await createScenario(1);
    await deployFleet('s-1', 2);
    await generateOrders('s-1', 6);
    await resetScenario('s-1');

    expect(fetchStub).toHaveBeenCalledTimes(4);
    expect(fetchStub.mock.calls[1][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ count: 2 }) });
    expect(fetchStub.mock.calls[3][1]).toMatchObject({ method: 'DELETE' });
  });
});
