/**
 * Phase 3 isometric camera and navigation.
 *
 * The property that matters is stated once and then checked after every navigation
 * step: a ground point maps to a normalised device coordinate and back to the same
 * ground point, so a click lands on the node the user aimed at no matter how the view
 * was zoomed, panned or resized.
 */

import { OrthographicCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { CITY_DATASET } from './dataset';
import {
  ISOMETRIC_AZIMUTH_DEGREES,
  ISOMETRIC_ELEVATION_DEGREES,
  MAX_CITY_ZOOM,
  MIN_CITY_ZOOM,
  boundsCenter,
  boundsDiagonal,
  createCityControls,
  groundPointFromNdc,
  isometricDirection,
  ndcFromGroundPoint,
  pixelToNdc,
  type CityControls,
} from './city-camera';

const WIDTH = 960;
const HEIGHT = 540;

function controls(): CityControls {
  return createCityControls({ width: WIDTH, height: HEIGHT, bounds: { ...CITY_DATASET.bounds } });
}

function roundTrip(control: CityControls, point: { x: number; y: number; z: number }): void {
  const ndc = ndcFromGroundPoint(control.camera, point);
  const back = groundPointFromNdc(control.camera, ndc);

  expect(back, `no ground hit for ${JSON.stringify(point)}`).not.toBeNull();
  expect(back?.x).toBeCloseTo(point.x, 6);
  expect(back?.z).toBeCloseTo(point.z, 6);
  expect(back?.y).toBe(0);
}

const SAMPLE_POINTS = [
  { x: 0, y: 0, z: 0 },
  { x: -200, y: 0, z: -168 },
  { x: 200, y: 0, z: 168 },
  { x: 48.5, y: 0, z: -58.25 },
];

describe('isometric direction', () => {
  it('is the true isometric diagonal', () => {
    const direction = isometricDirection();
    const expected = 1 / Math.sqrt(3);

    expect(direction.length()).toBeCloseTo(1, 12);
    expect(direction.x).toBeCloseTo(expected, 12);
    expect(direction.y).toBeCloseTo(expected, 12);
    expect(direction.z).toBeCloseTo(expected, 12);
    expect(ISOMETRIC_AZIMUTH_DEGREES).toBe(45);
    expect(ISOMETRIC_ELEVATION_DEGREES).toBeCloseTo(35.26438968275465, 9);
  });
});

describe('pixelToNdc', () => {
  it('maps the canvas corners to the device coordinate corners', () => {
    expect(pixelToNdc(0, 0, WIDTH, HEIGHT)).toEqual({ x: -1, y: 1 });
    expect(pixelToNdc(WIDTH, HEIGHT, WIDTH, HEIGHT)).toEqual({ x: 1, y: -1 });
    expect(pixelToNdc(WIDTH / 2, HEIGHT / 2, WIDTH, HEIGHT)).toEqual({ x: 0, y: 0 });
  });
});

describe('city controls', () => {
  it('frames the whole city with an orthographic isometric camera', () => {
    const control = controls();
    const camera = control.camera;
    const diagonal = boundsDiagonal(CITY_DATASET.bounds);
    const centre = boundsCenter(CITY_DATASET.bounds);
    const direction = isometricDirection();

    expect(camera).toBeInstanceOf(OrthographicCamera);
    expect(camera.zoom).toBe(1);
    expect(camera.up.equals(new Vector3(0, 1, 0))).toBe(true);
    expect(control.frustumHeight).toBeGreaterThan(diagonal);
    expect((camera.top - camera.bottom) / (camera.right - camera.left)).toBeCloseTo(
      HEIGHT / WIDTH,
      9,
    );
    expect(control.target).toEqual({ x: centre.x, y: 0, z: centre.z });
    expect(camera.position.x - centre.x).toBeCloseTo(direction.x * diagonal, 6);
    expect(camera.position.z - centre.z).toBeCloseTo(direction.z * diagonal, 6);
  });

  it('round-trips ground points through the projection', () => {
    const control = controls();
    for (const point of SAMPLE_POINTS) {
      roundTrip(control, point);
    }
  });

  it('round-trips after zooming', () => {
    const control = controls();
    control.zoomIn();
    control.zoomIn();
    expect(control.zoom).toBeGreaterThan(1);
    for (const point of SAMPLE_POINTS) {
      roundTrip(control, point);
    }
    control.zoomOut();
    roundTrip(control, SAMPLE_POINTS[1]);
  });

  it('clamps the zoom to the supported range', () => {
    const control = controls();
    for (let step = 0; step < 60; step += 1) control.zoomIn();
    expect(control.zoom).toBeCloseTo(MAX_CITY_ZOOM, 9);
    for (let step = 0; step < 120; step += 1) control.zoomOut();
    expect(control.zoom).toBeCloseTo(MIN_CITY_ZOOM, 9);
  });

  it('slides the ground by exactly the dragged pixel distance', () => {
    const control = controls();
    const point = { x: 0, y: 0, z: 0 };
    const before = ndcFromGroundPoint(control.camera, point);

    control.panByPixels(48, -24);

    const after = ndcFromGroundPoint(control.camera, point);
    expect(after.x - before.x).toBeCloseTo((2 * 48) / WIDTH, 9);
    expect(after.y - before.y).toBeCloseTo((2 * 24) / HEIGHT, 9);
    roundTrip(control, point);
  });

  it('keeps the drag-to-pixel ratio when zoomed in', () => {
    const control = controls();
    const point = { x: 0, y: 0, z: 0 };
    control.zoomBy(2);
    const before = ndcFromGroundPoint(control.camera, point);

    control.panByPixels(30, 0);

    const after = ndcFromGroundPoint(control.camera, point);
    expect(after.x - before.x).toBeCloseTo((2 * 30) / WIDTH, 9);
    roundTrip(control, point);
  });

  it('keeps the aspect ratio and the mapping on resize', () => {
    const control = controls();
    control.resize(640, 400);

    expect((control.camera.top - control.camera.bottom) / (control.camera.right - control.camera.left))
      .toBeCloseTo(400 / 640, 9);
    for (const point of SAMPLE_POINTS) {
      roundTrip(control, point);
    }
  });

  it('recentres on request and restores the initial framing on reset', () => {
    const control = controls();
    const depot = CITY_DATASET.nodes.find((node) => node.kind === 'DEPOT') as {
      position: { x: number; y: number; z: number };
    };

    control.focusOn({ x: depot.position.x, z: depot.position.z });
    expect(control.target).toEqual({ x: depot.position.x, y: 0, z: depot.position.z });
    roundTrip(control, depot.position);

    control.zoomBy(2);
    control.panByPixels(120, 90);
    control.reset();

    expect(control.zoom).toBe(1);
    expect(control.target).toEqual(boundsCenter(CITY_DATASET.bounds));
    roundTrip(control, depot.position);
  });

  it('keeps a selection on the same node across zoom, pan and resize', () => {
    const control = controls();
    const depot = CITY_DATASET.nodes.find((node) => node.kind === 'DEPOT') as {
      position: { x: number; y: number; z: number };
    };

    const ndc = ndcFromGroundPoint(control.camera, depot.position);
    control.panByPixels(-64, 32);
    control.zoomBy(1.4);
    control.resize(800, 600);
    const moved = ndcFromGroundPoint(control.camera, depot.position);

    const ground = groundPointFromNdc(control.camera, moved);
    expect(ground?.x).toBeCloseTo(depot.position.x, 6);
    expect(ground?.z).toBeCloseTo(depot.position.z, 6);
    expect(moved.x).not.toBeCloseTo(ndc.x, 3);
  });
});
