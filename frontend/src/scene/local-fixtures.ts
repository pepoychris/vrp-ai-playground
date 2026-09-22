/**
 * Node-only test helper for the Phase 2 fixtures.
 *
 * It reads the real GLB files from `public/assets/models` and serves them through a
 * `fetch` stub, so a unit test exercises the real GLTFLoader and the real
 * LoadingManager without a browser, a socket or an external URL.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { ASSET_MANIFEST } from './assets';
import type { AssetDefinition } from './assets';
import type { GltfAsset } from './load-assets';

export const FIXTURE_ASSET_DIRECTORY = fileURLToPath(
  new URL('../../public/assets/models/', import.meta.url),
);

/** Origin used only by headless tests. The application always uses same-origin paths. */
export const HEADLESS_FIXTURE_ORIGIN = 'http://fixture.local';

/**
 * A fresh `ArrayBuffer` copy of a fixture: copying keeps the reported byte length equal
 * to the file length and avoids exposing Node's pooled buffer offsets.
 */
export function fixtureArrayBuffer(fileName: string): ArrayBuffer {
  const raw = readFileSync(join(FIXTURE_ASSET_DIRECTORY, fileName));
  const buffer = new ArrayBuffer(raw.byteLength);
  new Uint8Array(buffer).set(raw);
  return buffer;
}

export function fixtureBytes(fileName: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(fixtureArrayBuffer(fileName));
}

export interface FetchStub {
  /** URLs requested, in call order. */
  calls: string[];
  fetch: (input: unknown) => Promise<Response>;
}

/**
 * Build a fetch stub that answers fixture requests with the real file bytes. Assets in
 * `missing` answer 404 so a recoverable failure can be tested.
 */
export function createFetchStub(options: { missing?: readonly string[] } = {}): FetchStub {
  const missing = new Set(options.missing ?? []);
  const calls: string[] = [];
  return {
    calls,
    async fetch(input: unknown) {
      const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
      calls.push(url);
      const fileName = url.split('/').pop() ?? '';
      if (missing.has(url) || missing.has(fileName)) {
        return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      }
      const asset = ASSET_MANIFEST.find((candidate) => candidate.fileName === fileName);
      if (!asset) {
        return new Response('unknown fixture', { status: 404 });
      }
      const bytes = fixtureBytes(asset.fileName);
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'model/gltf-binary',
          'content-length': String(bytes.byteLength),
        },
      });
    },
  };
}

/**
 * The Three.js file loader streams the response and emits a `ProgressEvent` per chunk.
 * Browsers provide that class; Node does not, so headless tests install the smallest
 * faithful shim instead of hiding the streaming path.
 */
export function installProgressEventShim(): void {
  const scope = globalThis as { ProgressEvent?: unknown };
  if (typeof scope.ProgressEvent === 'function') return;
  class HeadlessProgressEvent {
    readonly type: string;
    readonly lengthComputable: boolean;
    readonly loaded: number;
    readonly total: number;

    constructor(type: string, init: { lengthComputable?: boolean; loaded?: number; total?: number } = {}) {
      this.type = type;
      this.lengthComputable = init.lengthComputable ?? false;
      this.loaded = init.loaded ?? 0;
      this.total = init.total ?? 0;
    }
  }
  scope.ProgressEvent = HeadlessProgressEvent;
}

/**
 * `fetch` in Node rejects a relative URL because there is no document to resolve it
 * against. Tests therefore load the same manifest with an explicit headless origin.
 */
export function manifestForHeadless(
  origin: string = HEADLESS_FIXTURE_ORIGIN,
): AssetDefinition[] {
  return ASSET_MANIFEST.map((asset) => ({ ...asset, url: `${origin}${asset.url}` }));
}

export interface GlbContainer {
  magic: number;
  version: number;
  declaredLength: number;
  byteLength: number;
  chunks: readonly { type: number; length: number }[];
  document: {
    asset?: { version?: string; generator?: string };
    buffers?: readonly { byteLength: number; uri?: string }[];
    images?: readonly unknown[];
    animations?: readonly { name: string; samplers: readonly { input: number }[] }[];
    accessors: readonly { min?: readonly number[]; max?: readonly number[] }[];
    materials?: readonly {
      name?: string;
      pbrMetallicRoughness?: { baseColorFactor?: readonly number[] };
    }[];
  };
}

/** Parse the glTF container of a fixture without a browser or a network stack. */
export function readGlbContainer(bytes: Uint8Array): GlbContainer {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: { type: number; length: number; offset: number }[] = [];
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    chunks.push({ type, length, offset: offset + 8 });
    offset += 8 + length;
  }
  const jsonChunk = chunks[0];
  const document = JSON.parse(
    new TextDecoder().decode(bytes.subarray(jsonChunk.offset, jsonChunk.offset + jsonChunk.length)),
  ) as GlbContainer['document'];
  return {
    magic: view.getUint32(0, true),
    version: view.getUint32(4, true),
    declaredLength: view.getUint32(8, true),
    byteLength: bytes.byteLength,
    chunks: chunks.map((chunk) => ({ type: chunk.type, length: chunk.length })),
    document,
  };
}

/** Parse a fixture GLB straight from disk with the pinned GLTFLoader. */
export async function parseLocalFixture(fileName: string): Promise<GltfAsset> {
  const arrayBuffer = fixtureArrayBuffer(fileName);
  return new Promise<GltfAsset>((resolve, reject) => {
    new GLTFLoader().parse(
      arrayBuffer,
      '',
      (gltf) => resolve(gltf as unknown as GltfAsset),
      reject,
    );
  });
}
