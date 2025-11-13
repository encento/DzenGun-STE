import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",          // важное место — относительные пути
  build: {
    outDir: "docs",    // билд будет в /docs
  },
});
