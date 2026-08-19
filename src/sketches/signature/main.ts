import * as THREE from 'three';
import type { Sketch } from '../../core/sketch';
import { runSketch } from '../../core/runner';
import {
  createThreeContext,
  resizeThreeContext,
  disposeThreeContext,
  type ThreeContext,
} from '../../core/three-helpers';

// Every stroke layer shares one 828×244 registration canvas (half-scale of
// "Mask group.png", the complete signature). Overlaying all parts at the
// same position recomposes "Mark Veksler". Each part is a hand-made stroke
// piece; in 3D each becomes its own textured plane that tumbles on blast.
const PART_FILES = [
  'M part 1.png',
  'M part 2.png',
  'M part 3.png',
  'M part 4.png',
  'A part 1.png',
  'A part 2.png',
  'A part 3.png',
  'R part 1.png',
  'R part 2.png',
  'R part 3.png',
  'R part 4.png',
  'K part 1.png',
  'K part 2.png',
  'K part 3.png',
  'V Part 1.png',
  'V Part 2.png',
  'E part 1.png',
  'E Part 2.png',
  'E part 3.png',
  'E part 4.png',
  'K2 part 1.png',
  'K2 part 2.png',
  'K2 part 3.png',
  'S part 1.png',
  'S part 2.png',
  'S part 3.png',
  'L part 1 of 1.png',
  'E2 part 1.png',
  'E2 part 2.png',
  'E2 part 3.png',
  'E2 part 4.png',
];

// The complete signature — used to derive any ink the parts don't cover
// (the "r" in "Mark" has no part PNGs of its own).
const FULL_SIGNATURE = 'Mask group.png';

const FRAME_WIDTH = 828;
const FRAME_HEIGHT = 244;

// World size of the signature plane before the fit-to-viewport group scale
const BASE_WIDTH = 8;
const BASE_HEIGHT = BASE_WIDTH * (FRAME_HEIGHT / FRAME_WIDTH);

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Phase = 'idle' | 'launch' | 'orbit' | 'home' | 'drag';

/** One stroke piece: a textured plane with 3D flight state. */
interface Piece {
  mesh: THREE.Mesh;
  home: THREE.Vector3;
  center: THREE.Vector3; // ink center in group-local coords, for blast direction
  offset: THREE.Vector3;
  velocity: THREE.Vector3;
  rotation: THREE.Vector3; // euler angles, sprung back to 0
  spin: THREE.Vector3;
  // Alpha channel of this piece's frame-sized texture (row-major), used to
  // hit-test exactly which stroke's ink is under the cursor.
  alpha: Uint8Array;
  // Flight phase machine: blast kicks to 'launch'; at the apex the piece is
  // inserted into a tilted decaying orbit; when its revolutions are done the
  // damped springs dock it home. A pointer grab kicks it to 'drag' instead,
  // and releasing it hands back off to 'home'.
  phase: Phase;
  launchAge: number; // seconds since the blast
  orbitAngle: number; // |angle| swept so far, for progress against orbitTotal
  orbitTotal: number; // total angle to sweep (revolutions * 2π)
  orbitTheta: number; // current polar angle, integrated each frame
  orbitR0: number; // radius at insertion
  orbitREnd: number; // radius to decay toward before docking
  orbitZ0: number; // out-of-plane offset at insertion, decays to 0
  orbitOmega: number; // cruise angular speed (signed), rad/s
  orbitOmegaCurrent: number; // integrated angular speed, eased toward cruise
  orbitR: number; // integrated radius (spring toward the decaying target)
  orbitRDot: number; // radial rate — seeded with the real radial velocity at insertion
  orbitTilt: THREE.Quaternion; // tilts the orbit plane for a 3D ring
  dragCursor: THREE.Vector3; // last cursor position (group-local), for delta tracking
  dragRippleTimer: number; // seconds since the last wake ripple
}

function loadImage(file: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${file}`));
    img.src = new URL(`../../img/${file}`, import.meta.url).href;
  });
}

/** Draw sources into the registration frame and return the ink bounding box. */
function measureInk(sources: CanvasImageSource[]): Bounds | null {
  const off = document.createElement('canvas');
  off.width = FRAME_WIDTH;
  off.height = FRAME_HEIGHT;
  const octx = off.getContext('2d')!;
  for (const source of sources) {
    octx.drawImage(source, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
  }
  const data = octx.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT).data;
  let minX = FRAME_WIDTH;
  let minY = FRAME_HEIGHT;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < FRAME_HEIGHT; y++) {
    for (let x = 0; x < FRAME_WIDTH; x++) {
      if (data[(y * FRAME_WIDTH + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX <= minX) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Ink in the full signature that no part PNG covers (e.g. the "r" in
 * "Mark"): render the signature into the frame, knock out its white
 * background, then erase everything the parts already draw — with generous
 * dilation and an alpha threshold so no ghost outlines survive.
 */
function buildMissingInkLayer(full: HTMLImageElement, parts: HTMLImageElement[]): HTMLCanvasElement | null {
  const off = document.createElement('canvas');
  off.width = FRAME_WIDTH;
  off.height = FRAME_HEIGHT;
  const octx = off.getContext('2d')!;
  octx.drawImage(full, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);

  const imgData = octx.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
    data[i + 3] = Math.min(data[i + 3], 255 - lum);
  }
  octx.putImageData(imgData, 0, 0);

  octx.globalCompositeOperation = 'destination-out';
  const RADIUS = 3;
  for (const part of parts) {
    for (let oy = -RADIUS; oy <= RADIUS; oy++) {
      for (let ox = -RADIUS; ox <= RADIUS; ox++) {
        octx.drawImage(part, ox, oy, FRAME_WIDTH, FRAME_HEIGHT);
      }
    }
  }
  octx.globalCompositeOperation = 'source-over';

  const cleaned = octx.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
  for (let i = 3; i < cleaned.data.length; i += 4) {
    if (cleaned.data[i] < 60) cleaned.data[i] = 0;
  }
  octx.putImageData(cleaned, 0, 0);

  return measureInk([off]) ? off : null;
}

/** Normalize any source (image or canvas, any resolution) into a frame-sized canvas. */
function toFrameCanvas(source: CanvasImageSource): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = FRAME_WIDTH;
  canvas.height = FRAME_HEIGHT;
  canvas.getContext('2d')!.drawImage(source, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
  return canvas;
}

/**
 * The "Mark Veksler" signature in 3D: the assembled signature floats and
 * slowly rotates in space at ~1/3 viewport size. Clicking fires a blast —
 * every stroke piece tumbles away in 3D (with spin and depth) and springs
 * elastically back into the signature.
 */
class SignatureSketch implements Sketch {
  private ctx!: ThreeContext;
  private group = new THREE.Group();
  private pieces: Piece[] = [];
  private raycaster = new THREE.Raycaster();
  private clickPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  // 0 = everything docked (flat, static 2D look), 1 = pieces in flight
  // (3D sway + perspective visible). Eases between the two.
  private activity = 0;

  // Near-critically damped: pieces fly out fast, decelerate hard as they
  // approach their farthest point, hang there, then drift slowly home
  // with no wild wobble.
  private static readonly SPRING_K = 6;
  private static readonly DAMPING = 4;
  private static readonly BLAST_POWER = 18; // world units — kick = POWER / distance
  private static readonly MAX_KICK = 30;
  private static readonly MAX_SPIN = 2.5; // rad/s per axis — just a little tumble
  private static readonly DEPTH_KICK = 8; // max ± z velocity on blast

  // Orbit tuning: at the apex each piece swings into a coherent (same
  // direction) orbit around the signature center, on its own slightly
  // tilted plane, then spirals in and lets the springs dock it.
  private static readonly LAUNCH_END_SPEED = 2.5; // apex detection threshold
  private static readonly LAUNCH_TIMEOUT = 0.9; // s — safety net
  private static readonly ORBIT_OMEGA_MIN = 1.2; // rad/s
  private static readonly ORBIT_OMEGA_MAX = 2.2;
  private static readonly ORBIT_REVS_MIN = 1;
  private static readonly ORBIT_REVS_MAX = 2;
  private static readonly ORBIT_TILT = 0.35; // ± rad on x/y of the orbit plane
  private static readonly ORBIT_MIN_RADIUS = 1.0; // too close to home — skip orbit

  // Smooth launch→orbit handoff: the orbit starts from the piece's REAL
  // velocity at insertion (tangential part → initial angular speed, radial
  // part → initial radius rate) so travel direction never snaps. Angular
  // speed then eases toward the cruise omega, and radius follows a damped
  // spring toward the designed decay path.
  private static readonly ORBIT_BLEND_RATE = 2.5; // /s — how fast omega reaches cruise
  private static readonly ORBIT_R_K = 8; // radial spring stiffness
  private static readonly ORBIT_R_D = 5.5; // radial damping (≈ critical)
  private static readonly ORBIT_DIR_THRESHOLD = 0.3; // rad/s — below this, default to CCW

  // Drag tuning: while held, x/y track the cursor exactly (no lag). Rotation
  // has a bounded "degree of freedom" but is never free — it's a direct
  // function of the current drag vector (last cursor sample → current
  // sample), the only thing that can move it while held. Releasing hands
  // that same vector off as the launch velocity, so a fast flick both
  // tilts hard right before release and shoots off fast; a slow, paused
  // release lets the tilt relax back to flat and barely moves at all.
  private static readonly DRAG_VELOCITY_SCALE = 70; // per-move (current-last) delta → velocity units
  private static readonly DRAG_VELOCITY_DECAY = 6; // /s — relaxes the drag vector when the pointer holds still
  private static readonly DRAG_TILT_SOFT = 0.014; // soft-mapping slope: velocity → tanh argument
  private static readonly DRAG_MAX_TILT = 0.55; // rad — the tilt's "degree of freedom" ceiling
  private static readonly DRAG_TILT_RESPONSE = 16; // /s — how fast the tilt chases the drag direction
  private static readonly DRAG_LEAN_RATIO = 0.8; // y-axis "lean into the pull" as a fraction of max tilt
  private static readonly DRAG_RELEASE_DEPTH_KICK = 4; // ± z velocity imparted on release
  private static readonly PICK_ALPHA_THRESHOLD = 40; // out of 255
  private static readonly PICK_PIXEL_RADIUS = 3; // forgiveness around the exact pixel
  private static readonly DRAG_MOVE_TOLERANCE = 6; // px — below this, pointerup counts as a click
  private static readonly RIPPLE_GRAB_POWER = 2.2; // one-time shiver when a piece is grabbed
  private static readonly RIPPLE_WAKE_POWER = 1.1; // continuous wake while dragging fast

  private draggedPiece: Piece | null = null;
  private pointerDownPos = { x: 0, y: 0 };

  private toNDC(e: PointerEvent): THREE.Vector2 {
    const rect = this.ctx.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /** Raycast the pointer onto the world z=0 plane and return the hit in group-local space. */
  private raycastToPlaneLocal(ndc: THREE.Vector2): THREE.Vector3 | null {
    this.raycaster.setFromCamera(ndc, this.ctx.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.clickPlane, hit)) return null;
    return this.group.worldToLocal(hit);
  }

  /** Does this piece have ink within a small pixel radius of the given frame coordinate? */
  private hasInkNear(piece: Piece, px: number, py: number): boolean {
    const r = SignatureSketch.PICK_PIXEL_RADIUS;
    for (let oy = -r; oy <= r; oy++) {
      const y = py + oy;
      if (y < 0 || y >= FRAME_HEIGHT) continue;
      for (let ox = -r; ox <= r; ox++) {
        const x = px + ox;
        if (x < 0 || x >= FRAME_WIDTH) continue;
        if (piece.alpha[y * FRAME_WIDTH + x] > SignatureSketch.PICK_ALPHA_THRESHOLD) return true;
      }
    }
    return false;
  }

  /**
   * Real geometry raycast against every stroke plane (front to back), then
   * sample that piece's actual ink alpha at the hit point — so the piece
   * you grab is always the one whose stroke is visibly under the cursor,
   * not just whichever transparent quad happens to be nearest the camera.
   */
  private pickPiece(ndc: THREE.Vector2): { piece: Piece; point: THREE.Vector3 } | null {
    this.raycaster.setFromCamera(ndc, this.ctx.camera);
    const hits = this.raycaster.intersectObjects(
      this.pieces.map((p) => p.mesh),
      false,
    );
    for (const hit of hits) {
      if (!hit.uv) continue;
      const piece = this.pieces.find((p) => p.mesh === hit.object);
      if (!piece) continue;
      const px = Math.floor(hit.uv.x * FRAME_WIDTH);
      const py = Math.floor((1 - hit.uv.y) * FRAME_HEIGHT);
      if (this.hasInkNear(piece, px, py)) {
        return { piece, point: this.group.worldToLocal(hit.point.clone()) };
      }
    }
    return null;
  }

  /**
   * A small radial impulse outward from `originLocal`, felt by every piece
   * except the one being handled — the rest of the signature visibly
   * shivers without straying far. Only nudges pieces that are otherwise at
   * rest so it never fights an in-progress blast.
   */
  private ripple(originLocal: THREE.Vector3, magnitude: number, exclude: Piece): void {
    for (const piece of this.pieces) {
      if (piece === exclude || (piece.phase !== 'idle' && piece.phase !== 'home')) continue;
      const current = new THREE.Vector3().addVectors(piece.center, piece.offset);
      const dir = new THREE.Vector3().subVectors(current, originLocal);
      dir.z = 0;
      const dist = dir.length();
      if (dist < 0.01) continue;
      dir.divideScalar(dist);
      const falloff = magnitude / (1 + dist * dist);
      piece.velocity.addScaledVector(dir, falloff);
      piece.velocity.z += (Math.random() - 0.5) * falloff * 0.4;
      if (piece.phase === 'idle') piece.phase = 'home';
    }
  }

  /** Randomize this flight's orbit personality — shared by blast() and a drag release. */
  private static assignOrbitPersonality(piece: Piece): void {
    const S = SignatureSketch;
    piece.orbitOmega = S.ORBIT_OMEGA_MIN + Math.random() * (S.ORBIT_OMEGA_MAX - S.ORBIT_OMEGA_MIN);
    piece.orbitTotal = (S.ORBIT_REVS_MIN + Math.random() * (S.ORBIT_REVS_MAX - S.ORBIT_REVS_MIN)) * Math.PI * 2;
    piece.orbitTilt.setFromEuler(
      new THREE.Euler((Math.random() - 0.5) * 2 * S.ORBIT_TILT, (Math.random() - 0.5) * 2 * S.ORBIT_TILT, 0),
    );
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.draggedPiece) return;
    this.pointerDownPos = { x: e.clientX, y: e.clientY };

    const picked = this.pickPiece(this.toNDC(e));
    if (!picked) return; // empty space — resolved as a click/blast on pointerup

    const { piece, point } = picked;
    this.draggedPiece = piece;
    piece.phase = 'drag';
    // Starts flat and at rest — any leftover tumble from a mid-blast grab
    // stops dead the moment it's grabbed. From here rotation only moves in
    // response to the drag vector (see update()'s 'drag' case).
    piece.rotation.set(0, 0, 0);
    piece.spin.set(0, 0, 0);
    piece.velocity.set(0, 0, 0);
    piece.dragCursor.copy(point);
    piece.dragRippleTimer = 0;
    this.ripple(point, SignatureSketch.RIPPLE_GRAB_POWER, piece);
    this.ctx.renderer.domElement.style.cursor = 'grabbing';
  };

  private onPointerMove = (e: PointerEvent): void => {
    const piece = this.draggedPiece;
    if (!piece) {
      // Lightweight hover feedback: show a grab cursor over ink
      this.ctx.renderer.domElement.style.cursor = this.pickPiece(this.toNDC(e)) ? 'grab' : 'auto';
      return;
    }
    const local = this.raycastToPlaneLocal(this.toNDC(e));
    if (!local) return;

    // Rigid 1:1 tracking — the grabbed point follows the cursor exactly,
    // no spring lag, while the pointer is held
    const delta = new THREE.Vector3().subVectors(local, piece.dragCursor);
    piece.offset.add(delta);
    piece.dragCursor.copy(local);

    // The vector from the last cursor sample to this one — direction and
    // distance both come straight from these two points, no time term.
    // This drives the live tilt each frame and is what release throws with.
    piece.velocity.copy(delta).multiplyScalar(SignatureSketch.DRAG_VELOCITY_SCALE);
  };

  private onPointerUp = (e: PointerEvent): void => {
    const piece = this.draggedPiece;
    if (piece) {
      const S = SignatureSketch;
      // The throw: whatever velocity the cursor had at release becomes the
      // piece's launch velocity — this is the moment it starts "flying"
      const releaseSpeed = piece.velocity.length();
      piece.velocity.clampLength(0, S.MAX_KICK * 1.2);
      piece.velocity.z += (Math.random() - 0.5) * 2 * S.DRAG_RELEASE_DEPTH_KICK;

      // Spin only begins now too, scaled by how fast it was released
      const spinIntensity = 0.3 + Math.min(1, releaseSpeed / S.MAX_KICK) * 2.2;
      piece.spin.set(
        (Math.random() - 0.5) * 2 * S.MAX_SPIN * spinIntensity,
        (Math.random() - 0.5) * 2 * S.MAX_SPIN * spinIntensity,
        (Math.random() - 0.5) * 2 * S.MAX_SPIN * spinIntensity,
      );

      piece.phase = 'launch';
      piece.launchAge = 0;
      SignatureSketch.assignOrbitPersonality(piece);

      this.draggedPiece = null;
      this.ctx.renderer.domElement.style.cursor = 'auto';
      return;
    }

    const dx = e.clientX - this.pointerDownPos.x;
    const dy = e.clientY - this.pointerDownPos.y;
    if (Math.hypot(dx, dy) > SignatureSketch.DRAG_MOVE_TOLERANCE) return;

    const local = this.raycastToPlaneLocal(this.toNDC(e));
    if (local) this.blast(local);
  };

  init(container: HTMLElement): void {
    this.ctx = createThreeContext(container);
    const { scene, camera, renderer } = this.ctx;

    scene.background = new THREE.Color(0xf5f2ec);
    camera.position.set(0, 0, 6);
    camera.lookAt(0, 0, 0);
    scene.add(this.group);

    renderer.domElement.style.touchAction = 'none'; // prevent scroll/zoom from eating drag gestures
    renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);

    void Promise.all([loadImage(FULL_SIGNATURE), ...PART_FILES.map(loadImage)]).then(([full, ...parts]) => {
      const sources: CanvasImageSource[] = [...parts];
      const missing = buildMissingInkLayer(full, parts);
      if (missing) sources.push(missing);

      const maxAniso = renderer.capabilities.getMaxAnisotropy();
      sources.forEach((source, i) => {
        const bounds = measureInk([source]) ?? { x: 0, y: 0, width: FRAME_WIDTH, height: FRAME_HEIGHT };
        const frameCanvas = toFrameCanvas(source);
        const texture = new THREE.CanvasTexture(frameCanvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = maxAniso;

        // Alpha-only copy of this piece's ink, for precise pointer hit-testing
        const imgData = frameCanvas.getContext('2d')!.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT).data;
        const alpha = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT);
        for (let idx = 0; idx < alpha.length; idx++) alpha[idx] = imgData[idx * 4 + 3];

        const geometry = new THREE.PlaneGeometry(BASE_WIDTH, BASE_HEIGHT);
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(geometry, material);
        // Tiny z stagger keeps stacked transparent planes rendering cleanly
        const home = new THREE.Vector3(0, 0, i * 0.004);
        mesh.position.copy(home);
        this.group.add(mesh);

        // Ink center of this stroke in group-local coordinates
        const center = new THREE.Vector3(
          ((bounds.x + bounds.width / 2) / FRAME_WIDTH - 0.5) * BASE_WIDTH,
          -((bounds.y + bounds.height / 2) / FRAME_HEIGHT - 0.5) * BASE_HEIGHT,
          0,
        );

        this.pieces.push({
          mesh,
          home,
          center,
          offset: new THREE.Vector3(),
          velocity: new THREE.Vector3(),
          rotation: new THREE.Vector3(),
          spin: new THREE.Vector3(),
          alpha,
          phase: 'idle',
          launchAge: 0,
          orbitAngle: 0,
          orbitTotal: 0,
          orbitTheta: 0,
          orbitR0: 0,
          orbitREnd: 0,
          orbitZ0: 0,
          orbitOmega: 0,
          orbitOmegaCurrent: 0,
          orbitR: 0,
          orbitRDot: 0,
          orbitTilt: new THREE.Quaternion(),
          dragCursor: new THREE.Vector3(),
          dragRippleTimer: 0,
        });
      });

      this.fitGroupToViewport();
    });
  }

  /** Scale the signature so it appears at ~1/3 of the viewport width. */
  private fitGroupToViewport(): void {
    const { camera } = this.ctx;
    const distance = camera.position.z;
    const viewHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const viewWidth = viewHeight * camera.aspect;
    const target = Math.min(viewWidth, viewHeight * (BASE_WIDTH / BASE_HEIGHT)) / 3;
    const scale = target / BASE_WIDTH;
    this.group.scale.setScalar(scale);
  }

  /** Kick every stroke piece away from the click point and queue it for orbit. */
  private blast(clickLocal: THREE.Vector3): void {
    const S = SignatureSketch;
    for (const piece of this.pieces) {
      if (piece.phase === 'drag') continue; // never override a piece the user is holding

      // Direction from the click to the piece's *current* ink position, so
      // re-blasting mid-orbit scatters from wherever the pieces are now
      const current = new THREE.Vector3().addVectors(piece.center, piece.offset);
      const dir = new THREE.Vector3().subVectors(current, clickLocal);
      dir.z = 0;
      let dist = dir.length();
      if (dist < 0.05) {
        dir.set(Math.cos(Math.random() * Math.PI * 2), Math.sin(Math.random() * Math.PI * 2), 0);
        dist = 0.05;
      } else {
        dir.divideScalar(dist);
      }

      const kick = Math.min(S.MAX_KICK, S.BLAST_POWER / Math.max(dist, 0.4));
      piece.velocity.x += dir.x * kick;
      piece.velocity.y += dir.y * kick;
      piece.velocity.z += (Math.random() - 0.5) * 2 * S.DEPTH_KICK;

      // Random per-piece spin intensity: most pieces tumble gently, a few
      // whirl much faster (squared random skews toward the low end)
      const spinIntensity = 0.3 + Math.random() * Math.random() * 2.5;
      piece.spin.x += (Math.random() - 0.5) * 2 * S.MAX_SPIN * spinIntensity;
      piece.spin.y += (Math.random() - 0.5) * 2 * S.MAX_SPIN * spinIntensity;
      piece.spin.z += (Math.random() - 0.5) * 2 * S.MAX_SPIN * spinIntensity;

      // Assign this flight's orbit personality now; insertion happens at apex
      piece.phase = 'launch';
      piece.launchAge = 0;
      SignatureSketch.assignOrbitPersonality(piece);
    }
  }

  /** Wrap accumulated tumble to ±π so the homing spring takes the short way flat. */
  private static wrapRotation(piece: Piece): void {
    piece.rotation.x = THREE.MathUtils.euclideanModulo(piece.rotation.x + Math.PI, Math.PI * 2) - Math.PI;
    piece.rotation.y = THREE.MathUtils.euclideanModulo(piece.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
    piece.rotation.z = THREE.MathUtils.euclideanModulo(piece.rotation.z + Math.PI, Math.PI * 2) - Math.PI;
  }

  /**
   * Capture the piece's current position AND velocity as the starting
   * conditions of its orbit, so the handoff is seamless: the tangential
   * velocity component becomes the initial angular speed and the radial
   * component becomes the initial radius rate — the outward coast arcs
   * into the circle instead of snapping ~90° into it.
   */
  private enterOrbit(piece: Piece): void {
    const S = SignatureSketch;
    // Ink position relative to the signature center (group origin)
    const p = new THREE.Vector3().addVectors(piece.center, piece.offset).add(piece.home);
    // Express position and velocity in the orbit plane's coordinates
    const inverseTilt = piece.orbitTilt.clone().invert();
    p.applyQuaternion(inverseTilt);
    const v = piece.velocity.clone().applyQuaternion(inverseTilt);

    const r0 = Math.hypot(p.x, p.y);
    if (r0 < S.ORBIT_MIN_RADIUS) {
      SignatureSketch.wrapRotation(piece); // barely moved — no orbit, just dock
      piece.phase = 'home';
      return;
    }

    const theta0 = Math.atan2(p.y, p.x);
    // Decompose planar velocity into radial and tangential components
    const cos = Math.cos(theta0);
    const sin = Math.sin(theta0);
    const vRad = v.x * cos + v.y * sin;
    const vTan = -v.x * sin + v.y * cos;
    const omega0 = vTan / Math.max(r0, 0.3);

    // Orbit direction follows the piece's own motion when it's decisive;
    // otherwise default to the coherent counterclockwise swarm
    const dirSign = Math.abs(omega0) > S.ORBIT_DIR_THRESHOLD ? Math.sign(omega0) : 1;
    piece.orbitOmega = dirSign * Math.abs(piece.orbitOmega);

    piece.orbitR0 = r0;
    piece.orbitR = r0;
    piece.orbitRDot = vRad;
    piece.orbitREnd = Math.max(piece.center.length(), 0.5);
    piece.orbitTheta = theta0;
    piece.orbitOmegaCurrent = omega0;
    piece.orbitZ0 = p.z;
    piece.orbitAngle = 0;
    piece.phase = 'orbit';
  }

  update(dt: number, elapsed: number): void {
    const K = SignatureSketch.SPRING_K;
    const D = SignatureSketch.DAMPING;

    for (const piece of this.pieces) {
      piece.launchAge += dt;

      switch (piece.phase) {
        case 'launch': {
          // Drag only — fly out and decelerate toward the apex, nothing pulls home
          piece.velocity.addScaledVector(piece.velocity, -D * dt);
          piece.offset.addScaledVector(piece.velocity, dt);
          if (
            piece.velocity.length() < SignatureSketch.LAUNCH_END_SPEED ||
            piece.launchAge > SignatureSketch.LAUNCH_TIMEOUT
          ) {
            this.enterOrbit(piece);
          }
          break;
        }
        case 'orbit': {
          const S = SignatureSketch;
          // Angular speed eases from its insertion value toward cruise, so
          // the piece picks up (or sheds) swirl gradually instead of snapping
          piece.orbitOmegaCurrent +=
            (piece.orbitOmega - piece.orbitOmegaCurrent) * Math.min(1, S.ORBIT_BLEND_RATE * dt);
          piece.orbitTheta += piece.orbitOmegaCurrent * dt;
          piece.orbitAngle += Math.abs(piece.orbitOmegaCurrent) * dt;
          const t = Math.min(piece.orbitAngle / piece.orbitTotal, 1);

          // Radius: damped spring toward the designed decay path, seeded
          // with the real radial velocity — outward drift arcs over smoothly
          const rTarget = piece.orbitR0 + (piece.orbitREnd - piece.orbitR0) * t * t;
          piece.orbitRDot += (-S.ORBIT_R_K * (piece.orbitR - rTarget) - S.ORBIT_R_D * piece.orbitRDot) * dt;
          piece.orbitR += piece.orbitRDot * dt;

          const local = new THREE.Vector3(
            piece.orbitR * Math.cos(piece.orbitTheta),
            piece.orbitR * Math.sin(piece.orbitTheta),
            piece.orbitZ0 * (1 - t),
          );
          local.applyQuaternion(piece.orbitTilt);

          // Parametric position → offset; keep velocity in sync so the
          // spring dock-in inherits the orbital motion seamlessly
          const newOffset = local.sub(piece.center).sub(piece.home);
          piece.velocity.copy(newOffset).sub(piece.offset).divideScalar(Math.max(dt, 1e-4));
          piece.offset.copy(newOffset);

          if (t >= 1) {
            SignatureSketch.wrapRotation(piece);
            piece.phase = 'home';
          }
          break;
        }
        case 'home': {
          // Damped springs dock the piece back into the signature
          piece.velocity.x += (-K * piece.offset.x - D * piece.velocity.x) * dt;
          piece.velocity.y += (-K * piece.offset.y - D * piece.velocity.y) * dt;
          piece.velocity.z += (-K * piece.offset.z - D * piece.velocity.z) * dt;
          piece.offset.addScaledVector(piece.velocity, dt);
          if (
            piece.offset.lengthSq() < 1e-5 &&
            piece.velocity.lengthSq() < 1e-5 &&
            piece.rotation.lengthSq() < 1e-4 &&
            piece.spin.lengthSq() < 1e-4
          ) {
            piece.offset.set(0, 0, 0);
            piece.velocity.set(0, 0, 0);
            piece.rotation.set(0, 0, 0);
            piece.spin.set(0, 0, 0);
            piece.phase = 'idle';
          }
          break;
        }
        case 'drag': {
          // Position is driven directly by the pointer handler (rigid 1:1
          // tracking). Rotation has a bounded "degree of freedom" but no
          // physics of its own — it chases the current drag vector with a
          // fast attack, so changing pull direction flips the tilt almost
          // immediately. tanh soft-maps speed to tilt: slow pulls give
          // proportional lean, fast pulls saturate gently at the ceiling
          // instead of pegging — so every direction change reads visibly.
          const S = SignatureSketch;
          piece.velocity.multiplyScalar(Math.max(0, 1 - S.DRAG_VELOCITY_DECAY * dt));
          const targetZ = -S.DRAG_MAX_TILT * Math.tanh(piece.velocity.x * S.DRAG_TILT_SOFT);
          const targetX = S.DRAG_MAX_TILT * Math.tanh(piece.velocity.y * S.DRAG_TILT_SOFT);
          const targetY = S.DRAG_MAX_TILT * S.DRAG_LEAN_RATIO * Math.tanh(piece.velocity.x * S.DRAG_TILT_SOFT);
          const chase = Math.min(1, S.DRAG_TILT_RESPONSE * dt);
          piece.rotation.z += (targetZ - piece.rotation.z) * chase;
          piece.rotation.x += (targetX - piece.rotation.x) * chase;
          piece.rotation.y += (targetY - piece.rotation.y) * chase;
          piece.spin.set(0, 0, 0); // reactive only — no independent spin/inertia while held

          piece.dragRippleTimer += dt;
          if (piece.dragRippleTimer > 0.15) {
            piece.dragRippleTimer = 0;
            const mag = SignatureSketch.RIPPLE_WAKE_POWER * Math.min(1, piece.velocity.length() / 5);
            if (mag > 0.01) {
              const currentLocal = new THREE.Vector3().addVectors(piece.center, piece.offset).add(piece.home);
              this.ripple(currentLocal, mag, piece);
            }
          }
          break;
        }
        case 'idle':
          break;
      }

      // Rotation: free tumble while flying (the 3D moment), sprung flat on
      // the way home so the docked signature reads as a 2D image. Handled
      // entirely inside the 'drag' case above while being dragged.
      if (piece.phase === 'launch' || piece.phase === 'orbit') {
        piece.spin.addScaledVector(piece.spin, -0.4 * dt); // gentle decay
        piece.rotation.addScaledVector(piece.spin, dt);
      } else if (piece.phase === 'home') {
        piece.spin.x += (-K * piece.rotation.x - D * piece.spin.x) * dt;
        piece.spin.y += (-K * piece.rotation.y - D * piece.spin.y) * dt;
        piece.spin.z += (-K * piece.rotation.z - D * piece.spin.z) * dt;
        piece.rotation.addScaledVector(piece.spin, dt);
      }

      piece.mesh.position.copy(piece.home).add(piece.offset);
      piece.mesh.rotation.set(piece.rotation.x, piece.rotation.y, piece.rotation.z);
    }

    // The whole-signature 3D sway only engages during a real blast flight
    // (launch/orbit). Dragging a single piece, or the ripple it sends
    // through the rest, must never tilt the group — idle stays a flat 2D
    // image except for the one piece being pulled.
    const anyFlying = this.pieces.some((p) => p.phase === 'launch' || p.phase === 'orbit');
    this.activity += ((anyFlying ? 1 : 0) - this.activity) * Math.min(1, dt * 1.5);
    if (this.activity < 0.001) this.activity = 0;
    this.group.rotation.y = Math.sin(elapsed * 0.5) * 0.35 * this.activity;
    this.group.rotation.x = Math.sin(elapsed * 0.3) * 0.15 * this.activity;

    this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);
  }

  resize(width: number, height: number): void {
    resizeThreeContext(this.ctx, width, height);
    this.fitGroupToViewport();
  }

  dispose(): void {
    this.ctx.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    for (const piece of this.pieces) {
      piece.mesh.geometry.dispose();
      const material = piece.mesh.material as THREE.MeshBasicMaterial;
      material.map?.dispose();
      material.dispose();
    }
    this.pieces = [];
    disposeThreeContext(this.ctx);
  }
}

const sketch = new SignatureSketch();
runSketch(sketch, document.getElementById('sketch')!);
// Dev convenience: lets browser tooling inspect piece state
(window as unknown as Record<string, unknown>).__signatureSketch = sketch;
