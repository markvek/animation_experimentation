import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Sketch } from '../../core/sketch';
import { runSketch } from '../../core/runner';
import {
  createThreeContext,
  resizeThreeContext,
  disposeThreeContext,
  type ThreeContext,
} from '../../core/three-helpers';

/**
 * First 3D sketch: a torus knot orbited by satellite cubes, with
 * drag-to-rotate camera controls. Proves the Three.js pipeline.
 */
class OrbitSketch implements Sketch {
  private ctx!: ThreeContext;
  private controls!: OrbitControls;
  private knot!: THREE.Mesh;
  private satellites: THREE.Mesh[] = [];

  init(container: HTMLElement): void {
    this.ctx = createThreeContext(container);
    const { scene, camera, renderer } = this.ctx;

    scene.background = new THREE.Color(0x0b0d12);
    scene.fog = new THREE.Fog(0x0b0d12, 8, 20);

    this.controls = new OrbitControls(camera, renderer.domElement);
    this.controls.enableDamping = true;

    const knotGeometry = new THREE.TorusKnotGeometry(1, 0.3, 200, 32);
    const knotMaterial = new THREE.MeshStandardMaterial({
      color: 0x6ea8fe,
      metalness: 0.4,
      roughness: 0.25,
    });
    this.knot = new THREE.Mesh(knotGeometry, knotMaterial);
    scene.add(this.knot);

    const satGeometry = new THREE.BoxGeometry(0.25, 0.25, 0.25);
    for (let i = 0; i < 8; i++) {
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(i / 8, 0.7, 0.6),
        metalness: 0.2,
        roughness: 0.4,
      });
      const satellite = new THREE.Mesh(satGeometry, material);
      this.satellites.push(satellite);
      scene.add(satellite);
    }

    scene.add(new THREE.AmbientLight(0xffffff, 0.3));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2);
    keyLight.position.set(4, 6, 4);
    scene.add(keyLight);
    const rimLight = new THREE.PointLight(0xff7eb6, 8, 20);
    rimLight.position.set(-4, -2, -3);
    scene.add(rimLight);
  }

  update(_dt: number, elapsed: number): void {
    this.knot.rotation.x = elapsed * 0.3;
    this.knot.rotation.y = elapsed * 0.45;

    this.satellites.forEach((satellite, i) => {
      const angle = elapsed * 0.6 + (i / this.satellites.length) * Math.PI * 2;
      const radius = 3 + Math.sin(elapsed * 0.8 + i) * 0.4;
      satellite.position.set(
        Math.cos(angle) * radius,
        Math.sin(elapsed + i) * 1.2,
        Math.sin(angle) * radius,
      );
      satellite.rotation.x = elapsed * (1 + i * 0.1);
      satellite.rotation.y = elapsed * (0.5 + i * 0.1);
    });

    this.controls.update();
    this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);
  }

  resize(width: number, height: number): void {
    resizeThreeContext(this.ctx, width, height);
  }

  dispose(): void {
    this.controls.dispose();
    this.ctx.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => m.dispose());
      }
    });
    disposeThreeContext(this.ctx);
  }
}

runSketch(new OrbitSketch(), document.getElementById('sketch')!);
