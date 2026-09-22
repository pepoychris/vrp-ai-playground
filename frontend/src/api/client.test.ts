import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AI_PATHS,
  ApiRequestError,
  activateModel,
  askCopilot,
  confirmProposal,
  createCommandId,
  createScenario,
  DisallowedRequestError,
  deployFleet,
  generateOrders,
  installModel,
  openInstallStream,
  optimizeScenario,
  pauseSimulation,
  placeBarrier,
  proposalPath,
  rejectProposal,
  relocateVehicle,
  removeBarrier,
  requestShiftReport,
  startSimulation,
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

    await optimizeScenario('s-1', 1, { timeLimitSeconds: 1 });

    const [, init] = fetchStub.mock.calls[0] as [unknown, RequestInit];
    expect(JSON.parse(String(init.body)).timeLimitSeconds).toBe(1);
  });

  it('accepts an explicit command id so the caller can track its own command', async () => {
    const fetchStub = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ scenarioId: 's-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchStub);
    const commandId = createCommandId();

    await optimizeScenario('s-1', 3, { commandId });

    const [, init] = fetchStub.mock.calls[0] as [unknown, RequestInit];
    expect(JSON.parse(String(init.body)).commandId).toBe(commandId);
  });
});

describe('Phase 6 simulation and claw commands', () => {
  it('starts, resumes and pauses the simulation with the frozen envelope', async () => {
    const fetchStub = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ scenarioId: 's-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchStub);

    await startSimulation('s-1', 4, 2);
    await pauseSimulation('s-1', 5);

    expect(fetchStub).toHaveBeenCalledTimes(2);
    const [startPath, startInit] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(startPath).toBe('/api/scenarios/s-1/simulation/start');
    const startBody = JSON.parse(String(startInit.body)) as Record<string, unknown>;
    expect(startBody.scenarioRevision).toBe(4);
    expect(startBody.speedMultiplier).toBe(2);
    expect(startBody.commandId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const [pausePath, pauseInit] = fetchStub.mock.calls[1] as [string, RequestInit];
    expect(pausePath).toBe('/api/scenarios/s-1/simulation/pause');
    expect(JSON.parse(String(pauseInit.body)).scenarioRevision).toBe(5);
  });

  it('patches one vehicle position with the world point under the pointer', async () => {
    const fetchStub = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ scenarioId: 's-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchStub);

    await relocateVehicle('s-1', 'R-01', { x: 1, y: 0, z: -2 }, 6);

    const [path, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/scenarios/s-1/vehicles/R-01/position');
    expect(init).toMatchObject({ method: 'PATCH' });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.scenarioRevision).toBe(6);
    expect(body.position).toEqual({ x: 1, y: 0, z: -2 });
  });

  it('surfaces the rejection detail of an out-of-radius drop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: 'SNAP_OUT_OF_RADIUS' }), { status: 422 }),
      ),
    );

    await expect(
      relocateVehicle('s-1', 'R-01', { x: 0, y: 0, z: 0 }, 2),
    ).rejects.toThrow('SNAP_OUT_OF_RADIUS');
  });
});

describe('Phase 7 barrier commands', () => {
  it('posts one barrier with the world point and the frozen envelope', async () => {
    const fetchStub = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ scenarioId: 's-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchStub);
    const commandId = createCommandId();

    await placeBarrier(
      's-1',
      { position: { x: 3, y: 0, z: -4 } },
      9,
      { commandId },
    );

    const [path, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/scenarios/s-1/barriers');
    expect(init).toMatchObject({ method: 'POST' });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.scenarioRevision).toBe(9);
    expect(body.commandId).toBe(commandId);
    expect(body.position).toEqual({ x: 3, y: 0, z: -4 });
    expect(body).not.toHaveProperty('edgeId');
  });

  it('posts an explicit edge id without any pixel position', async () => {
    const fetchStub = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ scenarioId: 's-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchStub);

    await placeBarrier('s-1', { edgeId: 'E-N001-N002' }, 3);

    const body = JSON.parse(
      String((fetchStub.mock.calls[0] as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    expect(body.edgeId).toBe('E-N001-N002');
    expect(body).not.toHaveProperty('position');
  });

  it('deletes one barrier by id with the same command envelope', async () => {
    const fetchStub = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ scenarioId: 's-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchStub);
    const commandId = createCommandId();

    await removeBarrier('s-1', 'B-2', 4, { commandId });

    const [path, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/scenarios/s-1/barriers/B-2');
    expect(init).toMatchObject({ method: 'DELETE' });
    expect(JSON.parse(String(init.body))).toMatchObject({
      commandId,
      scenarioRevision: 4,
    });
  });

  it('surfaces the rejection detail of a drop with no road in range', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: 'SNAP_NO_VALID_EDGE' }), { status: 422 }),
      ),
    );

    await expect(
      placeBarrier('s-1', { position: { x: 0, y: 0, z: 0 } }, 2),
    ).rejects.toThrow('SNAP_NO_VALID_EDGE');
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

describe('Phase 8 local AI endpoints', () => {
  it('posts an empty body to install the fixed model', async () => {
    const fetchStub = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ jobId: 'job-1', state: 'DOWNLOADING' }), { status: 202 }),
    );
    vi.stubGlobal('fetch', fetchStub);

    const job = await installModel<{ state: string }>();

    expect(job.state).toBe('DOWNLOADING');
    const [path, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(AI_PATHS.install);
    expect(init).toMatchObject({ method: 'POST', body: '{}' });
    // The model is not a request parameter: the browser cannot choose one.
    expect(String(init.body)).not.toMatch(/qwen|model|null/i);
  });

  it('activates the core without sending any option', async () => {
    const fetchStub = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ modelLoaded: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchStub);

    await activateModel();

    const [path, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(AI_PATHS.activate);
    expect(init).toMatchObject({ method: 'POST', body: '{}' });
  });

  it('grounds the question on the revision and carries the command envelope', async () => {
    const fetchStub = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ answer: 'ok', usedRevision: 5 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchStub);
    const commandId = createCommandId();

    await askCopilot('s-1', 5, [{ role: 'user', content: '¿por que cambio la ruta?' }], {
      commandId,
    });

    const [path, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(AI_PATHS.chat);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ scenarioId: 's-1', scenarioRevision: 5, commandId });
    expect(body.messages).toEqual([{ role: 'user', content: '¿por que cambio la ruta?' }]);
    // No inference override ever leaves the browser.
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('think');
    expect(body).not.toHaveProperty('options');
    expect(body).not.toHaveProperty('keep_alive');
  });

  it('requests the shift report with the same grounded envelope', async () => {
    const fetchStub = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ markdown: '# Turno' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchStub);

    await requestShiftReport('s-1', 6);

    const [path, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(AI_PATHS.shiftReport);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.scenarioRevision).toBe(6);
    expect(body.commandId).toEqual(expect.any(String));
  });

  it('confirms and rejects one proposal through its own path', async () => {
    const fetchStub = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ scenarioRevision: 7 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchStub);

    await confirmProposal('prop-1', 6);
    await rejectProposal('prop-1', 6);

    expect(proposalPath('prop-1')).toBe('/api/ai/proposals/prop-1');
    expect(fetchStub.mock.calls[0][0]).toBe('/api/ai/proposals/prop-1/confirm');
    expect(fetchStub.mock.calls[1][0]).toBe('/api/ai/proposals/prop-1/reject');
    for (const [, init] of fetchStub.mock.calls as [string, RequestInit][]) {
      expect(JSON.parse(String(init.body))).toMatchObject({ scenarioRevision: 6 });
    }
  });

  it('escapes a proposal id before it reaches the path', () => {
    expect(proposalPath('a/b c')).toBe('/api/ai/proposals/a%2Fb%20c');
  });

  it('surfaces the frozen error envelope of an AI endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'AI_MODEL_NOT_LOADED', message: 'Activate the AI core first.' },
            }),
            { status: 409 },
          ),
      ),
    );

    await expect(askCopilot('s-1', 1, [{ role: 'user', content: 'hola' }])).rejects.toMatchObject({
      code: 'AI_MODEL_NOT_LOADED',
      status: 409,
    });
    await expect(
      askCopilot('s-1', 1, [{ role: 'user', content: 'hola' }]),
    ).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('subscribes to the install progress stream at the frozen path', () => {
    const opened: string[] = [];
    class FakeEventSource {
      constructor(readonly url: string) {
        opened.push(url);
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void {}
    }
    vi.stubGlobal('EventSource', FakeEventSource);

    const stream = openInstallStream();

    expect(stream).toBeInstanceOf(FakeEventSource);
    expect(opened).toEqual([AI_PATHS.installEvents]);
    expect(AI_PATHS.installEvents).toBe('/api/ai/model/install/events');
  });

  it('returns no stream where the environment has no EventSource', () => {
    vi.stubGlobal('EventSource', undefined);

    expect(openInstallStream()).toBeNull();
  });
});
