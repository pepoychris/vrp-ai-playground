// Prueba tecnica de Fase 0: cargar el GLB, seleccionarlo con Raycaster y publicar el
// resultado en window.__spikeStatus para poder comprobarlo desde el navegador.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const GLB_URL = '../assets/spike-cube.glb';

const canvas = document.getElementById('canvas-root');
const statusElement = document.getElementById('status');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(4, 3.5, 6);
camera.lookAt(0, 0, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 2.0));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
keyLight.position.set(5, 8, 6);
scene.add(keyLight);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

const spikeStatus = {
  glbLoaded: false,
  glbUrl: GLB_URL,
  objectName: null,
  meshCount: 0,
  vertexCount: 0,
  selected: false,
  selectionMode: 'raycaster',
  error: null,
};
window.__spikeStatus = spikeStatus;

function updateStatus(line) {
  statusElement.textContent = line;
}

function render() {
  renderer.render(scene, camera);
}

canvas.addEventListener('pointerdown', (event) => {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(scene.children, true);
  const hit = hits.find((entry) => entry.object.isMesh);
  spikeStatus.selected = Boolean(hit);
  if (hit) {
    spikeStatus.objectName = hit.object.name;
    updateStatus(
      `Seleccionado: ${hit.object.name}\nDistancia al rayo: ${hit.distance.toFixed(2)}\nGLB cargado correctamente.`,
    );
  } else {
    updateStatus('Sin objeto bajo el puntero.\nGLB cargado correctamente.');
  }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  render();
});

new GLTFLoader().load(
  GLB_URL,
  (gltf) => {
    scene.add(gltf.scene);
    let meshCount = 0;
    let vertexCount = 0;
    gltf.scene.traverse((object) => {
      if (object.isMesh) {
        meshCount += 1;
        spikeStatus.objectName = spikeStatus.objectName ?? object.name;
        vertexCount += object.geometry.getAttribute('position').count;
      }
    });
    spikeStatus.glbLoaded = true;
    spikeStatus.meshCount = meshCount;
    spikeStatus.vertexCount = vertexCount;
    updateStatus(
      `GLB cargado: ${meshCount} mesh, ${vertexCount} vertices.\nHaz clic sobre el cubo para seleccionarlo.`,
    );
    render();
  },
  undefined,
  (error) => {
    spikeStatus.error = String(error && error.message ? error.message : error);
    updateStatus(`Error al cargar el GLB: ${spikeStatus.error}`);
  },
);
