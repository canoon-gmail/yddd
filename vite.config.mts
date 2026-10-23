import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    target: "esnext",
    chunkSizeWarningLimit: 4000,
  },
  // The background kernel (kernel.worker.ts) is a module worker: it imports the OpenCascade build.
  worker: { format: "es" },
  // The Emscripten OpenCascade build must not be pre-bundled by esbuild.
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  server: { port: 5733, strictPort: true },
});
