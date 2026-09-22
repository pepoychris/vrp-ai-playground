import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCommandId,
  createScenario,
  DisallowedRequestError,
  deployFleet,
  generateOrders,
  optimizeScenario,
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

describe('scenario mutations', () => {
  it('uses explicit JSON commands for scenario generation and reset', async () => {
    const fetchStub = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ scenarioId: 's-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchStub);

    await createScenario(1);
    await deployFleet('s-1', 2);
    await generateOrders('s-1', 6);
    await optimizeScenario('s-1', 3);
    await resetScenario('s-1');

    expect(fetchStub).toHaveBeenCalledTimes(5);
    expect(fetchStub.mock.calls[1][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ count: 2 }) });
    expect(fetchStub.mock.calls[4][1]).toMatchObject({ method: 'DELETE' });
  });

  it('sends the frozen command envelope when optimising a revision', async () => {
    const fetchStub = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ scenarioId: 's-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchStub);

    await optimizeScenario('s-1', 7);

    const [, init] = fetchStub.mock.calls[0] as [unknown, RequestInit];
    expect(init).toMatchObject({
      method: 'POST',
    });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.scenarioRevision).toBe(7);
    expect(body.timeLimitSeconds).toBe(2);
    expect(body.commandId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('honours an explicit bounded search limit', async () => {
    const fetchStub = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ scenarioId: 's-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchStub);

    await optimizeScenario('s-1', 1, 1);

    const [, init] = fetchStub.mock.calls[0] as [unknown, RequestInit];
    expect(JSON.parse(String(init.body)).timeLimitSeconds).toBe(1);
  });
});

describe('command ids', () => {
  it('generates distinct v4 UUIDs', () => {
    const first = createCommandId();
    const second = createCommandId();
    const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(first).toMatch(pattern);
    expect(second).toMatch(pattern);
    expect(first).not.toBe(second);
  });
});
