// Verificacion sin navegador de la prueba tecnica GLB:
//   1. comprueba la estructura binaria del fichero glTF 2.0;
//   2. carga el GLB con GLTFLoader.parse (sin DOM y sin sockets);
//   3. selecciona el objeto con Raycaster, igual que hara la demo.
//
// Ejecucion: npm install && npm run verify  (dentro de spike/fase0/glb)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as THREE from 'three';

const here = dirname(fileURLToPath(import.meta.url));
const GLB_PATH = join(here, 'assets', 'spike-cube.glb');

const failures = [];
const report = {};

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return true;
  }
  const message = detail ? `${label}: ${detail}` : label;
  failures.push(message);
  console.log(`  FAIL  ${message}`);
  return false;
}

function validateGlbStructure(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  check('GLB: fichero con cabecera', arrayBuffer.byteLength >= 20, `bytes=${arrayBuffer.byteLength}`);
  const magic = view.getUint32(0, true);
  check('GLB: magic glTF', magic === 0x46546c67, `magic=0x${magic.toString(16)}`);
  const version = view.getUint32(4, true);
  check('GLB: version 2', version === 2, `version=${version}`);
  const totalLength = view.getUint32(8, true);
  check(
    'GLB: longitud declarada',
    totalLength === arrayBuffer.byteLength,
    `${totalLength} != ${arrayBuffer.byteLength}`,
  );

  const chunks = [];
  let offset = 12;
  while (offset + 8 <= arrayBuffer.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    chunks.push({ chunkLength, chunkType, dataOffset: offset + 8 });
    offset += 8 + chunkLength;
  }
  check('GLB: chunks dentro de los limites', offset === arrayBuffer.byteLength, `fin=${offset}`);
  check('GLB: chunk JSON primero', chunks[0] && chunks[0].chunkType === 0x4e4f534a);
  check('GLB: chunk BIN segundo', chunks[1] && chunks[1].chunkType === 0x004e4942);

  const jsonText = new TextDecoder().decode(
    new Uint8Array(arrayBuffer, chunks[0].dataOffset, chunks[0].chunkLength),
  );
  const document = JSON.parse(jsonText);
  check('glTF: asset.version 2.0', document.asset && document.asset.version === '2.0');
  check('glTF: un unico buffer', document.buffers && document.buffers.length === 1);
  check(
    'glTF: byteLength del buffer coincide con el chunk BIN',
    document.buffers[0].byteLength === chunks[1].chunkLength,
    `${document.buffers[0].byteLength} != ${chunks[1].chunkLength}`,
  );

  const bin = new Uint8Array(arrayBuffer, chunks[1].dataOffset, chunks[1].chunkLength);
  const primitive = document.meshes[0].primitives[0];
  const positionAccessor = document.accessors[primitive.attributes.POSITION];
  const positionView = document.bufferViews[positionAccessor.bufferView];
  const positionBytes = new Float32Array(
    bin.buffer,
    bin.byteOffset + positionView.byteOffset,
    positionAccessor.count * 3,
  );
  const computedMin = [Infinity, Infinity, Infinity];
  const computedMax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positionAccessor.count; i += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positionBytes[i * 3 + axis];
      computedMin[axis] = Math.min(computedMin[axis], value);
      computedMax[axis] = Math.max(computedMax[axis], value);
    }
  }
  check(
    'glTF: min/max del POSITION coincide con los datos',
    computedMin.every((value, axis) => Math.abs(value - positionAccessor.min[axis]) < 1e-6) &&
      computedMax.every((value, axis) => Math.abs(value - positionAccessor.max[axis]) < 1e-6),
    `${computedMin} / ${computedMax}`,
  );

  report.vertexCount = positionAccessor.count;
  report.indexCount = document.accessors[primitive.indices].count;
  return document;
}

async function importGltfLoader() {
  const candidates = [
    'three/addons/loaders/GLTFLoader.js',
    'three/examples/jsm/loaders/GLTFLoader.js',
  ];
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

async function main() {
  console.log('== Estructura del GLB ==');
  const fileBuffer = readFileSync(GLB_PATH);
  const arrayBuffer = fileBuffer.buffer.slice(
    fileBuffer.byteOffset,
    fileBuffer.byteOffset + fileBuffer.byteLength,
  );
  const document = validateGlbStructure(arrayBuffer);

  console.log('== Carga con GLTFLoader ==');
  const { GLTFLoader } = await importGltfLoader();
  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().parse(arrayBuffer, '', resolve, reject);
  });
  const scene = gltf.scene;
  check('GLTFLoader: escena creada', Boolean(scene));

  let mesh = null;
  let vertexCount = 0;
  scene.traverse((object) => {
    if (object.isMesh) {
      mesh = object;
      vertexCount += object.geometry.getAttribute('position').count;
    }
  });
  check('GLTFLoader: un mesh', Boolean(mesh));
  check('GLTFLoader: nodo con nombre', mesh && mesh.name === 'SpikeCube', `nombre=${mesh && mesh.name}`);
  check(
    'GLTFLoader: 24 vertices (6 caras x 4)',
    vertexCount === 24 && vertexCount === document.accessors[0].count,
    `vertices=${vertexCount}`,
  );
  check('GLTFLoader: material presente', Boolean(mesh && mesh.material));

  const bounds = new THREE.Box3().setFromObject(scene);
  check(
    'GLTFLoader: caja 2x2x2 centrada en el origen',
    Math.abs(bounds.min.x + 1) < 1e-6 &&
      Math.abs(bounds.max.x - 1) < 1e-6 &&
      Math.abs(bounds.min.y + 1) < 1e-6 &&
      Math.abs(bounds.max.y - 1) < 1e-6,
    `${bounds.min.toArray()} / ${bounds.max.toArray()}`,
  );

  console.log('== Seleccion con Raycaster ==');
  const raycaster = new THREE.Raycaster(
    new THREE.Vector3(0, 0, 5),
    new THREE.Vector3(0, 0, -1).normalize(),
  );
  const hits = raycaster.intersectObject(scene, true);
  const hit = hits.find((entry) => entry.object.isMesh);
  check('Raycaster: el rayo impacta el GLB', Boolean(hit), 'sin interseccion');
  check('Raycaster: el objeto impactado es el seleccionable', hit && hit.object.name === 'SpikeCube');
  report.selectedObject = hit ? hit.object.name : null;
  report.hitDistance = hit ? Number(hit.distance.toFixed(4)) : null;
  report.glbBytes = fileBuffer.byteLength;

  console.log('\nResumen:');
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    console.log(`\nRESULTADO: FALLO (${failures.length} problemas)`);
    for (const failure of failures) {
      console.log(`  - ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log('\nRESULTADO: OK');
}

await main();
