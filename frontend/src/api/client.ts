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

async function mutation<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
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

export function createCommandId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Optional explicit command id, so the caller can track its own pending command. */
export interface CommandOptions {
  commandId?: string;
}

/**
 * Optimise one revision with the frozen command envelope, so a retried request is
 * replayed by the server instead of planning the scenario twice.
 */
export function optimizeScenario<T>(
  scenarioId: string,
  scenarioRevision: number,
  options: CommandOptions & { timeLimitSeconds?: number } = {},
): Promise<T> {
  return mutation<T>('POST', `/api/scenarios/${encodeURIComponent(scenarioId)}/optimize`, {
    commandId: options.commandId ?? createCommandId(),
    scenarioRevision,
    timeLimitSeconds: options.timeLimitSeconds ?? 2,
  });
}

export function resetScenario<T>(scenarioId: string): Promise<T> {
  return mutation<T>('DELETE', `/api/scenarios/${encodeURIComponent(scenarioId)}`);
}

/**
 * Start or resume the simulation, optionally at a new speed.
 *
 * The clock lives in the snapshot and ticks never create a revision, so this command is
 * the only place where the browser can change `simulation.running`.
 */
export function startSimulation<T>(
  scenarioId: string,
  scenarioRevision: number,
  speedMultiplier = 1,
  options: CommandOptions = {},
): Promise<T> {
  return mutation<T>(
    'POST',
    `/api/scenarios/${encodeURIComponent(scenarioId)}/simulation/start`,
    {
      commandId: options.commandId ?? createCommandId(),
      scenarioRevision,
      speedMultiplier,
    },
  );
}

export function pauseSimulation<T>(
  scenarioId: string,
  scenarioRevision: number,
  options: CommandOptions = {},
): Promise<T> {
  return mutation<T>(
    'POST',
    `/api/scenarios/${encodeURIComponent(scenarioId)}/simulation/pause`,
    { commandId: options.commandId ?? createCommandId(), scenarioRevision },
  );
}

/**
 * Drop one vehicle on the nearest road node.
 *
 * ``position`` is the raw world point under the pointer: the server snaps it, and an
 * out-of-radius drop answers 422 without publishing a revision.
 */
export function relocateVehicle<T>(
  scenarioId: string,
  vehicleId: string,
  position: { x: number; y: number; z: number },
  scenarioRevision: number,
  options: CommandOptions = {},
): Promise<T> {
  return mutation<T>(
    'PATCH',
    `/api/scenarios/${encodeURIComponent(scenarioId)}/vehicles/${encodeURIComponent(vehicleId)}/position`,
    {
      commandId: options.commandId ?? createCommandId(),
      scenarioRevision,
      position,
    },
  );
}

/**
 * Place one robotic barrier.
 *
 * The body carries either the raw world point under the pointer, which the server snaps
 * to the nearest road edge (skipping the roads that are already closed), or an explicit
 * `edgeId`. Either way the barrier blocks one stable road edge and never a pixel.
 */
export function placeBarrier<T>(
  scenarioId: string,
  target: { position: { x: number; y: number; z: number } } | { edgeId: string },
  scenarioRevision: number,
  options: CommandOptions = {},
): Promise<T> {
  return mutation<T>('POST', `/api/scenarios/${encodeURIComponent(scenarioId)}/barriers`, {
    commandId: options.commandId ?? createCommandId(),
    scenarioRevision,
    ...target,
  });
}

/**
 * Remove one barrier, restoring its road edge.
 *
 * `DELETE` is a resource operation, so the frozen envelope stays optional; sending it
 * makes a retried removal idempotent instead of a second command.
 */
export function removeBarrier<T>(
  scenarioId: string,
  barrierId: string,
  scenarioRevision: number,
  options: CommandOptions = {},
): Promise<T> {
  return mutation<T>(
    'DELETE',
    `/api/scenarios/${encodeURIComponent(scenarioId)}/barriers/${encodeURIComponent(barrierId)}`,
    { commandId: options.commandId ?? createCommandId(), scenarioRevision },
  );
}
