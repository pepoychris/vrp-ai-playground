/**
 * Phase 1 web server for the built frontend.
 *
 * It serves `dist/` and proxies `/health` and `/api/*` to the API service, so the
 * browser only ever talks to this origin: no CORS configuration is needed and the
 * Ollama port is never reachable from the browser. Phase 1 keeps this deliberately
 * small, because the MVP only asks for "build output plus a web server"; a hardened
 * reverse proxy is a later decision.
 *
 * PROXY SCOPE: the proxy below buffers the complete upstream response before writing
 * it, which is correct for the JSON endpoints Phase 1 exposes. It is NOT suitable for
 * `text/event-stream`: a streamed response would be held back until the upstream
 * closes it. The Phase 8 model-install stream (`/api/ai/model/install/events`) and
 * the scenario event stream must therefore go through a dedicated streaming path
 * (or be served directly by the API origin). SSE is not implemented now.
 */
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '..', 'dist');
const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const apiUpstream = new URL(process.env.API_UPSTREAM ?? 'http://api:8000');
const proxyPrefixes = ['/health', '/api/'];
const indexedFiles = new Set(['/index.html', '/']);

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

function isProxied(pathname) {
  return proxyPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

async function proxy(request, response, url) {
  const target = new URL(`${url.pathname}${url.search}`, apiUpstream);
  const headers = { ...request.headers, host: apiUpstream.host };
  delete headers.connection;
  delete headers['accept-encoding'];

  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = Readable.toWeb(request);
    init.duplex = 'half';
  }

  try {
    const upstream = await fetch(target, init);
    const body = Buffer.from(await upstream.arrayBuffer());
    const responseHeaders = {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    response.writeHead(upstream.status, responseHeaders);
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    // The API owns the error catalogue; this server only reports transport failure.
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`API upstream unreachable: ${error instanceof Error ? error.message : error}`);
  }
}

async function serveStatic(request, response, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end();
    return;
  }

  const requested = decodeURIComponent(url.pathname);
  const resolved = path.resolve(distDir, `.${path.posix.normalize(requested)}`);
  if (resolved !== distDir && !resolved.startsWith(`${distDir}${path.sep}`)) {
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
    filePath = path.join(distDir, 'index.html');
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

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const handler = isProxied(url.pathname)
    ? proxy(request, response, url)
    : serveStatic(request, response, url);
  handler.catch(() => {
    if (!response.headersSent) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    }
    response.end('Internal server error');
  });
});

server.listen(port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`RoboRoute Nexus frontend listening on http://0.0.0.0:${port} (api: ${apiUpstream})`);
});
