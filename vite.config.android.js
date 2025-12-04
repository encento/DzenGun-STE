import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",                        // <-- ГЛАВНОЕ
  publicDir: "public",
  base: "./",
  build: {
    outDir: "dist-android",
    assetsDir: "assets",
    emptyOutDir: true,
  },
});
