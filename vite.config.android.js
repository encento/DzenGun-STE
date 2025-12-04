import { defineConfig } from "vite";

export default defineConfig({
  root: ".",      // ← обязателен
  base: "./",     // ← чтобы пути не ломались
  build: {
    outDir: "dist-android",
    emptyOutDir: true,
    assetsDir: "assets",
  }
});
