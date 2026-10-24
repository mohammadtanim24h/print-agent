import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { getCsp } from './src/shared/csp';
import type { Plugin } from 'vite';

/** Bakes the mode-appropriate CSP into the renderer's index.html meta tag. */
function cspMeta(): Plugin {
  return {
    name: 'print-agent:csp-meta',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        return html.replace('__CSP__', getCsp({ dev: ctx.server !== undefined }));
      },
    },
  };
}

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: 'src/main/main.ts' },
      rolldownOptions: { external: ['electron', 'electron-log', 'better-sqlite3'] },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      // The sandbox cannot require external packages — everything except
      // electron is bundled inline.
      externalizeDeps: false,
      // Sandboxed renderers require CJS preload scripts.
      rolldownOptions: {
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: 'out/renderer',
    },
    plugins: [react(), cspMeta()],
  },
});
