import { defineConfig } from "vitest/config";


export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
      "server-only": new URL("./tests/helpers/server-only.ts", import.meta.url).pathname,
    },
  },
});
