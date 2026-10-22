import { defineConfig } from 'vite';

/**
 * Vite config.
 *
 * `base` is overridable because GitHub Pages serves the demo from
 * `/<repo>/`, and absolute `/src/...` references would 404 there. Locally the
 * default `/` keeps the dev server simple.
 */
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  server: {
    port: 5180,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  // three is large; pre-bundling it keeps the dev server responsive.
  optimizeDeps: {
    include: ['three'],
  },
});
