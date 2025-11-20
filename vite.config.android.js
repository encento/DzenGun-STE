// vite.config.android.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',              // ВАЖНО: относительные пути, а не /DzenGun-STE/
  build: {
    outDir: 'dist-android' // отдельная папка для андроид-сборки
  }
});
