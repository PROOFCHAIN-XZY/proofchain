import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

/**
 * Service-level tests against a real Postgres. See test/integration/database.ts
 * for why these do not run against a mock.
 *
 * Requires a database: `npm run db:up` from the repo root, or TEST_DATABASE_URL
 * pointing at your own instance.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.integration.test.ts"],
    globals: false,
    // One database, shared. Files running in parallel would truncate each
    // other's rows mid-test.
    fileParallelism: false,
    // First run pays for creating the database and applying every migration.
    hookTimeout: 60_000,
    testTimeout: 20_000,
  },
  plugins: [swc.vite({ module: { type: "es6" } })],
});
