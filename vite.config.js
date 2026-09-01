import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    lib: { entry: 'index.js', formats: ['es'], fileName: () => 'qqj-app.js' },
    outDir: 'dist',
    emptyOutDir: true,
    codeSplitting: false,
    rollupOptions: { external: ['/scripts/personas.js', '/scripts/extensions.js', '/script.js'] },
  },
});
