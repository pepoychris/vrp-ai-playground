/**
 * The only HTTP surface this frontend is allowed to use.
 *
 * Readiness remains read-only, while Phase 4 mutations are exposed through named
 * helpers below. The browser still cannot choose an AI model or call Ollama.
 */

export const READ_ONLY_PATHS = ['/health', '/api/ai/status'] as const;

export type ReadOnlyPath = (typeof READ_ONLY_PATHS)[number];

export class DisallowedRequestError extends Error {
  constructor(path: string) {
    super(`GET ${path} is not part of the Phase 1 read-only surface`);
    this.name = 'DisallowedRequestError';
  }
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, path: string) {
    super(`GET ${path} failed with HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, path: string, message: string) {
    super(`${path} failed with HTTP ${status}: ${message}`);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

export function isReadOnlyPath(path: string): path is ReadOnlyPath {
  return (READ_ONLY_PATHS as readonly string[]).includes(path);
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (!isReadOnlyPath(path)) {
    throw new DisallowedRequestError(path);
  }

  const response = await fetch(path, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal,
  });

  if (!response.ok) {
    throw new HttpError(response.status, path);
  }

  return (await response.json()) as T;
}

async function mutation<T>(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let message = response.statusText || 'request failed';
    try {
      const payload = (await response.json()) as { detail?: string };
      if (typeof payload.detail === 'string') message = payload.detail;
    } catch {
      // The status and path are enough when an upstream response is not JSON.
    }
    throw new ApiRequestError(response.status, path, message);
  }
  return (await response.json()) as T;
}

export function createScenario<T>(seed: number): Promise<T> {
  return mutation<T>('POST', '/api/scenarios', { seed });
}

export function deployFleet<T>(scenarioId: string, count: number): Promise<T> {
  return mutation<T>('POST', `/api/scenarios/${encodeURIComponent(scenarioId)}/vehicles/generate`, { count });
}

export function generateOrders<T>(scenarioId: string, count: number): Promise<T> {
  return mutation<T>('POST', `/api/scenarios/${encodeURIComponent(scenarioId)}/orders/generate`, { count });
}

export function resetScenario<T>(scenarioId: string): Promise<T> {
  return mutation<T>('DELETE', `/api/scenarios/${encodeURIComponent(scenarioId)}`);
}
