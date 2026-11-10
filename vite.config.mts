import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync(resolve("package.json"), "utf8")).version;

export default defineConfig({
  plugins: [react()],
  resolve: { alias: {
    "next/navigation": resolve("frontend/navigation.ts"),
    "next/link": resolve("frontend/link.tsx"),
    "next/image": resolve("frontend/image.tsx"),
    "next/dynamic": resolve("frontend/dynamic.tsx"),
    "@": resolve("."),
  } },
  define: {
    "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify(version),
    "process.env.NEXT_PUBLIC_DEBUG": JSON.stringify(process.env.NEXT_PUBLIC_DEBUG ?? "false"),
  },
  build: { outDir: "desktop/resources/frontend", emptyOutDir: true, copyPublicDir: false, sourcemap: false },
  server: { host: "127.0.0.1", port: 3000, strictPort: true, proxy: {
    "/api": "http://127.0.0.1:41731",
    "/generated": "http://127.0.0.1:41731",
  } },
});
