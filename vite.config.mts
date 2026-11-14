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
    // (the app, and the hidden window the background kernel runs in — its own process: see src/main/kernelHost.ts)
    rollupOptions: { input: { index: resolve(__dirname, "src/renderer/index.html"), "kernel-host": resolve(__dirname, "src/renderer/kernel-host.html") } },
  },
  // The background kernel (kernel.worker.ts) is a module worker: it imports the OpenCascade build.
  worker: { format: "es" },
  // The Emscripten OpenCascade build must not be pre-bundled by esbuild.
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  // (cross-origin isolated, as the app:// protocol serves it: SharedArrayBuffer for OpenCascade's threads)
  server: { port: 5733, strictPort: true, headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } },
});
