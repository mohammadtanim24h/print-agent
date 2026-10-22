import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: 'src/main/main.ts' },
      rollupOptions: { external: ['electron', 'electron-log'] },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      // Sandboxed renderers require CJS preload scripts.
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: 'src/renderer/index.html' },
    },
    plugins: [react()],
  },
});
