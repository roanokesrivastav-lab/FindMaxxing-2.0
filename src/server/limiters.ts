import "server-only";
import { AD_SERVE_LIMIT, PASSWORD_RESET_LIMIT, SIGN_UP_LIMIT, createMemoryLimiter } from "@/lib/rateLimits";

/**
 * Process-wide limiters for writes the database cannot attribute to a user.
 * Per instance: see createMemoryLimiter. Kept on globalThis so dev reloads do
 * not reset them.
 */
declare global {
  var __findmaxxingLimiters: { signUp: ReturnType<typeof createMemoryLimiter>; passwordReset: ReturnType<typeof createMemoryLimiter>; adServe?: ReturnType<typeof createMemoryLimiter> } | undefined;
}

export function limiters() {
  globalThis.__findmaxxingLimiters ??= {
    signUp: createMemoryLimiter(SIGN_UP_LIMIT),
    passwordReset: createMemoryLimiter(PASSWORD_RESET_LIMIT),
  };
  globalThis.__findmaxxingLimiters.adServe ??= createMemoryLimiter(AD_SERVE_LIMIT);
  return globalThis.__findmaxxingLimiters;
}
