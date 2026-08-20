import * as THREE from 'three';
import type { Sketch } from '../../core/sketch';
import { runSketch } from '../../core/runner';
import {
  createThreeContext,
  resizeThreeContext,
  disposeThreeContext,
  type ThreeContext,
} from '../../core/three-helpers';

const PORTRAIT_URL = new URL('../../img/portrait.png', import.meta.url).href;

/** World-space height of the photo; width follows the image aspect. */
const PHOTO_HEIGHT = 0.75;

/** Underdamped spring toward the nearest rest orientation. */
const SPRING_K = 22;
const SPRING_C = 3;
/** The spring fades out between these speeds (rad/s) so it never fights a real spin. */
const SPRING_FADE_LO = 2.5;
const SPRING_FADE_HI = 5;
/** Always-on friction (s⁻¹) so a spin coasts down before the spring takes over. */
const FRICTION = 0.6;

/** Angular impulse from a gentle tap, rad/s. */
const PUSH = 2.4;
/** Flick: pointer px/s → rad/s. */
const FLICK_GAIN_Y = 0.012;
const FLICK_GAIN_X = 0.01;
/** Hard ceiling on spin speed, rad/s. */
const MAX_SPIN = 25;
/** Direct rotation per pointer px while grabbed. */
const DRAG_ROT_Y = 0.01;
const DRAG_ROT_X = 0.008;
/** A release counts as a tap under this movement and duration. */
const TAP_MAX_PX = 6;
const TAP_MAX_MS = 250;

const TWO_PI = Math.PI * 2;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}

/** Redraws the image through a grayscale filter so the texture is black & white. */
function toGrayscaleTexture(image: HTMLImageElement): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.filter = 'grayscale(1)';
  ctx.drawImage(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Shown until src/img/portrait.png exists. */
function placeholderTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 800;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createLinearGradient(0, 0, 0, 800);
  gradient.addColorStop(0, '#3a3f4a');
  gradient.addColorStop(1, '#20242c');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 800, 800);
  ctx.fillStyle = '#9aa3b2';
  ctx.font = '32px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Save the portrait to', 400, 380);
  ctx.fillText('src/img/portrait.png', 400, 430);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

interface PointerSample {
  x: number;
  y: number;
  t: number;
}

/**
 * A black & white photo floating in space, with momentum:
 * — tap it gently to knock it off balance (it wobbles and rebalances);
 * — drag to grab it (it follows your pointer) and flick to send it into
 *   a genuine spin that coasts down on friction, then swings home;
 * — flick again mid-spin to stack momentum and spin it faster;
 * — tap mid-spin to grip it, bleeding off most of the speed — a tap
 *   near the rim grips harder than one dead center, and the tap point
 *   adds its own little nudge.
 */
class PhotoTiltSketch implements Sketch {
  private ctx!: ThreeContext;
  private group!: THREE.Group;
  private photo!: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2();
  private grabSphere = new THREE.Sphere(new THREE.Vector3(), PHOTO_HEIGHT);

  // Rotation from rest (unbounded — full spins allowed) and angular velocity.
  private rot = new THREE.Vector3();
  private vel = new THREE.Vector3();
  // Recoil along z when pushed.
  private posZ = 0;
  private posZVel = 0;

  private held = false;
  private grabStart: PointerSample = { x: 0, y: 0, t: 0 };
  private lastPointer = { x: 0, y: 0 };
  private history: PointerSample[] = [];

  private onDown = (event: PointerEvent) => this.beginGrab(event);
  private onMove = (event: PointerEvent) => this.moveGrab(event);
  private onUp = (event: PointerEvent) => this.endGrab(event);

  init(container: HTMLElement): void {
    this.ctx = createThreeContext(container);
    const { scene, camera, renderer } = this.ctx;

    scene.background = new THREE.Color(0xf5f2ec);
    camera.position.set(0, 0, 4.2);
    camera.lookAt(0, 0, 0);

    this.group = new THREE.Group();
    scene.add(this.group);

    this.buildPrint(placeholderTexture(), 1);
    void loadImage(PORTRAIT_URL)
      .then((image) => {
        this.buildPrint(toGrayscaleTexture(image), image.naturalWidth / image.naturalHeight);
      })
      .catch(() => {
        /* keep the placeholder */
      });

    renderer.domElement.addEventListener('pointerdown', this.onDown);
    renderer.domElement.addEventListener('pointermove', this.onMove);
    renderer.domElement.addEventListener('pointerup', this.onUp);
    renderer.domElement.addEventListener('pointercancel', this.onUp);
  }

  /** (Re)creates the print meshes for a texture with the given aspect ratio. */
  private buildPrint(texture: THREE.Texture, aspect: number): void {
    this.group.children.slice().forEach((child) => {
      this.group.remove(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (Array.isArray(child.material) ? child.material : [child.material]).forEach((m) =>
          m.dispose(),
        );
      }
    });

    const width = PHOTO_HEIGHT * aspect;
    this.grabSphere.radius = Math.hypot(width, PHOTO_HEIGHT) / 2;

    // DoubleSide shows the mirrored photo on the back face.
    this.photo = new THREE.Mesh(
      new THREE.PlaneGeometry(width, PHOTO_HEIGHT),
      new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }),
    );
    this.group.add(this.photo);
  }

  private castPointer(event: PointerEvent): void {
    const rect = this.ctx.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.ctx.camera);
  }

  /** Sphere test so the photo stays grabbable edge-on or mid-spin. */
  private hitPhoto(event: PointerEvent): boolean {
    this.castPointer(event);
    this.grabSphere.center.set(0, 0, this.posZ);
    return this.raycaster.ray.intersectsSphere(this.grabSphere);
  }

  /**
   * Pointer offset from the photo's projected center, in units of the
   * photo's apparent half-height (clamped to [-1, 1], +y = above center).
   * Orientation-independent, unlike a raycast uv.
   */
  private screenOffset(event: PointerEvent): { x: number; y: number } {
    const rect = this.ctx.renderer.domElement.getBoundingClientRect();
    const camera = this.ctx.camera;
    const center = new THREE.Vector3(0, 0, this.posZ).project(camera);
    const cx = rect.left + ((center.x + 1) / 2) * rect.width;
    const cy = rect.top + ((1 - center.y) / 2) * rect.height;
    const distance = camera.position.z - this.posZ;
    const halfPx =
      ((PHOTO_HEIGHT / 2 / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance)) *
        rect.height) /
      2;
    return {
      x: THREE.MathUtils.clamp((event.clientX - cx) / halfPx, -1, 1),
      y: THREE.MathUtils.clamp(-(event.clientY - cy) / halfPx, -1, 1),
    };
  }

  private beginGrab(event: PointerEvent): void {
    if (!this.hitPhoto(event)) return;
    this.held = true;
    try {
      this.ctx.renderer.domElement.setPointerCapture(event.pointerId);
    } catch {
      /* pointer may already be gone; grab still works without capture */
    }
    const now = performance.now();
    this.grabStart = { x: event.clientX, y: event.clientY, t: now };
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.history = [{ ...this.grabStart }];
    this.ctx.renderer.domElement.style.cursor = 'grabbing';
  }

  private moveGrab(event: PointerEvent): void {
    if (!this.held) {
      this.ctx.renderer.domElement.style.cursor = this.hitPhoto(event) ? 'pointer' : 'default';
      return;
    }
    // Grabbed: the photo follows the pointer directly.
    this.rot.y += (event.clientX - this.lastPointer.x) * DRAG_ROT_Y;
    this.rot.x += (event.clientY - this.lastPointer.y) * DRAG_ROT_X;
    this.lastPointer = { x: event.clientX, y: event.clientY };

    const now = performance.now();
    this.history.push({ x: event.clientX, y: event.clientY, t: now });
    while (this.history.length > 2 && this.history[0].t < now - 120) this.history.shift();
  }

  private endGrab(event: PointerEvent): void {
    if (!this.held) return;
    this.held = false;
    this.ctx.renderer.domElement.style.cursor = this.hitPhoto(event) ? 'pointer' : 'default';

    const now = performance.now();
    const moved = Math.hypot(event.clientX - this.grabStart.x, event.clientY - this.grabStart.y);
    if (moved < TAP_MAX_PX && now - this.grabStart.t < TAP_MAX_MS) {
      if (this.vel.length() < 1) this.poke(event);
      else this.brake(event);
      return;
    }
    this.flick(event, now);
  }

  /** Gentle tap on a calm photo: torque around the center, away from the viewer. */
  private poke(event: PointerEvent): void {
    this.castPointer(event);
    const hit = this.raycaster.intersectObject(this.photo)[0];
    const off = hit?.uv
      ? { x: hit.uv.x * 2 - 1, y: hit.uv.y * 2 - 1 }
      : this.screenOffset(event);

    // Pushing the top edge tips the top away (-x rotation); pushing the
    // right edge swings the right side away (+y rotation).
    this.vel.x -= off.y * PUSH;
    this.vel.y += off.x * PUSH;
    // Knocked off-kilter: a little roll, biased by where it was hit.
    this.vel.z += off.x * PUSH * 0.35 + (Math.random() - 0.5) * 0.4;
    this.posZVel -= 1.2;

    // A dead-center poke still destabilizes: guarantee a minimum kick.
    if (this.vel.length() < 0.8) {
      const angle = Math.random() * Math.PI * 2;
      this.vel.x += Math.cos(angle) * 0.8;
      this.vel.y += Math.sin(angle) * 0.8;
      this.vel.z += (Math.random() - 0.5) * 0.5;
    }
  }

  /** Tap on a moving photo: grip it, bleeding off speed, nudged by where the tap landed. */
  private brake(event: PointerEvent): void {
    const off = this.screenOffset(event);
    // A finger near the rim grips the spin harder than one dead center.
    const keep = 0.45 - 0.25 * Math.min(Math.hypot(off.x, off.y), 1);
    this.vel.multiplyScalar(keep);
    // The stopping finger also nudges it a little, poke-style, from the tap point.
    this.vel.x -= off.y * PUSH * 0.25;
    this.vel.y += off.x * PUSH * 0.25;
    this.posZVel -= 0.6;
  }

  /** Drag release: pointer velocity becomes angular momentum, stacking onto any spin. */
  private flick(event: PointerEvent, now: number): void {
    this.history.push({ x: event.clientX, y: event.clientY, t: now });
    const cutoff = now - 100;
    const recent = this.history.filter((sample) => sample.t >= cutoff);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dtMs = last.t - first.t;
    if (dtMs < 16) return;

    const vx = ((last.x - first.x) / dtMs) * 1000;
    const vy = ((last.y - first.y) / dtMs) * 1000;
    this.vel.y += vx * FLICK_GAIN_Y;
    this.vel.x += vy * FLICK_GAIN_X;
    // A hard flick knocks it slightly off-axis too.
    this.vel.z += (Math.random() - 0.5) * 0.06 * Math.hypot(vx * FLICK_GAIN_Y, vy * FLICK_GAIN_X);
    this.posZVel -= 0.8;

    if (this.vel.length() > MAX_SPIN) this.vel.setLength(MAX_SPIN);
  }

  update(dt: number, elapsed: number): void {
    if (!this.held) {
      // The spring pulls toward the nearest whole-turn orientation, fading
      // out at spin speeds so friction alone rules a fast spin.
      const springScale = 1 - THREE.MathUtils.smoothstep(this.vel.length(), SPRING_FADE_LO, SPRING_FADE_HI);
      (['x', 'y', 'z'] as const).forEach((axis) => {
        const rest = Math.round(this.rot[axis] / TWO_PI) * TWO_PI;
        const spring = (-SPRING_K * (this.rot[axis] - rest) - SPRING_C * this.vel[axis]) * springScale;
        this.vel[axis] += (spring - FRICTION * this.vel[axis]) * dt;
        this.rot[axis] += this.vel[axis] * dt;
      });
    }
    this.posZVel += (-30 * this.posZ - 6 * this.posZVel) * dt;
    this.posZ += this.posZVel * dt;

    // A barely-there idle sway so the print feels like it is hanging, not frozen.
    this.group.rotation.set(
      this.rot.x + Math.sin(elapsed * 0.6) * 0.008,
      this.rot.y + Math.sin(elapsed * 0.45 + 1.7) * 0.012,
      this.rot.z,
    );
    this.group.position.z = this.posZ;

    this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);
  }

  resize(width: number, height: number): void {
    resizeThreeContext(this.ctx, width, height);
  }

  dispose(): void {
    const canvas = this.ctx.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onDown);
    canvas.removeEventListener('pointermove', this.onMove);
    canvas.removeEventListener('pointerup', this.onUp);
    canvas.removeEventListener('pointercancel', this.onUp);
    this.ctx.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => m.dispose());
      }
    });
    disposeThreeContext(this.ctx);
  }
}

runSketch(new PhotoTiltSketch(), document.getElementById('sketch')!);
