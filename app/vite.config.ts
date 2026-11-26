import { defineConfig } from 'vite';
import { rmSync } from 'node:fs';

// Built into /docs/app so GitHub Pages serves it next to the tracker.
export default defineConfig({
  base: './',
  build: { outDir: '../docs/app', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  plugins: [
    {
      // public/local holds assets for this machine only (downloaded models and animations).
      // They are available in dev but must never reach the published build.
      name: 'drop-local-assets',
      closeBundle() { rmSync(new URL('../docs/app/local', import.meta.url), { recursive: true, force: true }); },
    },
  ],
});
