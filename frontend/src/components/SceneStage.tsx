import { useEffect, useRef, useState } from 'react';

import type { CitySelection, CityShell } from '../city/city-shell';
import type { SceneAssetBundle } from '../scene/load-assets';

export interface SceneStageProps {
  bundle: SceneAssetBundle | null;
}

type StageStatus = 'waiting' | 'ready' | 'unavailable' | 'failed';

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

export function SceneStage({ bundle }: SceneStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<StageStatus>('waiting');
  const [summary, setSummary] = useState<string | null>(null);
  const [selection, setSelection] = useState<string | null>(null);

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
        const report = created.buildCity(bundle);
        const active = created;
        const render = () => active.render();
        render();
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
            render();
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
          render();
        };
        canvas.addEventListener('wheel', onWheel, { passive: false });
        cleanups.push(() => canvas.removeEventListener('wheel', onWheel));

        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        let travelled = 0;
        const onPointerDown = (event: PointerEvent) => {
          dragging = true;
          lastX = event.offsetX;
          lastY = event.offsetY;
          travelled = 0;
          canvas.setPointerCapture(event.pointerId);
          canvas.classList.add('stage__canvas--dragging');
        };
        const onPointerMove = (event: PointerEvent) => {
          if (!dragging) return;
          const deltaX = event.offsetX - lastX;
          const deltaY = event.offsetY - lastY;
          lastX = event.offsetX;
          lastY = event.offsetY;
          travelled += Math.abs(deltaX) + Math.abs(deltaY);
          active.controls.panByPixels(deltaX, deltaY);
          render();
        };
        const onPointerUp = (event: PointerEvent) => {
          if (!dragging) return;
          dragging = false;
          if (canvas.hasPointerCapture(event.pointerId)) {
            canvas.releasePointerCapture(event.pointerId);
          }
          canvas.classList.remove('stage__canvas--dragging');
          if (travelled > CLICK_SLOP_PIXELS) return;
          const result = active.selectAtPixel(event.offsetX, event.offsetY);
          setSelection(result ? describeSelection(result) : null);
        };
        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerup', onPointerUp);
        cleanups.push(() => {
          canvas.removeEventListener('pointerdown', onPointerDown);
          canvas.removeEventListener('pointermove', onPointerMove);
          canvas.removeEventListener('pointerup', onPointerUp);
        });

        const onKeyDown = (event: KeyboardEvent) => {
          if (event.key === 'ArrowLeft') active.controls.panByPixels(-KEYBOARD_PAN_PIXELS, 0);
          else if (event.key === 'ArrowRight') active.controls.panByPixels(KEYBOARD_PAN_PIXELS, 0);
          else if (event.key === 'ArrowUp') active.controls.panByPixels(0, -KEYBOARD_PAN_PIXELS);
          else if (event.key === 'ArrowDown') active.controls.panByPixels(0, KEYBOARD_PAN_PIXELS);
          else if (event.key === '+' || event.key === '=') active.controls.zoomIn();
          else if (event.key === '-' || event.key === '_') active.controls.zoomOut();
          else if (event.key === '0') active.controls.reset();
          else return;
          event.preventDefault();
          render();
        };
        canvas.addEventListener('keydown', onKeyDown);
        cleanups.push(() => canvas.removeEventListener('keydown', onKeyDown));
      } catch {
        if (!cancelled) setStatus('failed');
      }
    })();

    return () => {
      cancelled = true;
      observer?.disconnect();
      for (const cleanup of cleanups) cleanup();
      shell?.dispose();
    };
  }, [bundle]);

  const degraded = status === 'unavailable' || status === 'failed';
  const notes: string[] = [];
  if (status === 'waiting') notes.push('Waiting for the fixture assets.');
  if (status === 'unavailable') {
    notes.push('The preview is unavailable because this browser did not provide a WebGL context.');
  }
  if (status === 'failed') notes.push('The city preview could not be started on this device.');
  if (status === 'ready' && summary) notes.push(summary);
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
          aria-label="Isometric view of the local robot city, its road graph and the depot"
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
