import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

import { enabledSkins } from "./src/skins/skin";

export default defineConfig(({ mode }) => {
  // Checked here too, so a bad VITE_ENABLED_SKINS fails the build rather than the page.
  const skins = enabledSkins(loadEnv(mode, process.cwd(), "VITE_").VITE_ENABLED_SKINS);
  return {
    plugins: [
      react(),
      // index.html stamps the remembered face before the app loads; it may stamp only a face that is on.
      { name: "enabled-skins", transformIndexHtml: (html: string) => html.replace("__ENABLED_SKINS__", JSON.stringify(skins)) },
    ],
    // The shared API contract lives beside the web app (../contract, review X2).
    server: { fs: { allow: [".", "../contract"] } },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
