import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    lib: { entry: 'index.js', formats: ['es'], fileName: () => 'qqj-app.js' },
    outDir: 'dist',
    emptyOutDir: true,
    codeSplitting: false,
    rollupOptions: { output: { comments: { legal: true } }, external: ['/scripts/personas.js', '/scripts/power-user.js', '/scripts/extensions.js', '/script.js', '/scripts/group-chats.js', '/scripts/world-info.js', '/lib.js', '/scripts/user.js'] },
  },
});
