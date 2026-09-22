/**
 * Phase 6 simulation clock and movement, as pure functions.
 *
 * The backend owns the authoritative clock and publishes it in every snapshot. This
 * module applies the same bounded rule to the browser animation, so a vehicle position
 * is a pure function of the published route plan plus the tick clock: the same clock
 * always produces the same position, and two clients given the same snapshot agree.
 *
 * Everything here is independent of WebGL on purpose, which is what keeps the movement
 * unit-testable.
 */

import { createRoadNetwork, type CityPoint, type RoadNetwork } from '../city/dataset';

import type { RoutePlan, ScenarioSnapshot, SimulationState, Vehicle, VehicleRoute } from './scenario';

/** One bounded simulation tick: the clock only moves in whole ticks. */
export const SIMULATION_TICK_SECONDS = 0.5;
/** Hard bound on one clock advance, so a stalled tab cannot jump the animation. */
export const MAX_TICKS_PER_ADVANCE = 240;
export const MIN_SIMULATION_SPEED = 0.25;
export const MAX_SIMULATION_SPEED = 8;
export const DEFAULT_SIMULATION_SPEED = 1;
/** The speeds the control offers. Every one of them is inside the frozen bounds. */
export const SIMULATION_SPEED_CHOICES = [0.5, 1, 2, 4, 8] as const;

export interface RouteLeg {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  lengthMeters: number;
  /** Whole seconds at the slower of the road limit and the robot speed. */
  seconds: number;
}

export interface VehicleSample {
  vehicleId: string;
  /** The node the vehicle occupies: where it departed, or where it arrived. */
  nodeId: string;
  edgeId: string | null;
  progress: number;
  position: CityPoint;
  headingDegrees: number;
  travelledSeconds: number;
  arrived: boolean;
}

export function clampSpeedMultiplier(multiplier: number): number {
  const value = Number(multiplier);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_SIMULATION_SPEED) {
    throw new Error(
      `speedMultiplier must be greater than 0 and at most ${MAX_SIMULATION_SPEED}`,
    );
  }
  return Math.round(value * 1000) / 1000;
}

export function simulationState(options: {
  running: boolean;
  speedMultiplier?: number;
  tick?: number;
}): SimulationState {
  const tick = Math.max(0, Math.trunc(options.tick ?? 0));
  return {
    running: Boolean(options.running),
    speedMultiplier: Math.round((options.speedMultiplier ?? DEFAULT_SIMULATION_SPEED) * 1000) / 1000,
    tick,
    elapsedSeconds: Math.round(tick * SIMULATION_TICK_SECONDS * 1000) / 1000,
  };
}

/** Whole ticks earned by `realSeconds` at `speedMultiplier`, bounded and non-negative. */
export function boundedTickDelta(realSeconds: number, speedMultiplier: number): number {
  if (!(realSeconds > 0) || !(speedMultiplier > 0)) return 0;
  return Math.min(
    MAX_TICKS_PER_ADVANCE,
    Math.trunc((realSeconds * speedMultiplier) / SIMULATION_TICK_SECONDS),
  );
}

/** Advance one clock by a bounded, non-negative number of ticks. */
export function advanceSimulationClock(
  simulation: SimulationState,
  ticks: number,
): SimulationState {
  const bounded = Math.max(0, Math.min(Math.trunc(ticks), MAX_TICKS_PER_ADVANCE));
  return simulationState({
    running: simulation.running,
    speedMultiplier: simulation.speedMultiplier,
    tick: simulation.tick + bounded,
  });
}

export function travelSeconds(
  lengthMeters: number,
  speedLimitKph: number,
  vehicleSpeedKph: number,
): number {
  const effectiveKph = Math.min(speedLimitKph, vehicleSpeedKph);
  if (!(effectiveKph > 0)) throw new Error('effective speed must be positive');
  return Math.ceil(lengthMeters / ((effectiveKph * 1000) / 3600));
}

/**
 * Ordered, driveable legs of a published route.
 *
 * A sequence that is not connected stops there instead of inventing a shortcut, and a
 * leg uses the planner's whole-second rule, so the animation cannot outrun the plan it
 * renders.
 */
export function routeLegs(
  network: RoadNetwork,
  nodeSequence: readonly string[],
  edgeSequence: readonly string[],
  vehicleSpeedKph: number,
): RouteLeg[] {
  if (edgeSequence.length === 0) return [];
  const legs: RouteLeg[] = [];
  let cursor: string | null = nodeSequence[0] ?? null;
  for (const edgeId of edgeSequence) {
    const edge = network.edges.get(edgeId);
    if (!edge || cursor === null) break;
    let origin: string;
    let destination: string;
    if (edge.fromNodeId === cursor) {
      origin = edge.fromNodeId;
      destination = edge.toNodeId;
    } else if (edge.toNodeId === cursor) {
      origin = edge.toNodeId;
      destination = edge.fromNodeId;
    } else {
      break;
    }
    legs.push({
      edgeId,
      fromNodeId: origin,
      toNodeId: destination,
      lengthMeters: edge.lengthMeters,
      seconds: travelSeconds(edge.lengthMeters, edge.speedLimitKph, vehicleSpeedKph),
    });
    cursor = destination;
  }
  return legs;
}

export function headingDegrees(from: CityPoint, to: CityPoint): number {
  const degrees = (Math.atan2(to.x - from.x, to.z - from.z) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** Interpolate one route position at `elapsedSeconds`, clamped to the last stop. */
export function sampleVehicleAt(
  network: RoadNetwork,
  legs: readonly RouteLeg[],
  elapsedSeconds: number,
  startNodeId: string,
): VehicleSample {
  const startPosition = nodePosition(network, startNodeId);
  if (legs.length === 0) {
    return {
      vehicleId: '',
      nodeId: startNodeId,
      edgeId: null,
      progress: 0,
      position: startPosition,
      headingDegrees: 0,
      travelledSeconds: 0,
      arrived: true,
    };
  }

  const total = legs.reduce((sum, leg) => sum + leg.seconds, 0);
  const clamped = Math.max(0, elapsedSeconds);
  let remaining = clamped;
  for (let index = 0; index < legs.length; index += 1) {
    const leg = legs[index];
    const isLast = index === legs.length - 1;
    if (remaining < leg.seconds || isLast) {
      const arrived = clamped >= total;
      const progress = arrived
        ? 1
        : leg.seconds <= 0
          ? 1
          : Math.min(1, Math.max(0, remaining / leg.seconds));
      const from = nodePosition(network, leg.fromNodeId);
      const to = nodePosition(network, leg.toNodeId);
      const position = arrived
        ? to
        : {
            x: from.x + (to.x - from.x) * progress,
            y: from.y + (to.y - from.y) * progress,
            z: from.z + (to.z - from.z) * progress,
          };
      return {
        vehicleId: '',
        nodeId: arrived ? leg.toNodeId : leg.fromNodeId,
        edgeId: arrived ? null : leg.edgeId,
        progress,
        position,
        headingDegrees: headingDegrees(from, to),
        travelledSeconds: Math.min(clamped, total),
        arrived,
      };
    }
    remaining -= leg.seconds;
  }

  const last = legs[legs.length - 1];
  const lastPosition = nodePosition(network, last.toNodeId);
  return {
    vehicleId: '',
    nodeId: last.toNodeId,
    edgeId: null,
    progress: 1,
    position: lastPosition,
    headingDegrees: headingDegrees(nodePosition(network, last.fromNodeId), lastPosition),
    travelledSeconds: total,
    arrived: true,
  };
}

function nodePosition(network: RoadNetwork, nodeId: string): CityPoint {
  const node = network.nodes.get(nodeId);
  if (node) return node.position;
  return { x: 0, y: 0, z: 0 };
}

/**
 * Deterministic sample for every vehicle at `elapsedSeconds`.
 *
 * An empty array means "do not move anything": there is no route plan, or the plan
 * belongs to an older revision than the snapshot. A vehicle with no stops stays on its
 * current node.
 */
export function vehicleSamples(
  snapshot: ScenarioSnapshot,
  elapsedSeconds: number,
  network: RoadNetwork = createRoadNetwork(),
): VehicleSample[] {
  const plan = currentRoutePlan(snapshot);
  if (!plan) return [];
  const routes = new Map(plan.vehicles.map((route) => [route.vehicleId, route]));
  return [...snapshot.vehicles]
    .sort((left, right) => (left.vehicleId < right.vehicleId ? -1 : 1))
    .map((vehicle) => {
      const route = routes.get(vehicle.vehicleId);
      const legs =
        route && route.stops.length > 0
          ? routeLegs(
              network,
              route.nodeSequence,
              route.edgeSequence,
              vehicle.speedKilometersPerHour,
            )
          : [];
      const sample = sampleVehicleAt(
        network,
        legs,
        elapsedSeconds,
        vehicle.currentNodeId ?? '',
      );
      return { ...sample, vehicleId: vehicle.vehicleId };
    });
}

/** The route plan only counts while it belongs to the current revision. */
export function currentRoutePlan(snapshot: ScenarioSnapshot): RoutePlan | null {
  const plan = snapshot.routePlan;
  if (!plan || plan.scenarioRevision !== snapshot.scenarioRevision) return null;
  return plan;
}

export function routeForVehicle(plan: RoutePlan, vehicleId: string): VehicleRoute | null {
  return plan.vehicles.find((route) => route.vehicleId === vehicleId) ?? null;
}

/** Route surfaces for the current plan: one per vehicle that actually drives. */
export function routeSurfaces(
  snapshot: ScenarioSnapshot,
): { vehicleId: string; startNodeId: string | null; edgeIds: readonly string[] }[] {
  const plan = currentRoutePlan(snapshot);
  if (!plan) return [];
  return plan.vehicles
    .filter((route) => route.edgeSequence.length > 0)
    .map((route) => ({
      vehicleId: route.vehicleId,
      startNodeId: route.nodeSequence[0] ?? null,
      edgeIds: route.edgeSequence,
    }));
}

/**
 * Scene placement for every vehicle at `elapsedSeconds`.
 *
 * These are plain values, not Three.js objects, so the mapping from the snapshot to the
 * scene stays testable without a renderer.
 */
export function vehiclePlacements(
  snapshot: ScenarioSnapshot,
  elapsedSeconds: number,
  liftedVehicleId: string | null = null,
  network: RoadNetwork = createRoadNetwork(),
): {
  vehicleId: string;
  nodeId: string;
  position: CityPoint;
  headingDegrees: number;
  lifted: boolean;
}[] {
  const samples = vehicleSamples(snapshot, elapsedSeconds, network);
  if (samples.length > 0) {
    return samples.map((sample) => ({
      vehicleId: sample.vehicleId,
      nodeId: sample.nodeId,
      position: sample.position,
      headingDegrees: sample.headingDegrees,
      lifted: sample.vehicleId === liftedVehicleId,
    }));
  }
  // No plan yet: the fleet still has to be visible, parked on its current node.
  return [...snapshot.vehicles]
    .sort((left, right) => (left.vehicleId < right.vehicleId ? -1 : 1))
    .map((vehicle) => ({
      vehicleId: vehicle.vehicleId,
      nodeId: vehicle.currentNodeId ?? '',
      position: nodePosition(network, vehicle.currentNodeId ?? ''),
      headingDegrees: 0,
      lifted: vehicle.vehicleId === liftedVehicleId,
    }));
}

export function isSimulationRunning(snapshot: ScenarioSnapshot | null): boolean {
  return Boolean(snapshot?.simulation.running);
}

/** Human-readable clock for the control panel. */
export function simulationClockLabel(simulation: SimulationState): string {
  const seconds = simulation.elapsedSeconds;
  const state = simulation.running ? 'Running' : simulation.tick > 0 ? 'Paused' : 'Stopped';
  return `${state} · tick ${simulation.tick} · ${seconds.toFixed(1)}s · x${simulation.speedMultiplier}`;
}

export function isSpeedChoice(value: number): boolean {
  return (SIMULATION_SPEED_CHOICES as readonly number[]).includes(value);
}

export function vehicleById(
  snapshot: ScenarioSnapshot | null,
  vehicleId: string | null,
): Vehicle | null {
  if (!snapshot || !vehicleId) return null;
  return snapshot.vehicles.find((vehicle) => vehicle.vehicleId === vehicleId) ?? null;
}
