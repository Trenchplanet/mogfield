import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = `http://localhost:${process.env.BACKLOT_PORT ?? 8787}`;

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    proxy: Object.fromEntries(["/api/", "/media/", "/luts/", "/examples/"].map((p) => [p, api])),
  },
});
