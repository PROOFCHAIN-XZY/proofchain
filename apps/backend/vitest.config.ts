import swc from "unplugin-swc";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // Integration tests need a running Postgres, so they are not part of the
    // default run — `npm test` stays runnable on a clone with no infrastructure.
    // They are run explicitly by `npm run test:integration`, which CI invokes as
    // its own step so a missing database fails the build instead of quietly
    // skipping the suite.
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
    globals: false,
  },
  // NestJS relies on decorator metadata, which esbuild does not emit.
  plugins: [swc.vite({ module: { type: "es6" } })],
});
