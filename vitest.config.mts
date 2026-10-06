import { defineConfig } from "vitest/config";


export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
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
