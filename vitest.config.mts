import { defineConfig } from "vitest/config";


export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Each database suite builds a fresh embedded Postgres with every
    // migration; under parallel load that can take well over 10 seconds.
    hookTimeout: 120_000,
    // Each worker holds several WebAssembly Postgres instances; too many at
    // once exhausts memory and everything slows to a crawl.
    maxWorkers: 4,
    testTimeout: 60_000,
    // Tests must never write the developer's demo store (.data/demo-store.json).
    env: { FINDMAXXING_DEMO_NO_PERSIST: "1" },
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
      "server-only": new URL("./tests/helpers/server-only.ts", import.meta.url).pathname,
    },
  },
});
