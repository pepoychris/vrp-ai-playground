import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DisallowedRequestError,
  HttpError,
  READ_ONLY_PATHS,
  getJson,
  isReadOnlyPath,
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
