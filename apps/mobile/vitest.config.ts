import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// The logic layer (queue, sync, payload construction) is deliberately free of
// React Native imports so it can be tested in plain Node, where failures are
// cheap to reproduce. Screens stay thin on purpose.
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
  resolve: {
    alias: {
      "@shared/canonical": resolve(__dirname, "../../packages/shared/src/canonical-core.ts"),
      "@shared/types": resolve(__dirname, "../../packages/shared/src/types.ts"),
      "@shared/materials": resolve(__dirname, "../../packages/shared/src/materials.ts"),
    },
  },
});
