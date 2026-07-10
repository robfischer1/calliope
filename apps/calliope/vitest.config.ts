import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
    // The real-postgres suites tear down a testcontainer in afterAll
    // (pool.end + `docker stop`, up to ~10s SIGTERM grace). Under CI docker
    // contention that exceeds vitest's default 10s hook timeout and flakes the
    // suite. Give teardown headroom so the gate is load-independent.
    hookTimeout: 30000,
  },
});
