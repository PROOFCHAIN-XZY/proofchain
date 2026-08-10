import { defineConfig } from "vite";
import { resolve } from "node:path";

// The capture app has no test harness of its own; this exists so the pure
// decision logic that gates what enters the evidentiary record can be exercised
// in Node, away from the DOM.
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
  resolve: {
    alias: {
      "@shared/canonical": resolve(__dirname, "../../packages/shared/src/canonical-core.ts"),
      "@shared/types": resolve(__dirname, "../../packages/shared/src/types.ts"),
      "@shared/geo": resolve(__dirname, "../../packages/shared/src/geo.ts"),
    },
  },
});
