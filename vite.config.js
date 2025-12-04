import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",         // корень проекта — здесь index.html
  publicDir: "public",
  base: "./",
  build: {
    outDir: "dist",      // обычный build
    assetsDir: "assets",
    emptyOutDir: true,
  },
});
