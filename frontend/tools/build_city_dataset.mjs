#!/usr/bin/env node
/**
 * Deterministic generator for the Phase 3 robot city dataset.
 *
 * The dataset is one JSON document that drives every city consumer: the road graph,
 * the renderer and the coordinate selection helpers. It is generated from a fixed seed
 * and pure arithmetic, so the same seed always produces the same bytes and `--check`
 * is a safe gate.
 *
 * Rules the generator honours (see `docs/contracts/world-graph-rules.md`):
 *
 * - local XZ plane, Y up, metres: no geographic coordinates and no map projection;
 * - node ids are assigned in generation order and never reused;
 * - an edge id is the canonical pair `E-N###-N###` with the lexicographically smaller
 *   node first, so `E-N002-N001` can never appear;
 * - `lengthMeters` is the XZ distance between the edge endpoints, never a guess;
 * - `visualSplineControlPoints` is presentation only. It starts and ends exactly on the
 *   node positions and bows laterally in the middle; nothing in the graph is derived
 *   from it.
 *
 * Usage:
 *     node frontend/tools/build_city_dataset.mjs           # write the dataset
 *     node frontend/tools/build_city_dataset.mjs --check   # fail if it differs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, '..', 'src', 'city', 'robot-city.json');

export const CITY_SEED = 20260922;
export const CITY_ID = 'robot-city';
export const GRAPH_VERSION = 1;
export const CAPTURED_AT = '2026-09-22';

/** Road grid in metres. The depot sits on the crossing of the two central avenues. */
export const GRID_X = [-200, -144, -96, -48, 0, 48, 96, 144, 200];
export const GRID_Z = [-168, -112, -58, 0, 58, 112, 168];
export const DEPOT_COLUMN = 4;
export const DEPOT_ROW = 3;

const SPEED_AVENUE_KPH = 50;
const SPEED_RING_KPH = 40;
const SPEED_STREET_KPH = 30;

const ROAD_WIDTH_BY_SPEED_KPH = { 30: 7, 40: 8.5, 50: 10 };
const ROUTE_WIDTH_METERS = 2.2;

/** Cosmetic bow of a road, as a fraction of its length, in the closed range below. */
const MAX_BOW_RATIO = 0.022;
/** Inset between a road edge and the block pad that sits next to it. */
const BLOCK_GAP_METERS = 0.6;
const PLAZA_KIND = 'PLAZA';
const PARK_KIND = 'PARK';
const BUILT_KIND = 'BUILT';

/**
 * mulberry32: a tiny deterministic PRNG. `Math.random()` is forbidden by the world
 * rules, and a seeded generator is what makes `--check` meaningful.
 */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function nodeIdFor(column, row) {
  const index = row * GRID_X.length + column + 1;
  return `N-${String(index).padStart(3, '0')}`;
}

/** Canonical edge id: the lexicographically smaller node id comes first, dash removed. */
export function canonicalEdgeId(firstNodeId, secondNodeId) {
  const [low, high] = [firstNodeId, secondNodeId].sort();
  return `E-${low.replace('-', '')}-${high.replace('-', '')}`;
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function point(x, z) {
  return { x, y: 0, z };
}

function horizontalSpeedKph(row) {
  if (row === DEPOT_ROW) return SPEED_AVENUE_KPH;
  if (row === 0 || row === GRID_Z.length - 1) return SPEED_RING_KPH;
  return SPEED_STREET_KPH;
}

function verticalSpeedKph(column) {
  if (column === DEPOT_COLUMN) return SPEED_AVENUE_KPH;
  if (column === 0 || column === GRID_X.length - 1) return SPEED_RING_KPH;
  return SPEED_STREET_KPH;
}

function roadWidthMeters(speedLimitKph) {
  return ROAD_WIDTH_BY_SPEED_KPH[speedLimitKph];
}

/**
 * Cosmetic road polyline for one edge: the exact endpoints plus one laterally bowed
 * midpoint. Keeping both endpoints on the nodes is what stops a junction from showing
 * a gap; the single midpoint is one straight segment away from the logical line on each
 * side, which is all the road surface needs.
 */
function visualSplineControlPoints(from, to, amplitude) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  const normalX = length === 0 ? 0 : -dz / length;
  const normalZ = length === 0 ? 0 : dx / length;
  const t = 0.5;
  return [
    point(from.x, from.z),
    point(
      round(from.x + dx * t + normalX * amplitude, 3),
      round(from.z + dz * t + normalZ * amplitude, 3),
    ),
    point(to.x, to.z),
  ];
}

function buildNodes() {
  const deliveryKeys = new Set();
  const lastColumn = GRID_X.length - 1;
  const lastRow = GRID_Z.length - 1;
  for (let row = 0; row <= lastRow; row += 1) {
    for (let column = 0; column <= lastColumn; column += 1) {
      const onRing = row === 0 || row === lastRow || column === 0 || column === lastColumn;
      if (onRing && (row + column) % 2 === 0) {
        deliveryKeys.add(`${column}:${row}`);
      }
    }
  }
  for (const [column, row] of [
    [2, 2],
    [6, 2],
    [2, 4],
    [6, 4],
  ]) {
    deliveryKeys.add(`${column}:${row}`);
  }
  if (deliveryKeys.has(`${DEPOT_COLUMN}:${DEPOT_ROW}`)) {
    deliveryKeys.delete(`${DEPOT_COLUMN}:${DEPOT_ROW}`);
  }

  const nodes = [];
  for (let row = 0; row <= lastRow; row += 1) {
    for (let column = 0; column <= lastColumn; column += 1) {
      const isDepot = column === DEPOT_COLUMN && row === DEPOT_ROW;
      const kind = isDepot
        ? 'DEPOT'
        : deliveryKeys.has(`${column}:${row}`)
          ? 'DELIVERY'
          : 'JUNCTION';
      const node = {
        nodeId: nodeIdFor(column, row),
        kind,
        position: point(GRID_X[column], GRID_Z[row]),
      };
      // Only the depot carries a presentation label; the other nodes are described by
      // their kind and their position.
      if (isDepot) node.label = 'Central depot';
      nodes.push(node);
    }
  }
  return nodes;
}

function buildEdges(nodes) {
  const byCell = new Map();
  for (const node of nodes) {
    const column = GRID_X.indexOf(node.position.x);
    const row = GRID_Z.indexOf(node.position.z);
    byCell.set(`${column}:${row}`, node);
  }

  const edges = [];
  const random = createRandom(CITY_SEED);
  const lastColumn = GRID_X.length - 1;
  const lastRow = GRID_Z.length - 1;
  const addEdge = (first, second, speedLimitKph) => {
    const [from, to] = [first, second].sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
    const length = Math.hypot(
      to.position.x - from.position.x,
      to.position.z - from.position.z,
    );
    const amplitude = length * (random() * 2 - 1) * MAX_BOW_RATIO;
    edges.push({
      edgeId: canonicalEdgeId(from.nodeId, to.nodeId),
      fromNodeId: from.nodeId,
      toNodeId: to.nodeId,
      bidirectional: true,
      lengthMeters: length,
      speedLimitKph,
      visualSplineControlPoints: visualSplineControlPoints(
        from.position,
        to.position,
        amplitude,
      ),
    });
  };

  for (let row = 0; row <= lastRow; row += 1) {
    for (let column = 0; column < lastColumn; column += 1) {
      addEdge(
        byCell.get(`${column}:${row}`),
        byCell.get(`${column + 1}:${row}`),
        horizontalSpeedKph(row),
      );
    }
  }
  for (let column = 0; column <= lastColumn; column += 1) {
    for (let row = 0; row < lastRow; row += 1) {
      addEdge(
        byCell.get(`${column}:${row}`),
        byCell.get(`${column}:${row + 1}`),
        verticalSpeedKph(column),
      );
    }
  }
  return edges;
}

function halfWidthAt(column, row) {
  return roadWidthMeters(verticalSpeedKph(column)) / 2 + BLOCK_GAP_METERS;
}

function halfHeightAt(column, row) {
  return roadWidthMeters(horizontalSpeedKph(row)) / 2 + BLOCK_GAP_METERS;
}

function blockKind(column, row) {
  const isDepotSquare = (column === DEPOT_COLUMN || column === DEPOT_COLUMN - 1)
    && (row === DEPOT_ROW || row === DEPOT_ROW - 1);
  if (isDepotSquare) return PLAZA_KIND;
  if ((column * 5 + row * 11) % 13 === 3) return PARK_KIND;
  return BUILT_KIND;
}

/**
 * Buildings are placed on a deterministic sub-grid inside each built block. A cell that
 * is too small, or that the seeded generator skips, simply stays empty; the important
 * part is that the same seed always produces the same placements.
 */
function buildingPlacements(random, block) {
  if (block.kind !== BUILT_KIND) return [];
  const columns = block.size.x >= 30 ? 2 : 1;
  const rows = block.size.z >= 30 ? 2 : 1;
  const cellSizeX = block.size.x / columns;
  const cellSizeZ = block.size.z / rows;
  const margin = 3.4;
  const buildings = [];
  for (let cellRow = 0; cellRow < rows; cellRow += 1) {
    for (let cellColumn = 0; cellColumn < columns; cellColumn += 1) {
      if (random() < 0.16) continue;
      const usableX = cellSizeX - margin * 2;
      const usableZ = cellSizeZ - margin * 2;
      if (usableX < 11 || usableZ < 11) continue;
      const centerX = block.center.x - block.size.x / 2 + (cellColumn + 0.5) * cellSizeX;
      const centerZ = block.center.z - block.size.z / 2 + (cellRow + 0.5) * cellSizeZ;
      const footprint = Math.min(usableX, usableZ);
      const scale = round(2.4 + random() * Math.min(2.2, footprint / 5 - 1.3), 2);
      const quarterTurn = random() < 0.5;
      const jitter = (random() * 8 - 4);
      buildings.push({
        x: round(centerX + (random() * 2 - 1) * 1.4, 3),
        z: round(centerZ + (random() * 2 - 1) * 1.4, 3),
        rotationYDegrees: round((quarterTurn ? 90 : 0) + jitter, 1),
        scale: Math.max(2.4, scale),
      });
    }
  }
  return buildings;
}

function buildBlocks(random) {
  const blocks = [];
  for (let column = 0; column < GRID_X.length - 1; column += 1) {
    for (let row = 0; row < GRID_Z.length - 1; row += 1) {
      const westInset = halfWidthAt(column, row);
      const eastInset = halfWidthAt(column + 1, row);
      const northInset = halfHeightAt(column, row);
      const southInset = halfHeightAt(column, row + 1);
      const minX = GRID_X[column] + westInset;
      const maxX = GRID_X[column + 1] - eastInset;
      const minZ = GRID_Z[row] + northInset;
      const maxZ = GRID_Z[row + 1] - southInset;
      if (maxX - minX <= 0 || maxZ - minZ <= 0) continue;
      const block = {
        blockId: `BLK-${String(column + 1).padStart(2, '0')}-${String(row + 1).padStart(2, '0')}`,
        kind: blockKind(column, row),
        center: { x: round((minX + maxX) / 2, 3), z: round((minZ + maxZ) / 2, 3) },
        size: { x: round(maxX - minX, 3), z: round(maxZ - minZ, 3) },
        buildings: [],
      };
      block.buildings = buildingPlacements(random, block);
      blocks.push(block);
    }
  }
  return blocks;
}

export function generateCityDataset() {
  const nodes = buildNodes();
  const edges = buildEdges(nodes);
  const blocks = buildBlocks(createRandom(CITY_SEED ^ 0x5f3759df));
  const depotNode = nodes.find((node) => node.kind === 'DEPOT');
  const landmarks = [
    {
      landmarkId: 'L-DEPOT',
      nodeId: depotNode.nodeId,
      assetId: 'depotLandmark',
      rotationYDegrees: 0,
      scale: 4,
    },
  ];

  return {
    cityId: CITY_ID,
    graphVersion: GRAPH_VERSION,
    capturedAt: CAPTURED_AT,
    generator: 'roboroute-nexus-phase3-city-generator',
    seed: CITY_SEED,
    units: 'meters',
    coordinateSystem: 'local-xz-up-y',
    bounds: {
      minX: Math.min(...GRID_X),
      maxX: Math.max(...GRID_X),
      minZ: Math.min(...GRID_Z),
      maxZ: Math.max(...GRID_Z),
    },
    presentation: {
      groundMarginMeters: 40,
      routeWidthMeters: ROUTE_WIDTH_METERS,
      roadWidthMetersBySpeedKph: {
        [SPEED_STREET_KPH]: ROAD_WIDTH_BY_SPEED_KPH[SPEED_STREET_KPH],
        [SPEED_RING_KPH]: ROAD_WIDTH_BY_SPEED_KPH[SPEED_RING_KPH],
        [SPEED_AVENUE_KPH]: ROAD_WIDTH_BY_SPEED_KPH[SPEED_AVENUE_KPH],
      },
      blockPadHeightMeters: 0.06,
      roadSurfaceHeightMeters: 0.02,
      routeSurfaceHeightMeters: 0.08,
      buildingAssetId: 'buildingFixture',
    },
    nodes,
    edges,
    blocks,
    landmarks,
  };
}

export function serializeCityDataset(dataset = generateCityDataset()) {
  return `${JSON.stringify(dataset, null, 2)}\n`;
}

function summarize(dataset) {
  const kinds = dataset.nodes.reduce((accumulator, node) => {
    accumulator[node.kind] = (accumulator[node.kind] ?? 0) + 1;
    return accumulator;
  }, {});
  const blocks = dataset.blocks.reduce((accumulator, block) => {
    accumulator[block.kind] = (accumulator[block.kind] ?? 0) + 1;
    return accumulator;
  }, {});
  const buildings = dataset.blocks.reduce((total, block) => total + block.buildings.length, 0);
  return [
    `${dataset.cityId} seed=${dataset.seed} graphVersion=${dataset.graphVersion}`,
    `nodes=${dataset.nodes.length} (${Object.entries(kinds)
      .map(([kind, count]) => `${kind}:${count}`)
      .join(' ')})`,
    `edges=${dataset.edges.length}`,
    `blocks=${dataset.blocks.length} (${Object.entries(blocks)
      .map(([kind, count]) => `${kind}:${count}`)
      .join(' ')})`,
    `buildings=${buildings} landmarks=${dataset.landmarks.length}`,
  ];
}

function main(argv) {
  const dataset = generateCityDataset();
  const serialized = serializeCityDataset(dataset);
  const check = argv.includes('--check');

  if (check) {
    let committed;
    try {
      committed = readFileSync(outputPath, 'utf8');
    } catch (error) {
      console.log(`FAIL: cannot read ${outputPath}: ${error.message}`);
      return 1;
    }
    if (committed === serialized) {
      console.log(`OK: ${dataset.cityId} matches the generator`);
      for (const line of summarize(dataset)) console.log(`  ${line}`);
      return 0;
    }
    console.log(`FAIL: ${outputPath} differs from the generated dataset`);
    console.log('  Run `npm run fixture:city` and commit the result.');
    return 1;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized, 'utf8');
  console.log(`OK: wrote ${outputPath}`);
  for (const line of summarize(dataset)) console.log(`  ${line}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
