import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    globals: false,
  },
  // NestJS relies on decorator metadata, which esbuild does not emit.
  plugins: [swc.vite({ module: { type: "es6" } })],
});
