/**
 * Common contract every animation implements, whether it renders
 * with Three.js (WebGL) or the Canvas 2D API. The runner owns the
 * animation loop and lifecycle; sketches only contain animation logic.
 */
export interface Sketch {
  /** Create canvases/scenes and attach them to the container. */
  init(container: HTMLElement): void;

  /** Advance the animation. dt = seconds since last frame, elapsed = seconds since start. */
  update(dt: number, elapsed: number): void;

  /** Container size changed; adjust cameras, canvas dimensions, etc. */
  resize(width: number, height: number): void;

  /** Release GPU resources, remove DOM nodes, unbind listeners. */
  dispose(): void;
}
