import { defineConfig } from 'vite';
export default defineConfig(({ mode }) => {
  const uiBuild = mode === 'ui';
  return {
    build: {
      lib: { entry: uiBuild ? 'src/bootstrap.js' : 'index.js', formats: ['es'], fileName: () => uiBuild ? 'index.js' : 'qqj-app.js' },
      outDir: 'dist',
      emptyOutDir: false,
      codeSplitting: false,
      rollupOptions: uiBuild ? {} : { external: ['/scripts/personas.js', '/scripts/extensions.js', '/script.js'] },
    },
  };
});
