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
      "@shared/materials": resolve(__dirname, "../../packages/shared/src/materials.ts"),
      // The one wording of a failed integrity check that a collector ever sees,
      // shared so the two capture apps cannot drift apart on it.
      "@shared/integrity-copy": resolve(__dirname, "../../packages/shared/src/integrity-copy.ts"),
    },
  },
});
