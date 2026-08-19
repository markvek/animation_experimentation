import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5173,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        '3d-orbit': resolve(root, 'src/sketches/3d-orbit/index.html'),
        '2d-particles': resolve(root, 'src/sketches/2d-particles/index.html'),
        lines: resolve(root, 'src/sketches/lines/index.html'),
        'mark-logo': resolve(root, 'src/sketches/mark-logo/index.html'),
        'full-mark': resolve(root, 'src/sketches/full-mark/index.html'),
        signature: resolve(root, 'src/sketches/signature/index.html'),
      },
    },
  },
});
