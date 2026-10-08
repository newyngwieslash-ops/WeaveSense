/**
 * Assistant access gate (plan Task 4 / §7.2).
 *
 * Reuses the existing localModelAccess boundary — trusted local single
 * operator — instead of inventing an auth framework. The only reason this
 * wrapper exists is that assistant routes receive a Request (route handlers)
 * while server functions hand over (request, ip) pairs; the decision table is
 * identical to `localModelAccess` in model-config.ts.
 */

export type AccessEnv = Record<string, string | undefined>;

export type AssistantAccess = { allowed: true } | { allowed: false; error_code: "trusted_access_required" };

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const LOCAL_PEERS = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

/**
 * Same decision table as model-config.localModelAccess:
 *  - off on Vercel or without a model config file,
 *  - loopback peers only (or the explicit deployment opt-out where the port
 *    binding is the trust boundary and peer IP is unavailable),
 *  - loopback Host headers only,
 *  - GET passes; non-GET requires a same-origin header.
 */
export function assistantAccessFromRequest(request: Request, peer: string | undefined, env: AccessEnv): AssistantAccess {
  const host = new URL(request.url);
  if (env.VERCEL || !env.LOOM_MODEL_CONFIG) return { allowed: false, error_code: "trusted_access_required" };
  const allowedPeer = LOCAL_PEERS.includes(peer ?? "") ||
    (peer === undefined && env.LOOM_MODEL_LOOPBACK_ONLY === "true") ||
    env.LOOM_MODEL_MANAGE_ALLOWED === "true";
  if (!allowedPeer || !LOCAL_HOSTS.includes(host.hostname)) {
    return { allowed: false, error_code: "trusted_access_required" };
  }
  const sameOrigin = request.method === "GET" || request.headers.get("origin") === host.origin;
  if (!sameOrigin) return { allowed: false, error_code: "trusted_access_required" };
  return { allowed: true };
}

/** Live variant for route handlers: reads the request peer like fns.ts does. */
export async function assistantAccess(request: Request, peer: string | undefined): Promise<AssistantAccess> {
  const [{ getRequestIP }, { localModelAccess }] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("./model-config"),
  ]);
  // Preferred path: the exact production helper, applied to this request.
  if (localModelAccess(request, peer ?? getRequestIP({ xForwardedFor: false }))) {
    return { allowed: true };
  }
  return { allowed: false, error_code: "trusted_access_required" };
}
