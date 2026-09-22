import { useCallback, useEffect, useRef, useState } from 'react';

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
  type GesturePlacement,
} from '../city/vehicle-gesture';
import type { SceneAssetBundle } from '../scene/load-assets';
import {
  describeRendererDetail,
  describeRendererStats,
  readRendererStats,
} from '../scene/renderer-stats';
import {
  barrierById,
  type ScenarioSnapshot,
  type SimulationState,
} from '../scenario/scenario';
import {
  affectedVehicleIds,
  barrierPlacements,
  describeBarrierPlacement,
  describeBarrierPreview,
  resolveBarrierPreview,
  type BarrierPreview,
} from '../scenario/barriers';
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
  /** True while the barrier tool is armed: a left drag closes the nearest road edge. */
  barrierToolArmed: boolean;
  selectedBarrierId: string | null;
  /** Called once, on release, with the world point that should receive a barrier. */
  onPlaceBarrier: (position: CityPoint) => void;
  onRemoveBarrier: (barrierId: string) => void;
  onSelectBarrier: (barrierId: string | null) => void;
}

type StageStatus = 'waiting' | 'ready' | 'unavailable' | 'failed';
type PointerMode = 'pan' | 'claw' | 'barrier';

const KEYBOARD_PAN_PIXELS = 28;
const CLICK_SLOP_PIXELS = 3;
const DEFAULT_STAGE_WIDTH = 720;
const DEFAULT_STAGE_HEIGHT = 420;
/** The frame-rate reading is averaged over this window, and only while animating. */
const RENDER_STATS_WINDOW_MS = 500;

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

function describeBarrierSelection(
  snapshot: ScenarioSnapshot,
  barrierId: string,
): string {
  const barrier = barrierById(snapshot, barrierId);
  return barrier
    ? `Selected closure ${barrierId} · edge ${barrier.blockedEdgeId}`
    : `Selected closure ${barrierId}`;
}

/**
 * Mark the vehicles a road closure affects, so the scene can highlight them.
 *
 * The placement type is forwarded instead of widened: the gesture overlay below requires
 * a `lifted` flag, and a widened `VehiclePlacement` would erase that guarantee.
 */
function withClosureHighlight<T extends GesturePlacement>(
  snapshot: ScenarioSnapshot,
  placements: readonly T[],
): (T & { highlighted: boolean })[] {
  const affected = affectedVehicleIds(snapshot);
  return placements.map((placement) =>
    Object.assign({}, placement, { highlighted: affected.has(placement.vehicleId) }),
  );
}

export function SceneStage({
  bundle,
  snapshot,
  onRelocateVehicle,
  barrierToolArmed,
  selectedBarrierId,
  onPlaceBarrier,
  onRemoveBarrier,
  onSelectBarrier,
}: SceneStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shellRef = useRef<CityShell | null>(null);
  const snapshotRef = useRef<ScenarioSnapshot | null>(snapshot);
  const relocateRef = useRef(onRelocateVehicle);
  const placeBarrierRef = useRef(onPlaceBarrier);
  const removeBarrierRef = useRef(onRemoveBarrier);
  const selectBarrierRef = useRef(onSelectBarrier);
  const barrierToolRef = useRef(barrierToolArmed);
  const selectedBarrierRef = useRef(selectedBarrierId);
  const gestureRef = useRef<ClawGesture | null>(null);
  const barrierGestureRef = useRef<{
    pointerId: number;
    pointer: CityPoint;
    preview: BarrierPreview;
  } | null>(null);
  /**
   * Cancels a barrier drag from outside the scene effect: disarming the tool, or an
   * unmount, has to drop the capture and give the camera back.
   */
  const cancelBarrierGestureRef = useRef<(() => void) | null>(null);
  const clockRef = useRef<SimulationState>(simulationState({ running: false }));
  const [status, setStatus] = useState<StageStatus>('waiting');
  const [summary, setSummary] = useState<string | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [gestureNote, setGestureNote] = useState<string | null>(null);
  const [clock, setClock] = useState<SimulationState>(simulationState({ running: false }));
  const [renderStats, setRenderStats] = useState<string | null>(null);
  const [renderStatsDetail, setRenderStatsDetail] = useState<string | null>(null);
  const [rendererError, setRendererError] = useState<string | null>(null);

  /**
   * Publish the last frame's telemetry.
   *
   * `renderer.info` is only valid until the next frame, so this is called right after a
   * `render()` or from the animation loop's measuring window. A renderer that exposes no
   * `info` — no WebGL context, or a test double — publishes nothing instead of zeros.
   */
  const publishRendererStats = useCallback((fps: number | null) => {
    const stats = readRendererStats(shellRef.current?.renderer ?? null);
    setRenderStats(describeRendererStats(stats, fps));
    setRenderStatsDetail(describeRendererDetail(stats, fps));
  }, []);

  useEffect(() => {
    relocateRef.current = onRelocateVehicle;
  }, [onRelocateVehicle]);

  useEffect(() => {
    placeBarrierRef.current = onPlaceBarrier;
    removeBarrierRef.current = onRemoveBarrier;
    selectBarrierRef.current = onSelectBarrier;
  }, [onPlaceBarrier, onRemoveBarrier, onSelectBarrier]);

  useEffect(() => {
    barrierToolRef.current = barrierToolArmed;
    if (!barrierToolArmed) {
      // Disarming the tool never leaves a preview floating over the city, and it never
      // leaves a drag holding the pointer capture.
      cancelBarrierGestureRef.current?.();
    }
  }, [barrierToolArmed]);

  useEffect(() => {
    selectedBarrierRef.current = selectedBarrierId;
  }, [selectedBarrierId]);

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
        applyGestureToPlacements(
          withClosureHighlight(active, placements),
          gestureRef.current,
        ),
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
          // No WebGL context: the stage explains what happened instead of showing an
          // empty canvas, and every scenario control keeps working.
          setRendererError(active.rendererError);
          setStatus('unavailable');
          return;
        }
        setRendererError(null);
        setStatus('ready');
        publishRendererStats(null);

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

        const releasePointer = (pointerId: number | null) => {
          if (pointerId !== null && canvas.hasPointerCapture(pointerId)) {
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

        /**
         * Finish a barrier drag. This is the single exit for every ending: release,
         * cancel, Escape and disarming the tool all come through here, so the pointer
         * capture and the camera can never be left in a grabbed state.
         *
         * A cancelled drag commits nothing and never falls through to selection: the
         * caller stops as soon as this returns.
         */
        const endBarrierGesture = (pointerId: number | null, commit: boolean) => {
          const gesture = barrierGestureRef.current;
          pointerMode = null;
          barrierGestureRef.current = null;
          releasePointer(pointerId);
          active.setBarrierPreview(null);
          if (!gesture) {
            active.render();
            return false;
          }
          if (!commit) {
            // Cancelling is silent: the road is untouched and no command is sent.
            setGestureNote(null);
            active.render();
            return true;
          }
          setGestureNote(
            describeBarrierPlacement(gesture.preview.accepted, gesture.preview.edgeId, null),
          );
          if (gesture.preview.accepted) {
            // The server snaps again from the raw world point and answers with the
            // authoritative barrier id, edge id and before/after comparison.
            placeBarrierRef.current(gesture.preview.pointer);
          }
          active.render();
          return true;
        };
        // Outside the scene effect the only thing a disarm or an unmount needs is the
        // cancel path, so it is published through a ref.
        cancelBarrierGestureRef.current = () =>
          void endBarrierGesture(barrierGestureRef.current?.pointerId ?? null, false);

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
          if (barrierToolRef.current) {
            // The barrier tool borrows the left button: the drag closes one road edge
            // instead of panning, and the camera steps aside for the duration.
            if (!activeSnapshot) return;
            if (barrierGestureRef.current) return;
            const pointer = active.groundPointAtPixel(event.offsetX, event.offsetY);
            if (!pointer) return;
            event.preventDefault();
            const preview = resolveBarrierPreview(
              active.network,
              pointer,
              activeSnapshot.blockedEdgeIds,
            );
            barrierGestureRef.current = { pointerId: event.pointerId, pointer, preview };
            pointerMode = 'barrier';
            travelled = 0;
            canvas.setPointerCapture(event.pointerId);
            canvas.classList.add('stage__canvas--grabbing');
            active.setCameraEnabled(false);
            active.setBarrierPreview(preview);
            setGestureNote(describeBarrierPreview(preview));
            active.render();
            return;
          }
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
          if (pointerMode === 'barrier') {
            // A pointer move only re-resolves the nearest road edge: no command, no plan.
            const gesture = barrierGestureRef.current;
            const activeSnapshot = snapshotRef.current;
            if (!gesture || !activeSnapshot) return;
            const pointer = active.groundPointAtPixel(event.offsetX, event.offsetY);
            if (!pointer) return;
            const preview = resolveBarrierPreview(
              active.network,
              pointer,
              activeSnapshot.blockedEdgeIds,
            );
            barrierGestureRef.current = { pointerId: gesture.pointerId, pointer, preview };
            active.setBarrierPreview(preview);
            setGestureNote(describeBarrierPreview(preview));
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
          if (pointerMode === 'barrier') {
            endBarrierGesture(event.pointerId, true);
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
          const barrierId = activeSnapshot
            ? active.pickBarrierAtPixel(event.offsetX, event.offsetY)
            : null;
          if (barrierId && activeSnapshot) {
            selectBarrierRef.current(barrierId);
            setSelection(describeBarrierSelection(activeSnapshot, barrierId));
            return;
          }
          const vehicleId = activeSnapshot
            ? active.pickVehicleAtPixel(event.offsetX, event.offsetY)
            : null;
          if (vehicleId && activeSnapshot) {
            selectBarrierRef.current(null);
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
          selectBarrierRef.current(null);
          const result = active.selectAtPixel(event.offsetX, event.offsetY);
          setSelection(result ? describeSelection(result) : null);
        };

        const onPointerCancel = (event: PointerEvent) => {
          if (pointerMode === 'claw') {
            finishClawGesture(event.pointerId, false);
            return;
          }
          if (pointerMode === 'barrier') {
            // A cancelled drag is a cancelled drag: it never counts as a click, so it
            // cannot select a barrier or a vehicle by accident.
            endBarrierGesture(event.pointerId, false);
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
          if (event.key === 'Escape' && barrierGestureRef.current) {
            // Cancelling a drag in flight must restore the camera and drop the capture,
            // exactly like the pointercancel path, so the canvas never stays grabbed.
            endBarrierGesture(barrierGestureRef.current.pointerId, false);
            event.preventDefault();
            return;
          }
          if (
            (event.key === 'Delete' || event.key === 'Backspace') &&
            selectedBarrierRef.current
          ) {
            removeBarrierRef.current(selectedBarrierRef.current);
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
      // Unmounting mid-drag gives the camera back and leaves no preview behind; the
      // cancel path is not reused here because it would set state on a dead component.
      cancelBarrierGestureRef.current = null;
      barrierGestureRef.current = null;
      shell?.setBarrierPreview(null);
      shell?.setCameraEnabled(true);
      shellRef.current = null;
      gestureRef.current = null;
      shell?.dispose();
    };
  }, [bundle, publishRendererStats]);

  // Routes and vehicles always come from the published snapshot, never from a local
  // reconstruction of it. A new revision drops any gesture in flight.
  useEffect(() => {
    const active = shellRef.current;
    if (!active || status !== 'ready' || !snapshot) return;
    gestureRef.current = null;
    active.syncScenario({
      routes: routeSurfaces(snapshot),
      vehicles: vehiclePlacements(snapshot, clockRef.current.elapsedSeconds, null),
      barriers: barrierPlacements(snapshot, active.network, selectedBarrierRef.current),
    });
    active.render();
    publishRendererStats(null);
  }, [snapshot, status, publishRendererStats]);

  // Barrier selection is a view-only change: it repaints the barrier layer and never
  // recomputes a plan, so it stays out of the snapshot sync above.
  useEffect(() => {
    const active = shellRef.current;
    if (!active || status !== 'ready' || !snapshot) return;
    active.updateBarriers(barrierPlacements(snapshot, active.network, selectedBarrierId));
    active.render();
    publishRendererStats(null);
  }, [snapshot, status, selectedBarrierId, publishRendererStats]);

  // The animation loop runs only while the simulation is running, and it advances the
  // clock in bounded ticks with the same rule the backend publishes.
  useEffect(() => {
    if (status !== 'ready' || !snapshot?.simulation.running) return;
    let frame = 0;
    let last = performance.now();
    let windowStart = last;
    let framesInWindow = 0;
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
      framesInWindow += 1;
      const windowMs = timestamp - windowStart;
      if (windowMs >= RENDER_STATS_WINDOW_MS) {
        // The only frame rate this application can report honestly: frames it actually
        // rendered while the simulation was animating, over a fixed window.
        publishRendererStats((framesInWindow * 1000) / windowMs);
        framesInWindow = 0;
        windowStart = timestamp;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [
    status,
    snapshot?.simulation.running,
    snapshot?.simulation.speedMultiplier,
    publishRendererStats,
  ]);

  // A stopped simulation has no meaningful frame rate, so the reading drops the FPS rather
  // than leaving the last animated value on screen.
  useEffect(() => {
    if (snapshot?.simulation.running) return;
    publishRendererStats(null);
  }, [snapshot?.simulation.running, publishRendererStats]);

  const degraded = status === 'unavailable' || status === 'failed';
  const notes: string[] = [];
  if (status === 'waiting') notes.push('Waiting for the fixture assets.');
  if (status === 'ready' && summary) notes.push(summary);
  if (status === 'ready' && snapshot) {
    notes.push(
      `${clock.running ? 'Simulation running' : 'Simulation stopped'} at x${clock.speedMultiplier}`,
    );
  }
  if (status === 'ready' && gestureNote) notes.push(gestureNote);
  if (status === 'ready' && selection) notes.push(selection);

  return (
    <section className="panel scene-stage" aria-labelledby="stage-heading">
      <div className="scene-stage__head">
        <h2 id="stage-heading">City view</h2>
        {renderStats ? (
          <p
            className="stage__stats"
            data-testid="renderer-stats"
            title={renderStatsDetail ?? undefined}
          >
            {renderStats}
          </p>
        ) : null}
      </div>

      <ul className="stage__tools" aria-label="City controls">
        <li>Left drag pans the city · scroll wheel zooms · arrow keys pan and 0 resets the view.</li>
        <li title="Right-click a robot, drag it onto a road node and release the button.">
          Right drag on a robot drops it with the claw onto the nearest road node.
        </li>
        <li
          title="Arm the closure tool, then drag on the city to drop a barrier. Select a barrier on
            the map or in the closure list and press Delete, or use Reopen road, to remove it."
        >
          Arm the closure tool, then left drag on a road to block it in both directions. Select a
          barrier and press Delete, or use Reopen road, to remove it.
        </li>
      </ul>

      <div className={degraded ? 'stage stage--degraded' : 'stage'}>
        <canvas
          ref={canvasRef}
          className="stage__canvas"
          role="img"
          tabIndex={0}
          title="Left drag pans, the scroll wheel zooms, right drag on a robot uses the claw"
          aria-label="Isometric view of the local robot city, its road graph, the depot and the fleet"
        />
        {degraded ? (
          <div className="stage__fallback" role="status">
            <p className="stage__fallback-title">
              {status === 'unavailable'
                ? 'WebGL is not available in this browser'
                : 'The city preview could not start'}
            </p>
            <p className="stage__fallback-note">
              {status === 'unavailable'
                ? 'Enable hardware acceleration, or open the app in a browser with WebGL2, and reload the page. The colony controls keep working.'
                : 'Reload the page to try again. The scenario itself is kept by the backend.'}
            </p>
            {rendererError ? (
              <p className="stage__fallback-detail">Renderer reported: {rendererError}</p>
            ) : null}
          </div>
        ) : null}
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
