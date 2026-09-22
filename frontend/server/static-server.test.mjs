/**
 * Focused tests for the Phase 9 streaming proxy.
 *
 * The install progress bar is only honest if frames reach the browser while the download
 * is still running, so the first test drives a real upstream stream through the real
 * handler and asserts the first frame lands before the upstream is allowed to produce the
 * second one. The JSON path is asserted to stay buffered with a correct content-length.
 */
import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  bufferedResponseHeaders,
  createFrontendServer,
  isEventStream,
  isProxied,
  streamResponseHeaders,
} from './static-server.mjs';

const running = [];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function startServer(server) {
  running.push(server);
  const port = await listen(server);
  return { origin: `http://127.0.0.1:${port}` };
}

async function startUpstream(handler) {
  return startServer(createServer(handler));
}

async function startFrontend(upstreamOrigin) {
  return startServer(createFrontendServer({ apiUpstream: new URL(upstreamOrigin) }));
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function sseFrame(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

afterEach(async () => {
  await Promise.all(
    running.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

describe('install progress proxy', () => {
  it('forwards an ai.install frame before the upstream stream closes', async () => {
    let releaseSecondFrame;
    const secondFrame = new Promise((resolve) => {
      releaseSecondFrame = resolve;
    });
    let upstreamFinished = false;

    const upstream = await startUpstream(async (request, response) => {
      if (request.url !== '/api/ai/model/install/events') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      });
      response.write(
        sseFrame('ai.install', {
          type: 'ai.install',
          eventSeq: 1,
          payload: { state: 'DOWNLOADING', modelName: 'qwen3:4b', percent: 12.5 },
        }),
      );
      // Hold the terminal frame until the test confirms it already saw the first one.
      await secondFrame;
      response.write(
        sseFrame('ai.install', {
          type: 'ai.install',
          eventSeq: 2,
          payload: { state: 'COMPLETED', modelName: 'qwen3:4b', percent: 100 },
        }),
      );
      upstreamFinished = true;
      response.end();
    });

    const frontend = await startFrontend(upstream.origin);
    const response = await fetch(`${frontend.origin}/api/ai/model/install/events`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    // A buffered body would carry a content-length; a streamed one must not.
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const first = await withTimeout(
      reader.read(),
      3000,
      'the proxy buffered the stream: no frame arrived while the upstream was open',
    );
    const firstChunk = decoder.decode(first.value);

    expect(firstChunk).toContain('event: ai.install');
    expect(firstChunk).toContain('"state":"DOWNLOADING"');
    expect(firstChunk).toContain('"percent":12.5');
    // The upstream was still streaming when the first frame reached the client.
    expect(upstreamFinished).toBe(false);

    releaseSecondFrame();

    let remaining = firstChunk;
    while (!remaining.includes('"state":"COMPLETED"')) {
      const next = await withTimeout(reader.read(), 3000, 'the terminal frame never arrived');
      if (next.done) break;
      remaining += decoder.decode(next.value);
    }

    expect(remaining).toContain('"state":"COMPLETED"');
    expect(remaining).toContain('"percent":100');
    await reader.cancel();
  });

  it('keeps the JSON proxy buffered with a correct content-length', async () => {
    const status = {
      serviceAvailable: true,
      modelInstalled: true,
      modelLoaded: false,
      modelName: 'qwen3:4b',
      installJob: { jobId: 'job-1', state: 'COMPLETED', modelName: 'qwen3:4b' },
    };

    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(status));
    });

    const frontend = await startFrontend(upstream.origin);
    const response = await fetch(`${frontend.origin}/api/ai/status`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(text)));
    expect(JSON.parse(text)).toMatchObject({
      serviceAvailable: true,
      modelInstalled: true,
      modelLoaded: false,
    });
  });

  it('reports an unreachable upstream instead of pretending to stream', async () => {
    // Port 1 is reserved and never listening, so the connection is refused.
    const frontend = await startFrontend('http://127.0.0.1:1');
    const response = await fetch(`${frontend.origin}/api/ai/status`);

    expect(response.status).toBe(502);
    expect(await response.text()).toContain('API upstream unreachable');
  });
});

describe('proxy policy', () => {
  it('detects an event stream by media type and ignores its parameters', () => {
    expect(isEventStream('text/event-stream')).toBe(true);
    expect(isEventStream('text/event-stream; charset=utf-8')).toBe(true);
    expect(isEventStream('Text/Event-Stream')).toBe(true);
    expect(isEventStream('application/json; charset=utf-8')).toBe(false);
    expect(isEventStream(undefined)).toBe(false);
  });

  it('never declares a content length for a streamed body', () => {
    const streamed = streamResponseHeaders('text/event-stream; charset=utf-8');

    expect(streamed).not.toHaveProperty('content-length');
    expect(streamed['x-accel-buffering']).toBe('no');
    expect(streamed['cache-control']).toContain('no-transform');
    expect(bufferedResponseHeaders('application/json', 11)['content-length']).toBe('11');
  });

  it('proxies the health probe and the API surface only', () => {
    expect(isProxied('/health')).toBe(true);
    expect(isProxied('/api/ai/model/install/events')).toBe(true);
    expect(isProxied('/assets/models/robot-claw.glb')).toBe(false);
    expect(isProxied('/')).toBe(false);
  });
});
