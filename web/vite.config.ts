import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The shared API contract lives beside the web app (../contract, review X2).
  server: { fs: { allow: [".", "../contract"] } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
