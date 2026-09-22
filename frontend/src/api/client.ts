/**
 * The only HTTP surface this frontend is allowed to use (MVP Phase 1).
 *
 * Phase 1 renders readiness only, so the allowlist holds the two read endpoints the
 * status screen needs: the API probe and the AI readiness report. There is
 * deliberately no helper that sends a body, and no way to name a model: the
 * scenario, fleet, order, route, simulation and AI command endpoints belong to
 * later phases and must not be reachable from this screen.
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
