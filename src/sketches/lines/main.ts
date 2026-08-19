import type { Sketch } from '../../core/sketch';
import { runSketch } from '../../core/runner';

type Orientation = 'horizontal' | 'vertical';

interface Dot {
  x: number;
  y: number;
  hue: number;
}

/**
 * A line growing out of a dot in both directions along one axis.
 * `pos` is the fixed cross-axis coordinate (y for horizontal, x for vertical);
 * `min`/`max` are the two tips moving along the growth axis.
 */
interface Line {
  orientation: Orientation;
  pos: number;
  min: number;
  max: number;
  minActive: boolean;
  maxActive: boolean;
  hue: number;
}

/**
 * Space-division sketch: each dot sends out a line that grows in both
 * directions — even-numbered dots (0, 2, ...) horizontal, odd vertical.
 * A tip stops when it reaches a perpendicular line or the canvas edge.
 * Click to place a dot; spacebar drops one at a random position.
 */
class LinesSketch implements Sketch {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dots: Dot[] = [];
  private lines: Line[] = [];
  private dotCount = 0;

  private static readonly SPEED = 300; // px per second per tip

  private onClick = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.addDot(e.clientX - rect.left, e.clientY - rect.top);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      this.addDot(Math.random() * this.width, Math.random() * this.height);
    }
  };

  init(container: HTMLElement): void {
    this.canvas = document.createElement('canvas');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('click', this.onClick);
    window.addEventListener('keydown', this.onKeyDown);
  }

  private addDot(x: number, y: number): void {
    const orientation: Orientation = this.dotCount % 2 === 0 ? 'horizontal' : 'vertical';
    const hue = (200 + this.dotCount * 47) % 360;
    this.dotCount++;

    this.dots.push({ x, y, hue });
    const origin = orientation === 'horizontal' ? x : y;
    this.lines.push({
      orientation,
      pos: orientation === 'horizontal' ? y : x,
      min: origin,
      max: origin,
      minActive: true,
      maxActive: true,
      hue,
    });
  }

  /**
   * Move one tip from `from` toward `to` (dir = growth direction), stopping at
   * the nearest perpendicular line whose span covers this line's cross-axis
   * position, or at the canvas edge.
   */
  private advanceTip(line: Line, from: number, to: number, dir: 1 | -1): { tip: number; hit: boolean } {
    const edge = dir === 1 ? (line.orientation === 'horizontal' ? this.width : this.height) : 0;
    let tip = dir === 1 ? Math.min(to, edge) : Math.max(to, edge);
    let hit = tip === edge;

    for (const other of this.lines) {
      if (other === line || other.orientation === line.orientation) continue;
      const c = other.pos; // where the perpendicular line sits along our growth axis
      const inPath = dir === 1 ? c > from && c <= tip : c < from && c >= tip;
      if (inPath && line.pos >= other.min && line.pos <= other.max) {
        tip = c;
        hit = true;
      }
    }
    return { tip, hit };
  }

  update(dt: number, _elapsed: number): void {
    const step = LinesSketch.SPEED * dt;

    for (const line of this.lines) {
      if (line.maxActive) {
        const { tip, hit } = this.advanceTip(line, line.max, line.max + step, 1);
        line.max = tip;
        if (hit) line.maxActive = false;
      }
      if (line.minActive) {
        const { tip, hit } = this.advanceTip(line, line.min, line.min - step, -1);
        line.min = tip;
        if (hit) line.minActive = false;
      }
    }

    const { ctx } = this;
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.lineWidth = 2;
    for (const line of this.lines) {
      ctx.strokeStyle = `hsl(${line.hue}, 65%, 60%)`;
      ctx.beginPath();
      if (line.orientation === 'horizontal') {
        ctx.moveTo(line.min, line.pos);
        ctx.lineTo(line.max, line.pos);
      } else {
        ctx.moveTo(line.pos, line.min);
        ctx.lineTo(line.pos, line.max);
      }
      ctx.stroke();
    }

    for (const dot of this.dots) {
      ctx.fillStyle = `hsl(${dot.hue}, 75%, 72%)`;
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, 4, 0, Math.PI * 2);
      ctx.fill();
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
    // Wait for a real layout size before seeding the first dot
    if (this.dotCount === 0 && width > 0 && height > 0) {
      this.addDot(Math.random() * width, Math.random() * height);
    }
  }

  dispose(): void {
    this.canvas.removeEventListener('click', this.onClick);
    window.removeEventListener('keydown', this.onKeyDown);
    this.canvas.remove();
    this.dots = [];
    this.lines = [];
  }
}

runSketch(new LinesSketch(), document.getElementById('sketch')!);
