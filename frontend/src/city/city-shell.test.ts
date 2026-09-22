/**
 * Phase 3 city shell.
 *
 * The shell is the place where the Phase 2 scene shell and the new city meet: the same
 * lighting rig, the same renderer factory and the same disposal rules, with an
 * isometric orthographic camera and a selection helper that survives navigation.
 */

import { OrthographicCamera, type Scene, type Camera } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { loadSceneAssets, type SceneAssetBundle } from '../scene/load-assets';
import {
  createFetchStub,
  installProgressEventShim,
  manifestForHeadless,
} from '../scene/local-fixtures';
import { WebGLUnavailableError, type RendererLike } from '../scene/scene-shell';

import { groundPointFromNdc, ndcFromGroundPoint, pixelToNdc } from './city-camera';
import { createCityShell } from './city-shell';
import { CITY_DATASET, SNAP_EDGE_MAX_RADIUS_M, SNAP_NODE_MAX_RADIUS_M } from './dataset';

installProgressEventShim();

const WIDTH = 960;
const HEIGHT = 540;
const DEPOT = CITY_DATASET.nodes.find((node) => node.kind === 'DEPOT')!;

async function loadBundle(): Promise<SceneAssetBundle> {
  vi.stubGlobal('fetch', vi.fn(createFetchStub().fetch));
  return loadSceneAssets({ assets: manifestForHeadless() });
}

function pixelOf(point: { x: number; y: number; z: number }, camera: OrthographicCamera) {
  const ndc = ndcFromGroundPoint(camera, point);
  return { x: ((ndc.x + 1) / 2) * WIDTH, y: ((1 - ndc.y) / 2) * HEIGHT };
}

describe('city shell without WebGL', () => {
  it('still builds, renders and disposes, and explains why there is no preview', () => {
    const shell = createCityShell({ width: WIDTH, height: HEIGHT });

    expect(shell.renderer).toBeNull();
    expect(shell.rendererError).toMatch(/canvas|WebGL/i);
    expect(() => shell.render()).not.toThrow();
    shell.dispose();
  });

  it('reports the WebGL failure raised by an injected renderer factory', () => {
    const shell = createCityShell({
      width: WIDTH,
      height: HEIGHT,
      createRenderer: () => {
        throw new WebGLUnavailableError('no context in this environment');
      },
    });

    expect(shell.rendererError).toBe('no context in this environment');
    shell.dispose();
  });
});

describe('city shell integration with the Phase 2 scene shell', () => {
  it('reuses the lighting rig and renders through an orthographic camera', async () => {
    const bundle = await loadBundle();
    const rendered: { scene: Scene; camera: Camera }[] = [];
    const sizes: number[] = [];
    const renderer: RendererLike = {
      setSize: (width) => sizes.push(width),
      render: (scene, camera) => rendered.push({ scene, camera }),
      dispose: () => undefined,
    };
    const shell = createCityShell({
      width: WIDTH,
      height: HEIGHT,
      createRenderer: () => renderer,
    });

    const report = shell.buildCity(bundle);
    shell.render();

    const rig = shell.scene.getObjectByName('LightingRig');
    expect(rig?.children.map((child) => child.name)).toEqual([
      'AmbientLight',
      'KeyLight',
      'FillLight',
      'RimLight',
    ]);
    expect(shell.camera).toBeInstanceOf(OrthographicCamera);
    expect(rendered).toHaveLength(1);
    expect(rendered[0].camera).toBe(shell.camera);
    expect(rendered[0].scene).toBe(shell.scene);
    expect(report.roadEdgeIds.length).toBe(CITY_DATASET.edges.length);
    expect(shell.lastBuild).toBe(report);

    shell.resize(800, 600);
    expect(sizes).toEqual([800]);
    shell.dispose();
  });

  it('replaces the built city instead of stacking a second copy', async () => {
    const bundle = await loadBundle();
    const shell = createCityShell({ width: WIDTH, height: HEIGHT });

    shell.buildCity(bundle);
    shell.buildCity(bundle);

    expect(shell.cityRoot.children).toHaveLength(1);
    expect(shell.cityRoot.children[0].name).toBe('CityRoot');
    shell.dispose();
  });
});

describe('city selection', () => {
  it('resolves a ground point to the road node and edge under the pointer', () => {
    const shell = createCityShell({ width: WIDTH, height: HEIGHT });
    const ndc = ndcFromGroundPoint(shell.camera, DEPOT.position);

    const selection = shell.selectAtNdc(ndc);

    expect(selection?.node?.nodeId).toBe(DEPOT.nodeId);
    expect(selection?.node?.kind).toBe('DEPOT');
    expect(selection?.node?.distanceMeters).toBeLessThan(1e-6);
    expect(selection?.edge?.edgeId).toBeTruthy();
    expect(selection?.nodeRadiusMeters).toBe(SNAP_NODE_MAX_RADIUS_M);
    expect(selection?.edgeRadiusMeters).toBe(SNAP_EDGE_MAX_RADIUS_M);
    shell.dispose();
  });

  it('agrees with the pixel helper', () => {
    const shell = createCityShell({ width: WIDTH, height: HEIGHT });
    const target = { x: 48, y: 0, z: 58 };
    const ndc = ndcFromGroundPoint(shell.camera, target);
    const pixel = pixelOf(target, shell.camera);

    const fromNdc = shell.selectAtNdc(ndc);
    const fromPixel = shell.selectAtPixel(pixel.x, pixel.y);

    expect(fromPixel?.ground.x).toBeCloseTo(fromNdc!.ground.x, 6);
    expect(fromPixel?.ground.z).toBeCloseTo(fromNdc!.ground.z, 6);
    expect(fromPixel?.node?.nodeId).toBe(fromNdc?.node?.nodeId);
    expect(pixelToNdc(pixel.x, pixel.y, WIDTH, HEIGHT).x).toBeCloseTo(ndc.x, 9);
    shell.dispose();
  });

  it('keeps the same node selectable after zoom, pan and resize', () => {
    const shell = createCityShell({ width: WIDTH, height: HEIGHT });
    const before = shell.selectAtNdc(ndcFromGroundPoint(shell.camera, DEPOT.position));

    shell.controls.zoomBy(1.6);
    shell.controls.panByPixels(-120, 64);
    shell.resize(720, 720);
    const after = shell.selectAtNdc(ndcFromGroundPoint(shell.camera, DEPOT.position));

    expect(before?.node?.nodeId).toBe(DEPOT.nodeId);
    expect(after?.node?.nodeId).toBe(DEPOT.nodeId);
    expect(after?.ground.x).toBeCloseTo(DEPOT.position.x, 6);
    expect(after?.ground.z).toBeCloseTo(DEPOT.position.z, 6);
    shell.dispose();
  });

  it('reports the coordinates but no node or edge outside the contract radius', () => {
    const shell = createCityShell({ width: WIDTH, height: HEIGHT });
    const midBlock = { x: 24, y: 0, z: 24 };
    const selection = shell.selectAtNdc(ndcFromGroundPoint(shell.camera, midBlock));

    expect(selection?.node).toBeNull();
    expect(selection?.edge).toBeNull();
    expect(selection?.ground.x).toBeCloseTo(midBlock.x, 6);
    expect(selection?.ground.z).toBeCloseTo(midBlock.z, 6);
    shell.dispose();
  });

  it('maps a normalised coordinate back to the ground plane it came from', () => {
    const shell = createCityShell({ width: WIDTH, height: HEIGHT });
    const point = { x: -96, y: 0, z: 112 };
    const ndc = ndcFromGroundPoint(shell.camera, point);
    const ground = groundPointFromNdc(shell.camera, ndc);

    expect(ground?.x).toBeCloseTo(point.x, 6);
    expect(ground?.z).toBeCloseTo(point.z, 6);
    expect(ground?.y).toBe(0);
    shell.dispose();
  });
});

describe('city shell disposal', () => {
  it('releases the lighting rig and the city resources and clears the scene', async () => {
    const bundle = await loadBundle();
    const shell = createCityShell({ width: WIDTH, height: HEIGHT });
    shell.buildCity(bundle);
    const usage = shell.registry.usage;

    const report = shell.dispose();

    expect(report.alreadyDisposed).toBe(false);
    expect(report.geometryCount).toBe(usage.geometryCount);
    expect(report.materialCount).toBe(usage.materialCount);
    expect(shell.scene.children).toHaveLength(0);
    expect(shell.registry.dispose().alreadyDisposed).toBe(true);
  });
});
