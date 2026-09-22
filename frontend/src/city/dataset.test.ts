/**
 * Phase 3 dataset contract.
 *
 * The dataset is the single source for the city, so these checks are the ones that keep
 * the shared rules honest: canonical identifiers, real XZ lengths, a reachable depot,
 * a decorative spline that stays decoration, and no map service anywhere near the
 * project.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CITY_DATASET,
  canonicalEdgeId,
  createRoadNetwork,
  distanceXz,
  forbiddenMapTokensFound,
  reachableNodeIds,
  roadWidthMetersFor,
  scanForForbiddenMapReferences,
  validateCityDataset,
  type CityDataset,
} from './dataset';

const FRONTEND_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_ROOT = join(FRONTEND_ROOT, 'src');
const CITY_DIRECTORY = join(SRC_ROOT, 'city');

function cloneDataset(): CityDataset {
  return structuredClone(CITY_DATASET) as CityDataset;
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    found.push(path);
  }
  return found;
}

describe('city dataset shape', () => {
  it('is coherent, so the validator reports no problem', () => {
    expect(validateCityDataset(CITY_DATASET)).toEqual([]);
  });

  it('declares a city of the documented size with one depot and delivery nodes', () => {
    expect(CITY_DATASET.cityId).toBe('robot-city');
    expect(CITY_DATASET.units).toBe('meters');
    expect(CITY_DATASET.coordinateSystem).toBe('local-xz-up-y');
    expect(CITY_DATASET.graphVersion).toBeGreaterThanOrEqual(1);

    expect(CITY_DATASET.nodes.length).toBeGreaterThanOrEqual(40);
    expect(CITY_DATASET.nodes.length).toBeLessThanOrEqual(80);
    expect(CITY_DATASET.nodes.filter((node) => node.kind === 'DEPOT')).toHaveLength(1);
    expect(CITY_DATASET.nodes.filter((node) => node.kind === 'DELIVERY').length).toBeGreaterThan(8);
    expect(CITY_DATASET.edges.length).toBeGreaterThan(CITY_DATASET.nodes.length);
    expect(CITY_DATASET.blocks.length).toBeGreaterThan(0);
    expect(CITY_DATASET.landmarks.length).toBeGreaterThan(0);
  });

  it('keeps every node on the flat ground plane inside the declared bounds', () => {
    for (const node of CITY_DATASET.nodes) {
      expect(node.position.y, node.nodeId).toBe(0);
      expect(node.position.x, node.nodeId).toBeGreaterThanOrEqual(CITY_DATASET.bounds.minX);
      expect(node.position.x, node.nodeId).toBeLessThanOrEqual(CITY_DATASET.bounds.maxX);
      expect(node.position.z, node.nodeId).toBeGreaterThanOrEqual(CITY_DATASET.bounds.minZ);
      expect(node.position.z, node.nodeId).toBeLessThanOrEqual(CITY_DATASET.bounds.maxZ);
    }
  });

  it('never stores a geographic coordinate', () => {
    const raw = readFileSync(new URL('./robot-city.json', import.meta.url), 'utf8');
    expect(scanForForbiddenMapReferences(raw)).toEqual([]);
  });
});

describe('edge identifiers and lengths', () => {
  it('uses the canonical pair for every edge', () => {
    const seen = new Set<string>();
    for (const edge of CITY_DATASET.edges) {
      expect(edge.edgeId, edge.edgeId).toBe(canonicalEdgeId(edge.fromNodeId, edge.toNodeId));
      expect(edge.fromNodeId < edge.toNodeId, edge.edgeId).toBe(true);
      expect(seen.has(edge.edgeId), `${edge.edgeId} is duplicated`).toBe(false);
      seen.add(edge.edgeId);
      expect(edge.bidirectional).toBe(true);
      expect(edge.speedLimitKph).toBeGreaterThan(0);
    }
  });

  it('derives every length from the node positions', () => {
    const network = createRoadNetwork();
    for (const edge of CITY_DATASET.edges) {
      const from = network.nodes.get(edge.fromNodeId);
      const to = network.nodes.get(edge.toNodeId);
      expect(from && to, edge.edgeId).toBeTruthy();
      if (!from || !to) continue;
      expect(edge.lengthMeters, edge.edgeId).toBeCloseTo(distanceXz(from.position, to.position), 9);
    }
  });

  it('resolves a declared road width for every speed limit', () => {
    for (const edge of CITY_DATASET.edges) {
      expect(roadWidthMetersFor(edge), edge.edgeId).toBeGreaterThan(0);
    }
  });
});

describe('reachability', () => {
  it('reaches every node and every delivery node from the depot without barriers', () => {
    const network = createRoadNetwork();
    const reachable = reachableNodeIds(network, network.depotNodeId);

    expect(reachable.size).toBe(CITY_DATASET.nodes.length);
    expect(network.deliveryNodeIds.length).toBeGreaterThan(8);
    for (const nodeId of network.deliveryNodeIds) {
      expect(reachable.has(nodeId), nodeId).toBe(true);
    }
  });

  it('drops a zone once its edges are blocked, and reports it as unreachable', () => {
    const dataset = cloneDataset();
    const network = createRoadNetwork(dataset);
    const victim = network.deliveryNodeIds.find((nodeId) => {
      const incident = dataset.edges.filter(
        (edge) => edge.fromNodeId === nodeId || edge.toNodeId === nodeId,
      );
      return incident.length === 2;
    });
    expect(victim).toBeTruthy();
    const blocked = dataset.edges
      .filter((edge) => edge.fromNodeId === victim || edge.toNodeId === victim)
      .map((edge) => edge.edgeId);

    const reachable = reachableNodeIds(network, network.depotNodeId, blocked);

    expect(reachable.has(victim as string)).toBe(false);
  });
});

describe('decorative spline', () => {
  it('starts and ends exactly on the node positions', () => {
    const network = createRoadNetwork();
    for (const edge of CITY_DATASET.edges) {
      const from = network.nodes.get(edge.fromNodeId);
      const to = network.nodes.get(edge.toNodeId);
      const spline = edge.visualSplineControlPoints;
      expect(spline.length, edge.edgeId).toBeGreaterThanOrEqual(2);
      expect(spline[0], edge.edgeId).toEqual(from?.position);
      expect(spline[spline.length - 1], edge.edgeId).toEqual(to?.position);
    }
  });

  it('bows most roads away from the logical line, which keeps the two apart', () => {
    let bowed = 0;
    for (const edge of CITY_DATASET.edges) {
      const start = edge.visualSplineControlPoints[0];
      const middle = edge.visualSplineControlPoints[1];
      const sx = start.x + (edge.visualSplineControlPoints[2].x - start.x) / 2;
      const sz = start.z + (edge.visualSplineControlPoints[2].z - start.z) / 2;
      if (Math.hypot(middle.x - sx, middle.z - sz) > 0.05) bowed += 1;
    }
    expect(bowed).toBeGreaterThan(CITY_DATASET.edges.length * 0.6);
  });
});

describe('validation rejects a broken dataset', () => {
  it('catches a non-canonical edge id', () => {
    const dataset = cloneDataset();
    const edge = dataset.edges[0];
    // The reversed pair is never a valid identifier: `E-N002-N001` cannot exist.
    edge.edgeId = `E-${edge.toNodeId.replace('-', '')}-${edge.fromNodeId.replace('-', '')}`;

    const problems = validateCityDataset(dataset).join(' ');
    expect(problems).toMatch(/canonical/);
    expect(problems).toMatch(/lexicographically|id is not the canonical pair/);
  });

  it('catches a length that is not the XZ distance', () => {
    const dataset = cloneDataset();
    dataset.edges[0].lengthMeters += 1;

    expect(validateCityDataset(dataset).join(' ')).toMatch(/lengthMeters/);
  });

  it('catches an undeclared property on a node', () => {
    const dataset = cloneDataset();
    (dataset.nodes[0] as unknown as Record<string, unknown>).latitude = 41.4;

    expect(validateCityDataset(dataset).join(' ')).toMatch(/unexpected property/);
  });

  it('catches a spline that does not start on its node', () => {
    const dataset = cloneDataset();
    const spline = dataset.edges[0].visualSplineControlPoints as { x: number; y: number; z: number }[];
    spline[0] = { x: 1, y: 0, z: 1 };

    expect(validateCityDataset(dataset).join(' ')).toMatch(/must start on/);
  });

  it('catches an isolated delivery node', () => {
    const dataset = cloneDataset();
    const victim = dataset.nodes.find(
      (node) =>
        node.kind === 'DELIVERY' &&
        dataset.edges.filter(
          (edge) => edge.fromNodeId === node.nodeId || edge.toNodeId === node.nodeId,
        ).length === 2,
    );
    const isolated = victim?.nodeId as string;
    dataset.edges = dataset.edges.filter(
      (edge) => edge.fromNodeId !== isolated && edge.toNodeId !== isolated,
    );

    expect(validateCityDataset(dataset).join(' ')).toMatch(/unreachable/);
  });

  it('catches a depot without a landmark', () => {
    const dataset = cloneDataset();
    dataset.landmarks = [];

    expect(validateCityDataset(dataset).join(' ')).toMatch(/depot node has no landmark/);
  });
});

describe('source guards', () => {
  it('keeps map-service tokens out of the whole frontend source tree', () => {
    const files = [...sourceFiles(SRC_ROOT), join(FRONTEND_ROOT, 'tools', 'build_city_dataset.mjs')];
    const offenders: string[] = [];
    for (const file of files) {
      for (const problem of forbiddenMapTokensFound(readFileSync(file, 'utf8'))) {
        offenders.push(`${file}: ${problem}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps external URLs out of the city module', () => {
    for (const file of sourceFiles(CITY_DIRECTORY)) {
      expect(scanForForbiddenMapReferences(readFileSync(file, 'utf8')), file).toEqual([]);
    }
  });

  it('declares no map or routing dependency', () => {
    const manifest = JSON.parse(readFileSync(join(FRONTEND_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const forbidden = Object.keys(manifest.dependencies).filter((name) =>
      /leaflet|mapbox|maplibre|openlayers|^ol$|osrm|google-maps|@google|here-|bing-maps/.test(name),
    );

    expect(forbidden).toEqual([]);
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['react', 'react-dom', 'three']);
  });

  it('matches the committed file byte for byte with the deterministic generator', () => {
    const output = execFileSync('node', ['tools/build_city_dataset.mjs', '--check'], {
      cwd: FRONTEND_ROOT,
      encoding: 'utf8',
    });

    expect(output).toMatch(/^OK: robot-city matches the generator/);
  });
});
