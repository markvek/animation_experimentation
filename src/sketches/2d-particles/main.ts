import type { Sketch } from '../../core/sketch';
import { runSketch } from '../../core/runner';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  hue: number;
}

/**
 * First 2D sketch: a drifting particle field on a plain Canvas 2D
 * context, with lines connecting nearby particles. Proves the 2D pipeline —
 * no Three.js involved.
 */
class ParticleSketch implements Sketch {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private width = 0;
  private height = 0;

  private static readonly COUNT = 120;
  private static readonly LINK_DISTANCE = 120;

  init(container: HTMLElement): void {
    this.canvas = document.createElement('canvas');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  private spawnParticles(): void {
    this.particles = Array.from({ length: ParticleSketch.COUNT }, () => ({
      x: Math.random() * this.width,
      y: Math.random() * this.height,
      vx: (Math.random() - 0.5) * 40,
      vy: (Math.random() - 0.5) * 40,
      radius: 1.5 + Math.random() * 2.5,
      hue: 200 + Math.random() * 80,
    }));
  }

  update(dt: number, _elapsed: number): void {
    const { ctx, particles, width, height } = this;

    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, width, height);

    for (const p of particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.x < 0 || p.x > width) p.vx *= -1;
      if (p.y < 0 || p.y > height) p.vy *= -1;
      p.x = Math.max(0, Math.min(width, p.x));
      p.y = Math.max(0, Math.min(height, p.y));
    }

    // Lines between close particles, fading with distance
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const a = particles[i];
        const b = particles[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.hypot(dx, dy);
        if (dist < ParticleSketch.LINK_DISTANCE) {
          const alpha = 1 - dist / ParticleSketch.LINK_DISTANCE;
          ctx.strokeStyle = `hsla(220, 60%, 65%, ${alpha * 0.35})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    for (const p of particles) {
      ctx.fillStyle = `hsl(${p.hue}, 70%, 65%)`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
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
    // Wait for a real layout size before spawning, so particles cover the field
    if (this.particles.length === 0 && width > 0 && height > 0) this.spawnParticles();
  }

  dispose(): void {
    this.canvas.remove();
    this.particles = [];
  }
}

runSketch(new ParticleSketch(), document.getElementById('sketch')!);
