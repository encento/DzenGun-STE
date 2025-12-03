import { defineConfig } from "vite";

export default defineConfig({
  base: "./", // ← КЛЮЧЕВОЕ. Запрещает Vite ломать пути
  build: {
    outDir: "dist-android",      // ← стабильно, не конфликтует
    assetsDir: "assets",         // ← картинки, css, js будут тут
    emptyOutDir: true,
  },
});
