import { useEffect, useRef, useState } from 'react';

import type { CitySelection, CityShell } from '../city/city-shell';
import type { CityPoint } from '../city/dataset';
import {
  applyGestureToPlacements,
  beginClawGesture,
  describeClawDrop,
  describeClawPreview,
  resolveClawDrop,
  updateClawGesture,
  type ClawGesture,
} from '../city/vehicle-gesture';
import type { SceneAssetBundle } from '../scene/load-assets';
import type { ScenarioSnapshot, SimulationState } from '../scenario/scenario';
import {
  advanceSimulationClock,
  boundedTickDelta,
  routeSurfaces,
  simulationState,
  vehicleById,
  vehiclePlacements,
} from '../scenario/simulation';

export interface SceneStageProps {
  bundle: SceneAssetBundle | null;
  snapshot: ScenarioSnapshot | null;
  /** Called once, on release, when the claw drops a vehicle on a different node. */
  onRelocateVehicle: (vehicleId: string, position: CityPoint) => void;
}

type StageStatus = 'waiting' | 'ready' | 'unavailable' | 'failed';
type PointerMode = 'pan' | 'claw';

const KEYBOARD_PAN_PIXELS = 28;
const CLICK_SLOP_PIXELS = 3;
const DEFAULT_STAGE_WIDTH = 720;
const DEFAULT_STAGE_HEIGHT = 420;

function stageWidth(canvas: HTMLCanvasElement): number {
  return canvas.clientWidth || DEFAULT_STAGE_WIDTH;
}

function stageHeight(canvas: HTMLCanvasElement): number {
  return canvas.clientHeight || DEFAULT_STAGE_HEIGHT;
}

/**
 * One line of coordinates for the last click. It shows the local x/z point the pointer
 * resolved to, plus whatever the contract radius found there, so the selection mapping
 * is visible while navigating the city.
 */
function describeSelection(selection: CitySelection): string {
  const parts = [`x ${selection.ground.x.toFixed(1)} m, z ${selection.ground.z.toFixed(1)} m`];
  parts.push(
    selection.node
      ? `node ${selection.node.nodeId} (${selection.node.kind}) at ${selection.node.distanceMeters.toFixed(1)} m`
      : `no node within ${selection.nodeRadiusMeters} m`,
  );
  parts.push(
    selection.edge
      ? `edge ${selection.edge.edgeId} at ${selection.edge.distanceMeters.toFixed(1)} m`
      : `no edge within ${selection.edgeRadiusMeters} m`,
  );
  return parts.join(' | ');
}

function describeVehicleSelection(
  snapshot: ScenarioSnapshot,
  vehicleId: string,
  nodeId: string,
  position: CityPoint,
): string {
  const vehicle = vehicleById(snapshot, vehicleId);
  return (
    `Selected ${vehicleId}${vehicle ? ` (${vehicle.status})` : ''} on node ${nodeId} · ` +
    `x ${position.x.toFixed(1)} m, z ${position.z.toFixed(1)} m`
  );
}

export function SceneStage({ bundle, snapshot, onRelocateVehicle }: SceneStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shellRef = useRef<CityShell | null>(null);
  const snapshotRef = useRef<ScenarioSnapshot | null>(snapshot);
  const relocateRef = useRef(onRelocateVehicle);
  const gestureRef = useRef<ClawGesture | null>(null);
  const clockRef = useRef<SimulationState>(simulationState({ running: false }));
  const [status, setStatus] = useState<StageStatus>('waiting');
  const [summary, setSummary] = useState<string | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [gestureNote, setGestureNote] = useState<string | null>(null);
  const [clock, setClock] = useState<SimulationState>(simulationState({ running: false }));

  useEffect(() => {
    relocateRef.current = onRelocateVehicle;
  }, [onRelocateVehicle]);

  // The authoritative clock is the one published in the snapshot; a new revision always
  // reseeds it, so a local tick can never be replayed onto a newer revision.
  useEffect(() => {
    snapshotRef.current = snapshot;
    const seeded = snapshot ? snapshot.simulation : simulationState({ running: false });
    clockRef.current = seeded;
    setClock(seeded);
  }, [snapshot]);

  useEffect(() => {
    if (!bundle) {
      setStatus('waiting');
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let shell: CityShell | null = null;
    let observer: ResizeObserver | null = null;
    const cleanups: (() => void)[] = [];
    let pointerMode: PointerMode | null = null;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let travelled = 0;

    const drawPlacements = () => {
      const active = snapshotRef.current;
      const activeShell = shellRef.current;
      if (!active || !activeShell) return;
      const placements = vehiclePlacements(active, clockRef.current.elapsedSeconds, null);
      activeShell.updateVehiclePlacements(
        applyGestureToPlacements(placements, gestureRef.current),
      );
    };

    void (async () => {
      try {
        const { createCityShell } = await import('../city/city-shell');
        if (cancelled) return;
        const created = createCityShell({
          canvas,
          width: stageWidth(canvas),
          height: stageHeight(canvas),
        });
        if (cancelled) {
          created.dispose();
          return;
        }
        shell = created;
        shellRef.current = created;
        const report = created.buildCity(bundle);
        const active = created;
        active.render();
        setSummary(
          `${active.network.nodeIds.length} nodes, ${report.roadEdgeIds.length} road edges, ` +
            `${report.blockCount} blocks, ${report.buildingCount} buildings, ` +
            `${report.landmarkCount} landmark`,
        );
        if (active.rendererError) {
          setStatus('unavailable');
          return;
        }
        setStatus('ready');

        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(() => {
            active.resize(stageWidth(canvas), stageHeight(canvas));
            active.render();
          });
          observer.observe(canvas);
        }

        const onWheel = (event: WheelEvent) => {
          event.preventDefault();
          if (event.deltaY < 0) {
            active.controls.zoomIn();
          } else {
            active.controls.zoomOut();
          }
          active.render();
        };
        canvas.addEventListener('wheel', onWheel, { passive: false });
        cleanups.push(() => canvas.removeEventListener('wheel', onWheel));

        // The right button is reserved for the claw, so the browser menu never opens
        // over the canvas.
        const onContextMenu = (event: MouseEvent) => {
          event.preventDefault();
        };
        canvas.addEventListener('contextmenu', onContextMenu);
        cleanups.push(() => canvas.removeEventListener('contextmenu', onContextMenu));

        const releasePointer = (pointerId: number) => {
          if (canvas.hasPointerCapture(pointerId)) {
            canvas.releasePointerCapture(pointerId);
          }
          active.setCameraEnabled(true);
          canvas.classList.remove('stage__canvas--grabbing');
        };

        /**
         * Finish a claw gesture. A rejected drop — or a drop on the node the robot
         * already occupies — only restores the visual state; only an accepted drop on a
         * different node asks the application to relocate the vehicle.
         */
        const finishClawGesture = (pointerId: number, commit: boolean) => {
          const gesture = gestureRef.current;
          pointerMode = null;
          releasePointer(pointerId);
          if (!gesture) return;
          const drop = resolveClawDrop(gesture, active.network);
          gestureRef.current = null;
          active.setClawLift(gesture.vehicleId, false);
          setGestureNote(describeClawDrop(drop, gesture.originNodeId));
          const shouldRelocate =
            commit && drop.accepted && drop.nodeId !== gesture.originNodeId;
          if (shouldRelocate) {
            relocateRef.current(gesture.vehicleId, gesture.pointer);
          }
          drawPlacements();
          active.render();
        };

        const onPointerDown = (event: PointerEvent) => {
          const activeSnapshot = snapshotRef.current;
          if (event.button === 2) {
            if (!activeSnapshot) return;
            const vehicleId = active.pickVehicleAtPixel(event.offsetX, event.offsetY);
            if (!vehicleId) return;
            event.preventDefault();
            const vehicle = vehicleById(activeSnapshot, vehicleId);
            const originNodeId = vehicle?.currentNodeId ?? '';
            const originPosition =
              active.network.nodes.get(originNodeId)?.position ?? { x: 0, y: 0, z: 0 };
            const pointer =
              active.groundPointAtPixel(event.offsetX, event.offsetY) ?? originPosition;
            const gesture = beginClawGesture({
              pointerId: event.pointerId,
              vehicleId,
              originNodeId,
              originPosition,
              pointer,
              network: active.network,
            });
            gestureRef.current = gesture;
            pointerMode = 'claw';
            travelled = 0;
            canvas.setPointerCapture(event.pointerId);
            canvas.classList.add('stage__canvas--grabbing');
            active.setCameraEnabled(false);
            active.setClawLift(vehicleId, true);
            setGestureNote(describeClawPreview(gesture.preview));
            drawPlacements();
            active.render();
            return;
          }
          if (event.button !== 0) return;
          dragging = true;
          pointerMode = 'pan';
          lastX = event.offsetX;
          lastY = event.offsetY;
          travelled = 0;
          canvas.setPointerCapture(event.pointerId);
          canvas.classList.add('stage__canvas--dragging');
        };

        const onPointerMove = (event: PointerEvent) => {
          if (pointerMode === 'claw') {
            const gesture = gestureRef.current;
            if (!gesture) return;
            const pointer = active.groundPointAtPixel(event.offsetX, event.offsetY);
            if (!pointer) return;
            const next = updateClawGesture(gesture, pointer, active.network);
            if (next === gesture) return;
            gestureRef.current = next;
            setGestureNote(describeClawPreview(next.preview));
            drawPlacements();
            active.render();
            return;
          }
          if (!dragging) return;
          const deltaX = event.offsetX - lastX;
          const deltaY = event.offsetY - lastY;
          lastX = event.offsetX;
          lastY = event.offsetY;
          travelled += Math.abs(deltaX) + Math.abs(deltaY);
          active.controls.panByPixels(deltaX, deltaY);
          active.render();
        };

        const onPointerUp = (event: PointerEvent) => {
          if (pointerMode === 'claw') {
            finishClawGesture(event.pointerId, true);
            return;
          }
          if (!dragging) return;
          dragging = false;
          pointerMode = null;
          if (canvas.hasPointerCapture(event.pointerId)) {
            canvas.releasePointerCapture(event.pointerId);
          }
          canvas.classList.remove('stage__canvas--dragging');
          if (travelled > CLICK_SLOP_PIXELS) return;
          const activeSnapshot = snapshotRef.current;
          const vehicleId = activeSnapshot
            ? active.pickVehicleAtPixel(event.offsetX, event.offsetY)
            : null;
          if (vehicleId && activeSnapshot) {
            const placement = vehiclePlacements(
              activeSnapshot,
              clockRef.current.elapsedSeconds,
              null,
            ).find((item) => item.vehicleId === vehicleId);
            setSelection(
              placement
                ? describeVehicleSelection(
                    activeSnapshot,
                    vehicleId,
                    placement.nodeId,
                    placement.position,
                  )
                : `Selected ${vehicleId}`,
            );
            return;
          }
          const result = active.selectAtPixel(event.offsetX, event.offsetY);
          setSelection(result ? describeSelection(result) : null);
        };

        const onPointerCancel = (event: PointerEvent) => {
          if (pointerMode === 'claw') {
            finishClawGesture(event.pointerId, false);
            return;
          }
          dragging = false;
          pointerMode = null;
          canvas.classList.remove('stage__canvas--dragging');
        };

        const onKeyDown = (event: KeyboardEvent) => {
          if (event.key === 'Escape' && gestureRef.current) {
            finishClawGesture(gestureRef.current.pointerId, false);
            event.preventDefault();
            return;
          }
          if (event.key === 'ArrowLeft') active.controls.panByPixels(-KEYBOARD_PAN_PIXELS, 0);
          else if (event.key === 'ArrowRight') active.controls.panByPixels(KEYBOARD_PAN_PIXELS, 0);
          else if (event.key === 'ArrowUp') active.controls.panByPixels(0, -KEYBOARD_PAN_PIXELS);
          else if (event.key === 'ArrowDown') active.controls.panByPixels(0, KEYBOARD_PAN_PIXELS);
          else if (event.key === '+' || event.key === '=') active.controls.zoomIn();
          else if (event.key === '-' || event.key === '_') active.controls.zoomOut();
          else if (event.key === '0') active.controls.reset();
          else return;
          event.preventDefault();
          active.render();
        };

        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('pointercancel', onPointerCancel);
        canvas.addEventListener('keydown', onKeyDown);
        cleanups.push(() => {
          canvas.removeEventListener('pointerdown', onPointerDown);
          canvas.removeEventListener('pointermove', onPointerMove);
          canvas.removeEventListener('pointerup', onPointerUp);
          canvas.removeEventListener('pointercancel', onPointerCancel);
          canvas.removeEventListener('keydown', onKeyDown);
        });
      } catch {
        if (!cancelled) setStatus('failed');
      }
    })();

    return () => {
      cancelled = true;
      observer?.disconnect();
      for (const cleanup of cleanups) cleanup();
      shellRef.current = null;
      gestureRef.current = null;
      shell?.dispose();
    };
  }, [bundle]);

  // Routes and vehicles always come from the published snapshot, never from a local
  // reconstruction of it. A new revision drops any gesture in flight.
  useEffect(() => {
    const active = shellRef.current;
    if (!active || status !== 'ready' || !snapshot) return;
    gestureRef.current = null;
    active.syncScenario({
      routes: routeSurfaces(snapshot),
      vehicles: vehiclePlacements(snapshot, clockRef.current.elapsedSeconds, null),
    });
    active.render();
  }, [snapshot, status]);

  // The animation loop runs only while the simulation is running, and it advances the
  // clock in bounded ticks with the same rule the backend publishes.
  useEffect(() => {
    if (status !== 'ready' || !snapshot?.simulation.running) return;
    let frame = 0;
    let last = performance.now();
    const step = (timestamp: number) => {
      const active = shellRef.current;
      const current = snapshotRef.current;
      if (!active || !current) return;
      const deltaSeconds = Math.max(0, (timestamp - last) / 1000);
      last = timestamp;
      const previous = clockRef.current;
      const next = advanceSimulationClock(
        previous,
        boundedTickDelta(deltaSeconds, current.simulation.speedMultiplier),
      );
      clockRef.current = next;
      if (next.tick !== previous.tick) setClock(next);
      active.updateVehiclePlacements(
        applyGestureToPlacements(
          vehiclePlacements(current, next.elapsedSeconds, null),
          gestureRef.current,
        ),
      );
      active.render();
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [status, snapshot?.simulation.running, snapshot?.simulation.speedMultiplier]);

  const degraded = status === 'unavailable' || status === 'failed';
  const notes: string[] = [];
  if (status === 'waiting') notes.push('Waiting for the fixture assets.');
  if (status === 'unavailable') {
    notes.push('The preview is unavailable because this browser did not provide a WebGL context.');
  }
  if (status === 'failed') notes.push('The city preview could not be started on this device.');
  if (status === 'ready' && summary) notes.push(summary);
  if (status === 'ready' && snapshot && snapshot.vehicles.length > 0) {
    notes.push(
      `Claw: right-click a robot, drag it onto a road node and release · ` +
        `${clock.running ? 'simulation running' : 'simulation stopped'} at x${clock.speedMultiplier}`,
    );
  }
  if (status === 'ready' && gestureNote) notes.push(gestureNote);
  if (status === 'ready' && selection) notes.push(selection);

  return (
    <section className="panel" aria-labelledby="stage-heading">
      <h2 id="stage-heading">City view</h2>
      <div className={degraded ? 'stage stage--degraded' : 'stage'}>
        <canvas
          ref={canvasRef}
          className="stage__canvas"
          role="img"
          tabIndex={0}
          aria-label="Isometric view of the local robot city, its road graph, the depot and the fleet"
        />
        {notes.length > 0 ? (
          <div className="stage__overlay">
            {notes.map((note) => (
              <p className="stage__note" key={note}>
                {note}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
