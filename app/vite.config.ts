import { defineConfig } from 'vite';
import { rmSync, readdirSync } from 'node:fs';

const LOCAL_MODELS = new URL('./public/local/models', import.meta.url);

// Built into /docs/app so GitHub Pages serves it next to the tracker.
export default defineConfig({
  base: './',
  build: { outDir: '../docs/app', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  plugins: [
    {
      // public/local holds assets for this machine only (downloaded models and animations).
      // They are available in dev but must never reach the published build.
      name: 'local-assets',
      closeBundle() { rmSync(new URL('../docs/app/local', import.meta.url), { recursive: true, force: true }); },
      // In dev, list whatever .vrm files are in public/local/models so the app can offer them.
      configureServer(server) {
        server.middlewares.use('/local/models/index.json', (_req, res) => {
          let files: string[] = [];
          try { files = readdirSync(LOCAL_MODELS).filter((f) => f.toLowerCase().endsWith('.vrm')).sort(); } catch {}
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(files));
        });
      },
    },
  ],
});
