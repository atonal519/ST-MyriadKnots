import { defineConfig } from 'vite';
export default defineConfig({ build: { lib: { entry: 'src/bootstrap.js', formats: ['es'], fileName: () => 'index.js' }, outDir: 'dist', emptyOutDir: true, codeSplitting: false } });
