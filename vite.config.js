import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    lib: { entry: 'index.js', formats: ['es'], fileName: () => 'qqj-app.js' },
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: { output: { comments: { legal: true }, chunkFileNames: '[name]-[hash].js', codeSplitting: { groups: [{ name: 'qianchuang-static', test: /\/src\/(?:qianchuang-map-assets|ui\/qianchuang-(?:map-regions|basemaps|lucide-data|generic-trio))\.js$/ }] } }, external: ['/scripts/personas.js', '/scripts/power-user.js', '/scripts/extensions.js', '/script.js', '/scripts/group-chats.js', '/scripts/world-info.js', '/lib.js', '/scripts/user.js', '/scripts/utils.js'] },
  },
});
