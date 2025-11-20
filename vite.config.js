import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // было: base: "/DzenGun-STE/",
  base: "./",           // <-- так будет работать и на GitHub Pages, и из файла
  plugins: [react()],
});
