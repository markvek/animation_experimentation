import type { Sketch } from '../../core/sketch';
import { runSketch } from '../../core/runner';

// Each letter is an array of stroke layers in registration (828x244).
const LETTERS: Record<string, string[]> = {
  A: [
    new URL('../../img/A part 1.png', import.meta.url).href,
    new URL('../../img/A part 2.png', import.meta.url).href,
    new URL('../../img/A part 3.png', import.meta.url).href,
  ],
  E: [
    new URL('../../img/E part 1.png', import.meta.url).href,
    new URL('../../img/E Part 2.png', import.meta.url).href,
    new URL('../../img/E part 3.png', import.meta.url).href,
    new URL('../../img/E part 4.png', import.meta.url).href,
  ],
  E2: [
    new URL('../../img/E2 part 1.png', import.meta.url).href,
    new URL('../../img/E2 part 2.png', import.meta.url).href,
    new URL('../../img/E2 part 3.png', import.meta.url).href,
    new URL('../../img/E2 part 4.png', import.meta.url).href,
  ],
  K: [
    new URL('../../img/K part 1.png', import.meta.url).href,
    new URL('../../img/K part 2.png', import.meta.url).href,
    new URL('../../img/K part 3.png', import.meta.url).href,
  ],
  K2: [
    new URL('../../img/K2 part 1.png', import.meta.url).href,
    new URL('../../img/K2 part 2.png', import.meta.url).href,
    new URL('../../img/K2 part 3.png', import.meta.url).href,
  ],
  L: [new URL('../../img/L part 1 of 1.png', import.meta.url).href],
  M: [
    new URL('../../img/M part 1.png', import.meta.url).href,
    new URL('../../img/M part 2.png', import.meta.url).href,
    new URL('../../img/M part 3.png', import.meta.url).href,
    new URL('../../img/M part 4.png', import.meta.url).href,
  ],
  R: [
    new URL('../../img/R part 1.png', import.meta.url).href,
    new URL('../../img/R part 2.png', import.meta.url).href,
    new URL('../../img/R part 3.png', import.meta.url).href,
    new URL('../../img/R part 4.png', import.meta.url).href,
  ],
  S: [
    new URL('../../img/S part 1.png', import.meta.url).href,
    new URL('../../img/S part 2.png', import.meta.url).href,
    new URL('../../img/S part 3.png', import.meta.url).href,
  ],
  V: [
    new URL('../../img/V Part 1.png', import.meta.url).href,
    new URL('../../img/V Part 2.png', import.meta.url).href,
  ],
};

const LETTER_NAMES = Object.keys(LETTERS);
const LOGO_WIDTH = 828;
const LOGO_HEIGHT = 244;

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
 * Full signature: all letters A–V with blast animation. Click to blast,
 * arrow keys to cycle through letters. Each letter loads on demand.
 */
class FullMarkSketch implements Sketch {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;

  private letterIndex = 7; // Start on "R"
  private layers: Layer[] = [];
  private inkBounds: Bounds = { x: 0, y: 0, width: LOGO_WIDTH, height: LOGO_HEIGHT };

  private static readonly SPRING_K = 40;
  private static readonly DAMPING = 2.5;
  private static readonly BLAST_POWER = 50000;
  private static readonly MAX_KICK = 900;

  private onClick = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.blast(e.clientX - rect.left, e.clientY - rect.top);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowLeft' && this.letterIndex > 0) {
      e.preventDefault();
      this.switchLetter(this.letterIndex - 1);
    } else if (e.key === 'ArrowRight' && this.letterIndex < LETTER_NAMES.length - 1) {
      e.preventDefault();
      this.switchLetter(this.letterIndex + 1);
    }
  };

  init(container: HTMLElement): void {
    this.canvas = document.createElement('canvas');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('click', this.onClick);
    window.addEventListener('keydown', this.onKeyDown);

    // Load the starting letter (R)
    this.switchLetter(this.letterIndex);
  }

  private switchLetter(index: number): void {
    this.letterIndex = index;
    const letterName = LETTER_NAMES[index];
    const urls = LETTERS[letterName];

    void Promise.all(urls.map(loadImage)).then((images) => {
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

  private getTransform(): { scale: number; originX: number; originY: number } {
    const { x, y, width, height } = this.inkBounds;
    const scale = Math.min(2, (this.width * 0.6) / width, (this.height * 0.6) / height);
    return {
      scale,
      originX: this.width / 2 - (x + width / 2) * scale,
      originY: this.height / 2 - (y + height / 2) * scale,
    };
  }

  private blast(clickX: number, clickY: number): void {
    const { scale, originX, originY } = this.getTransform();
    for (const layer of this.layers) {
      const cx = originX + (layer.bounds.x + layer.bounds.width / 2) * scale + layer.offsetX;
      const cy = originY + (layer.bounds.y + layer.bounds.height / 2) * scale + layer.offsetY;
      let dx = cx - clickX;
      let dy = cy - clickY;
      let dist = Math.hypot(dx, dy);
      if (dist < 1) {
        const angle = Math.random() * Math.PI * 2;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        dist = 1;
      }
      const kick = Math.min(FullMarkSketch.MAX_KICK, FullMarkSketch.BLAST_POWER / Math.max(dist, 60));
      layer.velX += (dx / dist) * kick;
      layer.velY += (dy / dist) * kick;
    }
  }

  update(dt: number, _elapsed: number): void {
    const { ctx, width, height } = this;

    for (const layer of this.layers) {
      layer.velX += (-FullMarkSketch.SPRING_K * layer.offsetX - FullMarkSketch.DAMPING * layer.velX) * dt;
      layer.velY += (-FullMarkSketch.SPRING_K * layer.offsetY - FullMarkSketch.DAMPING * layer.velY) * dt;
      layer.offsetX += layer.velX * dt;
      layer.offsetY += layer.velY * dt;
    }

    ctx.fillStyle = '#f5f2ec';
    ctx.fillRect(0, 0, width, height);

    if (this.layers.length === 0) {
      ctx.fillStyle = '#9aa3b2';
      ctx.font = '14px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('Loading…', width / 2, height / 2);
      return;
    }

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

    // Letter label
    ctx.fillStyle = '#9aa3b2';
    ctx.font = '12px system-ui';
    ctx.textAlign = 'right';
    ctx.fillText(LETTER_NAMES[this.letterIndex], width - 16, height - 16);
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
    window.removeEventListener('keydown', this.onKeyDown);
    this.canvas.remove();
    this.layers = [];
  }
}

runSketch(new FullMarkSketch(), document.getElementById('sketch')!);
