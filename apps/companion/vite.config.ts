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
        neverBundle: ["electron", "uiohook-napi"],
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
