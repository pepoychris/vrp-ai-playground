import { useEffect, useRef, useState } from 'react';

import type { AnimationState } from '../scene/animation-states';
import type { SceneAssetBundle } from '../scene/load-assets';
import type { SceneShell } from '../scene/scene-shell';

export interface SceneStageProps {
  bundle: SceneAssetBundle | null;
  animationState?: AnimationState;
}

type StageStatus = 'waiting' | 'running' | 'reduced' | 'unavailable' | 'failed';

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function SceneStage({ bundle, animationState = 'idle' }: SceneStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<StageStatus>('waiting');

  useEffect(() => {
    if (!bundle) {
      setStatus('waiting');
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let frame = 0;
    let shell: SceneShell | null = null;
    let previousTime = 0;
    let observer: ResizeObserver | null = null;

    void (async () => {
      try {
        const { createSceneShell } = await import('../scene/scene-shell');
        if (cancelled) return;
        shell = createSceneShell({
          canvas,
          width: canvas.clientWidth || 640,
          height: canvas.clientHeight || 360,
        });
        shell.buildStage(bundle);
        if (shell.rendererError) {
          shell.render();
          setStatus('unavailable');
          return;
        }
        shell.playState(animationState);

        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(() => {
            shell?.resize(canvas.clientWidth || 640, canvas.clientHeight || 360);
          });
          observer.observe(canvas);
        }

        if (prefersReducedMotion()) {
          shell.tick(0);
          shell.render();
          setStatus('reduced');
          return;
        }

        const advance = (time: number) => {
          if (cancelled || !shell) return;
          const delta = previousTime === 0 ? 0 : Math.min((time - previousTime) / 1000, 0.1);
          previousTime = time;
          shell.tick(delta);
          shell.render();
          frame = requestAnimationFrame(advance);
        };
        setStatus('running');
        frame = requestAnimationFrame(advance);
      } catch {
        if (!cancelled) setStatus('failed');
      }
    })();

    return () => {
      cancelled = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      observer?.disconnect();
      shell?.dispose();
    };
  }, [bundle, animationState]);

  const degraded = status === 'unavailable' || status === 'failed';

  return (
    <section className="panel" aria-labelledby="stage-heading">
      <h2 id="stage-heading">Scene preview</h2>
      <div className={degraded ? 'stage stage--degraded' : 'stage'}>
        <canvas
          ref={canvasRef}
          className="stage__canvas"
          role="img"
          aria-label="Static preview of the local fixture assets"
        />
        {status === 'waiting' ? <p className="stage__note">Waiting for the fixture assets.</p> : null}
        {status === 'unavailable' ? (
          <p className="stage__note">
            The preview is unavailable because this browser did not provide a WebGL context.
          </p>
        ) : null}
        {status === 'failed' ? (
          <p className="stage__note">The preview could not be started on this device.</p>
        ) : null}
        {status === 'reduced' ? (
          <p className="stage__note">Animation is paused because the system requests reduced motion.</p>
        ) : null}
      </div>
    </section>
  );
}
