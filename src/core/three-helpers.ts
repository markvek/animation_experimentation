import * as THREE from 'three';

/** Shared boilerplate for 3D sketches: renderer + scene + perspective camera. */
export interface ThreeContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

export function createThreeContext(container: HTMLElement): ThreeContext {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    60,
    container.clientWidth / Math.max(container.clientHeight, 1),
    0.1,
    100,
  );
  camera.position.set(0, 2, 6);

  return { renderer, scene, camera };
}

export function resizeThreeContext(ctx: ThreeContext, width: number, height: number): void {
  ctx.camera.aspect = width / Math.max(height, 1);
  ctx.camera.updateProjectionMatrix();
  ctx.renderer.setSize(width, height);
}

export function disposeThreeContext(ctx: ThreeContext): void {
  ctx.renderer.dispose();
  ctx.renderer.domElement.remove();
}
