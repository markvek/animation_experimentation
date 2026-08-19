import type { Sketch } from './sketch';

/**
 * Wires a Sketch into the browser: runs the requestAnimationFrame loop
 * with delta time, watches the container for size changes, and returns
 * a stop function that tears everything down.
 */
export function runSketch(sketch: Sketch, container: HTMLElement): () => void {
  sketch.init(container);
  sketch.resize(container.clientWidth, container.clientHeight);

  const observer = new ResizeObserver(() => {
    sketch.resize(container.clientWidth, container.clientHeight);
  });
  observer.observe(container);

  let last = performance.now();
  let elapsed = 0;
  let frame = 0;

  const loop = (now: number) => {
    // Clamp dt so a backgrounded tab doesn't produce a huge jump on return.
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    elapsed += dt;
    sketch.update(dt, elapsed);
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    sketch.dispose();
  };
}
