import type { Sketch } from '../../core/sketch';
import { runSketch } from '../../core/runner';

// The four stroke layers of the handwritten "R" mark. They share one
// registration canvas: parts 1/3/4 are 828x244, part 2 is exported at
// half scale (414x122) and is drawn at 2x so everything lines up.
const LOGO_WIDTH = 828;
const LOGO_HEIGHT = 244;

const LAYER_URLS = [
  new URL('../../img/R part 1.png', import.meta.url).href,
  new URL('../../img/R part 2.png', import.meta.url).href,
  new URL('../../img/R part 3.png', import.meta.url).href,
  new URL('../../img/R part 4.png', import.meta.url).href,
];

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A stroke layer with its ink bounds and spring-animated screen offset. */
interface Layer {
  image: HTMLImageElement;
  bounds: Bounds;
  offsetX: number;
  offsetY: number;
  velX: number;
  velY: number;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}

/**
 * Composite images into the registration frame and return the bounding
 * box of visible pixels — the actual ink, ignoring empty canvas space.
 */
function measureInk(images: HTMLImageElement[]): Bounds | null {
  const off = document.createElement('canvas');
  off.width = LOGO_WIDTH;
  off.height = LOGO_HEIGHT;
  const octx = off.getContext('2d')!;
  for (const image of images) {
    octx.drawImage(image, 0, 0, LOGO_WIDTH, LOGO_HEIGHT);
  }
  const data = octx.getImageData(0, 0, LOGO_WIDTH, LOGO_HEIGHT).data;
  let minX = LOGO_WIDTH;
  let minY = LOGO_HEIGHT;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < LOGO_HEIGHT; y++) {
    for (let x = 0; x < LOGO_WIDTH; x++) {
      if (data[(y * LOGO_WIDTH + x) * 4 + 3] > 10) {
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
 * The handwritten "R" mark, centered on the page. Clicking fires a blast
 * from the cursor: each stroke is kicked away from the click point, then
 * a damped spring pulls it elastically back home over ~3 seconds.
 */
class MarkLogoSketch implements Sketch {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private layers: Layer[] = [];
  private inkBounds: Bounds = { x: 0, y: 0, width: LOGO_WIDTH, height: LOGO_HEIGHT };

  // Spring tuning: under-damped so strokes overshoot and wobble home,
  // amplitude decays to ~2% within 3 seconds.
  private static readonly SPRING_K = 40;
  private static readonly DAMPING = 2.5;
  private static readonly BLAST_POWER = 50000; // kick = POWER / distance
  private static readonly MAX_KICK = 900; // px/s

  private onClick = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.blast(e.clientX - rect.left, e.clientY - rect.top);
  };

  init(container: HTMLElement): void {
    this.canvas = document.createElement('canvas');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('click', this.onClick);

    void Promise.all(LAYER_URLS.map(loadImage)).then((images) => {
      this.layers = images.map((image) => ({
        image,
        bounds: measureInk([image]) ?? { x: 0, y: 0, width: LOGO_WIDTH, height: LOGO_HEIGHT },
        offsetX: 0,
        offsetY: 0,
        velX: 0,
        velY: 0,
      }));
      this.inkBounds = measureInk(images) ?? this.inkBounds;
    });
  }

  /** Screen placement: ink centered, fit to 60% of viewport, capped at 2x. */
  private getTransform(): { scale: number; originX: number; originY: number } {
    const { x, y, width, height } = this.inkBounds;
    const scale = Math.min(2, (this.width * 0.6) / width, (this.height * 0.6) / height);
    return {
      scale,
      originX: this.width / 2 - (x + width / 2) * scale,
      originY: this.height / 2 - (y + height / 2) * scale,
    };
  }

  /** Kick every stroke directly away from the click point; closer hits kick harder. */
  private blast(clickX: number, clickY: number): void {
    const { scale, originX, originY } = this.getTransform();
    for (const layer of this.layers) {
      const cx = originX + (layer.bounds.x + layer.bounds.width / 2) * scale + layer.offsetX;
      const cy = originY + (layer.bounds.y + layer.bounds.height / 2) * scale + layer.offsetY;
      let dx = cx - clickX;
      let dy = cy - clickY;
      let dist = Math.hypot(dx, dy);
      if (dist < 1) {
        // Click dead-center on a stroke: pick a random escape direction
        const angle = Math.random() * Math.PI * 2;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        dist = 1;
      }
      const kick = Math.min(MarkLogoSketch.MAX_KICK, MarkLogoSketch.BLAST_POWER / Math.max(dist, 60));
      layer.velX += (dx / dist) * kick;
      layer.velY += (dy / dist) * kick;
    }
  }

  update(dt: number, _elapsed: number): void {
    const { ctx, width, height } = this;

    // Damped spring pulls each stroke's offset back to zero
    for (const layer of this.layers) {
      layer.velX += (-MarkLogoSketch.SPRING_K * layer.offsetX - MarkLogoSketch.DAMPING * layer.velX) * dt;
      layer.velY += (-MarkLogoSketch.SPRING_K * layer.offsetY - MarkLogoSketch.DAMPING * layer.velY) * dt;
      layer.offsetX += layer.velX * dt;
      layer.offsetY += layer.velY * dt;
    }

    ctx.fillStyle = '#f5f2ec';
    ctx.fillRect(0, 0, width, height);
    if (this.layers.length === 0) return;

    const { scale, originX, originY } = this.getTransform();
    for (const layer of this.layers) {
      ctx.drawImage(
        layer.image,
        originX + layer.offsetX,
        originY + layer.offsetY,
        LOGO_WIDTH * scale,
        LOGO_HEIGHT * scale,
      );
    }
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  dispose(): void {
    this.canvas.removeEventListener('click', this.onClick);
    this.canvas.remove();
    this.layers = [];
  }
}

runSketch(new MarkLogoSketch(), document.getElementById('sketch')!);
