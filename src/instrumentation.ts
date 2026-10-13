import type { Instrumentation } from "next";

/** Runs once when a server instance starts. */
export async function register() {
  const { demoModeRefusal } = await import("@/lib/config");
  const refusal = demoModeRefusal();
  if (refusal) {
    console.error(`\n[findmaxxing] ${refusal}\n`);
    throw new Error(refusal);
  }
}

/**
 * Next calls this for every uncaught error in a route, page render, server
 * action or proxy, on the server. Expected failures are already turned into
 * ActionResults; anything that reaches here is a bug or an outage.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const { reportError } = await import("@/lib/observability");
  reportError(err, {
    where: "request",
    method: request.method,
    path: request.path.split("?")[0],
    routerKind: context.routerKind,
    routePath: context.routePath,
    routeType: context.routeType,
  });
};
