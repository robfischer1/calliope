import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
    // THE OFFLINE GUARD, WIRED HERE SO IT IS INHERITED RATHER THAN REMEMBERED.
    // Every suite in this package reaches nothing but loopback. See
    // __tests__/setup/offline.ts for what it guards and what it does not
    // (infra#9758). It lives under __tests__/ but is not a *.test.ts, so
    // `include` above does not pick it up as a suite.
    setupFiles: ["./__tests__/setup/offline.ts"],
    // The real-postgres suites tear down a testcontainer in afterAll
    // (pool.end + `docker stop`, up to ~10s SIGTERM grace). Under CI docker
    // contention that exceeds vitest's default 10s hook timeout and flakes the
    // suite. Give teardown headroom so the gate is load-independent.
    hookTimeout: 30000,
  },
});
