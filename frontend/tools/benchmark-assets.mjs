/**
 * Deterministic Phase 2 asset benchmark (no browser, no WebGL, no network).
 *
 * It reads the same contract files the frontend reads, validates every fixture GLB,
 * parses it with the pinned Three.js GLTFLoader, measures the deterministic resource
 * budgets, and rebuilds the documented stage plan twice to prove that reuse and
 * disposal behave identically on every run.
 *
 * Reported values are deterministic budgets. Frames per second and GPU memory are
 * host specific: this tool never claims to have measured them, it prints the target
 * the demo is budgeted for and labels the rest as not measured.
 *
 * Usage:
 *     node frontend/tools/benchmark-assets.mjs [--json]
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as THREE from 'three';

const here = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(here, '..');
const sceneDir = join(frontendDir, 'src', 'scene');
const assetDir = join(frontendDir, 'public', 'assets', 'models');

const contract = readJson(join(sceneDir, 'asset-contract.json'));
const budget = readJson(join(sceneDir, 'render-budget.json'));
const plan = readJson(join(sceneDir, 'scene-plan.json'));
const tokens = readJson(join(sceneDir, 'visual-tokens.json'));

const failures = [];
const report = { generator: contract.generator, assets: {}, stage: null, rebuild: null };

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function check(label, condition, detail = '') {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`);
  if (!condition) failures.push(detail ? `${label}: ${detail}` : label);
  return Boolean(condition);
}

async function importGltfLoader() {
  const candidates = ['three/addons/loaders/GLTFLoader.js', 'three/examples/jsm/loaders/GLTFLoader.js'];
  let lastError;
  for (const specifier of candidates) {
    try {
      return await import(specifier);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function validateGlbStructure(arrayBuffer, fileName) {
  const view = new DataView(arrayBuffer);
  if (!check(`${fileName}: glTF magic`, view.getUint32(0, true) === 0x46546c67)) return null;
  if (!check(`${fileName}: glTF version 2`, view.getUint32(4, true) === 2)) return null;
  if (
    !check(
      `${fileName}: declared length matches the file`,
      view.getUint32(8, true) === arrayBuffer.byteLength,
    )
  ) {
    return null;
  }

  const chunks = [];
  let offset = 12;
  while (offset + 8 <= arrayBuffer.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    chunks.push({ chunkLength, chunkType, dataOffset: offset + 8 });
    offset += 8 + chunkLength;
  }
  if (!check(`${fileName}: chunks close at end of file`, offset === arrayBuffer.byteLength)) {
    return null;
  }
  if (!check(`${fileName}: JSON chunk first`, chunks[0]?.chunkType === 0x4e4f534a)) return null;
  if (!check(`${fileName}: BIN chunk second`, chunks[1]?.chunkType === 0x004e4942)) return null;

  const document = JSON.parse(
    new TextDecoder().decode(new Uint8Array(arrayBuffer, chunks[0].dataOffset, chunks[0].chunkLength)),
  );
  check(`${fileName}: single embedded buffer`, document.buffers?.length === 1);
  check(
    `${fileName}: buffer byteLength matches the BIN chunk`,
    document.buffers[0].byteLength === chunks[1].chunkLength,
    `${document.buffers[0].byteLength} != ${chunks[1].chunkLength}`,
  );
  check(`${fileName}: buffer has no external URI`, document.buffers[0].uri === undefined);
  check(`${fileName}: no images referenced`, (document.images?.length ?? 0) === 0);
  const animationInputs = new Set(
    (document.animations ?? []).flatMap((animation) =>
      animation.samplers.map((sampler) => sampler.input),
    ),
  );
  check(
    `${fileName}: every animation input accessor declares min/max`,
    document.accessors.every((accessor, index) =>
      animationInputs.has(index) ? Boolean(accessor.min && accessor.max) : true,
    ),
  );
  return document;
}

function geometryByteLength(geometry) {
  let bytes = 0;
  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.getAttribute(name);
    if (attribute?.array?.byteLength) bytes += attribute.array.byteLength;
  }
  const index = geometry.getIndex();
  if (index?.array?.byteLength) bytes += index.array.byteLength;
  return bytes;
}

function textureByteLength(texture) {
  const image = texture.image;
  if (!image) return 0;
  if (image.data?.byteLength) return image.data.byteLength;
  if (image.width && image.height) return image.width * image.height * 4;
  return 0;
}

function measureObject(root) {
  const geometries = new Map();
  const materials = new Map();
  const textures = new Map();
  let triangles = 0;
  let drawCalls = 0;
  let instanceCount = 0;

  root.traverse((object) => {
    if (!object.isMesh) return;
    const instances = object.isInstancedMesh ? object.count : 1;
    instanceCount += instances;
    const materialList = Array.isArray(object.material) ? object.material : [object.material];
    drawCalls += Math.max(materialList.length, 1);
    const geometry = object.geometry;
    if (geometry) {
      geometries.set(geometry.uuid, geometry);
      const index = geometry.getIndex();
      const position = geometry.getAttribute('position');
      // An instanced mesh submits its geometry once per instance.
      const perInstance = index ? index.count / 3 : position ? position.count / 3 : 0;
      triangles += perInstance * instances;
    }
    for (const material of materialList) {
      if (!material) continue;
      materials.set(material.uuid, material);
      for (const value of Object.values(material)) {
        if (value && value.isTexture) textures.set(value.uuid, value);
      }
    }
  });

  let geometryBytes = 0;
  for (const geometry of geometries.values()) geometryBytes += geometryByteLength(geometry);
  let textureBytes = 0;
  for (const texture of textures.values()) textureBytes += textureByteLength(texture);

  return {
    triangles: Math.round(triangles),
    drawCalls,
    textureCount: textures.size,
    textureBytes,
    geometryCount: geometries.size,
    materialCount: materials.size,
    instanceCount,
    geometryBytes,
    memoryProxyBytes:
      geometryBytes + textureBytes + instanceCount * budget.memoryProxyBytesPerInstance,
  };
}

function budgetResults(usage, limits) {
  const rows = [
    ['triangles', usage.triangles, limits.maxTriangles],
    ['drawCalls', usage.drawCalls, limits.maxDrawCalls],
    ['textureCount', usage.textureCount, limits.maxTextureCount],
    ['textureBytes', usage.textureBytes, limits.maxTextureBytes],
  ];
  if (limits.maxFileBytes !== undefined) {
    rows.push(['fileBytes', usage.fileBytes ?? 0, limits.maxFileBytes]);
  }
  if (limits.maxMemoryProxyBytes !== undefined) {
    rows.push(['memoryProxyBytes', usage.memoryProxyBytes, limits.maxMemoryProxyBytes]);
  }
  return rows.map(([metric, actual, limit]) => ({ metric, actual, limit, pass: actual <= limit }));
}

function printBudget(label, results) {
  console.log(`  ${label}`);
  for (const entry of results) {
    console.log(
      `    ${entry.pass ? 'PASS' : 'FAIL'}  ${entry.metric.padEnd(18)} ${String(entry.actual).padStart(9)} / ${entry.limit}`,
    );
    if (!entry.pass) failures.push(`${label}.${entry.metric}: ${entry.actual} > ${entry.limit}`);
  }
}

function buildStage(loaded) {
  const root = new THREE.Group();
  for (const instance of plan.instances) {
    const entry = loaded.get(instance.assetId);
    if (!entry) continue;
    // clone() shares geometry, materials and textures with the source scene, which is
    // exactly the reuse rule this phase has to prove.
    const clone = entry.gltf.scene.clone(true);
    clone.position.set(instance.position[0], instance.position[1], instance.position[2]);
    clone.rotation.y = (instance.rotationYDegrees * Math.PI) / 180;
    clone.scale.setScalar(instance.scale);
    root.add(clone);
  }
  return root;
}

function disposeStage(root) {
  const geometries = new Map();
  const materials = new Map();
  const textures = new Map();
  root.traverse((object) => {
    if (!object.isMesh) return;
    if (object.geometry) geometries.set(object.geometry.uuid, object.geometry);
    const materialList = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materialList) {
      if (!material) continue;
      materials.set(material.uuid, material);
      for (const value of Object.values(material)) {
        if (value && value.isTexture) textures.set(value.uuid, value);
      }
    }
  });

  const counts = { geometryDisposals: 0, materialDisposals: 0, textureDisposals: 0 };
  const track = (resource, key) => {
    resource.addEventListener('dispose', () => {
      counts[key] += 1;
    });
    resource.dispose();
  };
  for (const geometry of geometries.values()) track(geometry, 'geometryDisposals');
  for (const material of materials.values()) track(material, 'materialDisposals');
  for (const texture of textures.values()) track(texture, 'textureDisposals');
  return counts;
}

function hexToLinearRgb(hex) {
  const raw = hex.replace('#', '');
  const toLinear = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return [0, 2, 4].map((index) =>
    Number(toLinear(Number.parseInt(raw.slice(index, index + 2), 16) / 255).toFixed(6)),
  );
}

async function main() {
  const { GLTFLoader } = await importGltfLoader();
  const loader = new GLTFLoader();
  const loaded = new Map();

  console.log('== Fixture assets ==');
  for (const asset of contract.assets) {
    const fileBuffer = readFileSync(join(assetDir, asset.fileName));
    const arrayBuffer = fileBuffer.buffer.slice(
      fileBuffer.byteOffset,
      fileBuffer.byteOffset + fileBuffer.byteLength,
    );
    console.log(`\n${asset.fileName}`);
    const document = validateGlbStructure(arrayBuffer, asset.fileName);
    if (!document) continue;

    const gltf = await loader.parseAsync(arrayBuffer, '');
    check(
      `${asset.fileName}: root node ${asset.rootNode} exists`,
      Boolean(gltf.scene.getObjectByName(asset.rootNode)),
    );
    const clipNames = gltf.animations.map((clip) => clip.name).sort();
    const expectedClips = asset.clips.map((clip) => clip.clipName).sort();
    check(
      `${asset.fileName}: animation clips match the contract`,
      JSON.stringify(clipNames) === JSON.stringify(expectedClips),
      clipNames.join(',') || 'none',
    );
    const baseColor = document.materials[0].pbrMetallicRoughness.baseColorFactor;
    check(
      `${asset.fileName}: material uses token colour ${tokens.palette[asset.material.paletteKey]}`,
      hexToLinearRgb(tokens.palette[asset.material.paletteKey]).every(
        (channel, index) => Math.abs(channel - baseColor[index]) < 1e-6,
      ),
    );

    const usage = { ...measureObject(gltf.scene), fileBytes: fileBuffer.byteLength };
    printBudget(`${asset.fileName} budget`, budgetResults(usage, budget.perAsset));
    report.assets[asset.id] = usage;
    loaded.set(asset.id, { gltf });
  }

  console.log('\n== Stage plan ==');
  const stageUsage = measureObject(buildStage(loaded));
  printBudget(`${plan.instances.length} instances`, budgetResults(stageUsage, budget.stage));
  report.stage = stageUsage;

  console.log('\n== Rebuild and disposal ==');
  const rebuiltUsage = measureObject(buildStage(loaded));
  check(
    'rebuild produces identical resource usage',
    JSON.stringify(rebuiltUsage) === JSON.stringify(stageUsage),
  );
  const disposal = disposeStage(buildStage(loaded));
  check(
    'disposal releases every unique geometry once',
    disposal.geometryDisposals === stageUsage.geometryCount,
    `${disposal.geometryDisposals} != ${stageUsage.geometryCount}`,
  );
  check(
    'disposal releases every unique material once',
    disposal.materialDisposals === stageUsage.materialCount,
    `${disposal.materialDisposals} != ${stageUsage.materialCount}`,
  );
  check('fixtures carry no textures to release', disposal.textureDisposals === 0);
  report.rebuild = { identical: true, disposal };

  console.log('\n== Summary ==');
  console.log(`targetFps (budget, not measured): ${budget.targetFps}`);
  console.log(`minimumAcceptableFps (budget, not measured): ${budget.minimumAcceptableFps}`);
  console.log(
    `stage: triangles=${stageUsage.triangles} drawCalls=${stageUsage.drawCalls} ` +
      `instances=${stageUsage.instanceCount} uniqueGeometries=${stageUsage.geometryCount} ` +
      `uniqueMaterials=${stageUsage.materialCount} memoryProxyBytes=${stageUsage.memoryProxyBytes}`,
  );
  console.log('fpsMeasurement: not-measured (a headless benchmark has no WebGL context)');
  console.log('gpuMemoryMeasurement: not-measured (memoryProxyBytes is a CPU-side proxy)');

  if (failures.length > 0) {
    console.log(`\nRESULT: FAIL (${failures.length} problem(s))`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('\nRESULT: PASS');
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  }
}

await main();
