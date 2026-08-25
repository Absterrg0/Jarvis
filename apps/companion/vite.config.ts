import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: [
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/main.ts"],
      clean: true,
      deps: {
        alwaysBundle: (id) => id === "@t3tools/jarvis-native-voice",
        neverBundle: ["electron", "node-cpal", "sherpa-onnx-node", "uiohook-napi"],
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["../../packages/jarvis-native-voice/src/kokoro-worker.ts"],
      deps: {
        neverBundle: ["sherpa-onnx-node"],
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preload.ts"],
      deps: {
        neverBundle: ["electron"],
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/relay-preload.ts"],
      deps: {
        neverBundle: ["electron"],
      },
    },
  ],
});
