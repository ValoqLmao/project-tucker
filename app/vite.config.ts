import { defineConfig } from 'vite';

// Built into /docs/app so GitHub Pages serves it next to the tracker.
export default defineConfig({
  base: './',
  build: { outDir: '../docs/app', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
