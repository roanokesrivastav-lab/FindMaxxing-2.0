import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The Expo app has its own toolchain (type-checked in CI); these rules are the web's.
    "apps/**",
    // Vendored MapLibre worker copied from node_modules on install.
    "public/maplibre/**",
    ".data/**",
    // Agent worktrees are full copies of the repo; lint the real source only.
    ".claude/**",
  ]),
]);

export default eslintConfig;
