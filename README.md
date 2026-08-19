# animation_experimentation

Fully-programmed 2D & 3D animation sketches — Three.js + Canvas 2D + TypeScript, bundled with Vite.

## Run

```bash
npm install
npm run dev
```

Open the printed localhost URL — the gallery page links to every sketch.

## Build

```bash
npm run build
```

Type-checks with `tsc`, then outputs a static site to `dist/` (deployable to GitHub Pages, Netlify, etc.).

## Structure

```
src/
├── core/            # Shared engine — you rarely touch this
│   ├── sketch.ts        # The Sketch interface every animation implements
│   ├── runner.ts        # rAF loop, delta time, resize observer, teardown
│   └── three-helpers.ts # Renderer/scene/camera boilerplate for 3D sketches
├── sketches/        # One folder per animation
│   ├── 3d-orbit/        # Three.js: torus knot + orbiting satellites
│   ├── 2d-particles/    # Canvas 2D: linked particle field
│   ├── lines/           # Canvas 2D: growing space dividers (click / space)
│   ├── mark-logo/       # Canvas 2D: handwritten "R" mark from layered PNGs (src/img)
│   ├── full-mark/       # Canvas 2D: all letters A–V with blast animation (arrow keys)
│   └── signature/       # Three.js: "Mark Veksler" stroke layers in 3D, click to blast
└── styles/base.css  # Fullscreen canvas reset + gallery styling
```

## Adding a sketch

1. Copy an existing sketch folder in `src/sketches/` (pick `3d-orbit` for Three.js, `2d-particles` for Canvas 2D).
2. Implement the `Sketch` interface in `main.ts` — `init`, `update(dt, elapsed)`, `resize`, `dispose`. The runner handles the animation loop and resizing for you.
3. Add the sketch's `index.html` to `rollupOptions.input` in `vite.config.ts`.
4. Add a card linking to it in the root `index.html` gallery.
