/**
 * Web server for the built frontend.
 *
 * It serves `dist/` and proxies `/health` and `/api/*` to the API service, so the
 * browser only ever talks to this origin: no CORS configuration is needed and the
 * Ollama port is never reachable from the browser.
 *
 * PROXY SCOPE: JSON responses are still buffered whole, because their size is known and
 * their `content-length` must stay correct. Server-sent events are forwarded frame by
 * frame instead: buffering a `text/event-stream` would hold every frame until the upstream
 * closed the response, which is exactly what the Phase 8 install progress bar must not do.
 * The streaming branch never sets `content-length` and never caches.
 */
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultDistDir = path.resolve(here, '..', 'dist');
const defaultApiUpstream = 'http://api:8000';
const defaultPort = 8080;
const proxyPrefixes = ['/health', '/api/'];
const indexedFiles = new Set(['/index.html', '/']);
const jsonFallbackContentType = 'application/json; charset=utf-8';

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function isProxied(pathname) {
  return proxyPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

/**
 * True when a response body must be forwarded as it arrives.
 *
 * The media type decides, not the path: the API owns which endpoints stream, and a
 * future stream is then forwarded correctly without touching this server again.
 */
export function isEventStream(contentType) {
  if (typeof contentType !== 'string') return false;
  return contentType.split(';')[0].trim().toLowerCase() === 'text/event-stream';
}

/** Headers for a streamed body: no `content-length`, no cache, no intermediary buffering. */
export function streamResponseHeaders(contentType) {
  return {
    'content-type': contentType,
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
  };
}

/** Headers for a buffered body, whose length is known before it is written. */
export function bufferedResponseHeaders(contentType, byteLength) {
  return {
    'content-type': contentType,
    'content-length': String(byteLength),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
}

function writeTransportFailure(response, error) {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(`API upstream unreachable: ${error instanceof Error ? error.message : error}`);
}

async function proxy(request, response, url, config) {
  const target = new URL(`${url.pathname}${url.search}`, config.apiUpstream);
  const headers = { ...request.headers, host: config.apiUpstream.host };
  delete headers.connection;
  delete headers['accept-encoding'];

  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = Readable.toWeb(request);
    init.duplex = 'half';
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (error) {
    // The API owns the error catalogue; this server only reports transport failure.
    writeTransportFailure(response, error);
    return;
  }

  const contentType = upstream.headers.get('content-type') ?? jsonFallbackContentType;

  if (isEventStream(contentType) && request.method !== 'HEAD' && upstream.body) {
    response.writeHead(upstream.status, streamResponseHeaders(contentType));
    // Flush the headers before the first frame, so the browser opens the EventSource
    // immediately instead of waiting for the upstream to write something.
    response.flushHeaders?.();
    const body = Readable.fromWeb(upstream.body);
    // A client that goes away must not leave the upstream download streaming into a
    // closed socket.
    const stop = () => body.destroy();
    response.on('close', stop);
    body.on('error', () => {
      response.off('close', stop);
      response.destroy();
    });
    body.pipe(response);
    return;
  }

  try {
    const body = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, bufferedResponseHeaders(contentType, body.byteLength));
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    writeTransportFailure(response, error);
  }
}

async function serveStatic(request, response, url, config) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end();
    return;
  }

  const requested = decodeURIComponent(url.pathname);
  const resolved = path.resolve(config.distDir, `.${path.posix.normalize(requested)}`);
  if (resolved !== config.distDir && !resolved.startsWith(`${config.distDir}${path.sep}`)) {
    response.writeHead(403);
    response.end();
    return;
  }

  let filePath = resolved;
  let stats = await statOrNull(filePath);

  if (!stats?.isFile()) {
    // Single page application fallback: unknown routes render the shell, but a
    // missing asset keeps returning 404.
    if (path.extname(requested) !== '') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    filePath = path.join(config.distDir, 'index.html');
    stats = await statOrNull(filePath);
  }

  if (!stats?.isFile()) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Frontend build output is missing. Run `npm run build` first.');
    return;
  }

  const headers = {
    'content-type': contentTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(stats.size),
    'x-content-type-options': 'nosniff',
    'cache-control': indexedFiles.has(requested)
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
  };

  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

async function statOrNull(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

/**
 * Build the server without binding a port.
 *
 * Keeping the listen call out of the factory is what lets the focused proxy test drive a
 * real upstream stream through the real handler on an ephemeral port.
 */
export function createFrontendServer(options = {}) {
  const config = {
    distDir: options.distDir ?? defaultDistDir,
    apiUpstream: options.apiUpstream ?? new URL(defaultApiUpstream),
  };

  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const handler = isProxied(url.pathname)
      ? proxy(request, response, url, config)
      : serveStatic(request, response, url, config);
    handler.catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end('Internal server error');
    });
  });
}

const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPoint === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env.PORT ?? String(defaultPort), 10);
  const apiUpstream = new URL(process.env.API_UPSTREAM ?? defaultApiUpstream);
  createFrontendServer({ apiUpstream }).listen(port, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`RoboRoute Nexus frontend listening on http://0.0.0.0:${port} (api: ${apiUpstream})`);
  });
}
