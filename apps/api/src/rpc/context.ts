/**
 * Per-request context handed to oRPC by the Hono mount.
 *
 * Deliberately cheap: it carries the raw headers and nothing else. Identity is
 * asserted per access level by oRPC middleware, not here, so a public procedure
 * costs no session lookup.
 */
export type RpcContext = {
  headers: Headers;
};

export type ContextResolver = (request: Request) => Promise<RpcContext>;

export const defaultResolveContext: ContextResolver = async (request) => ({
  headers: request.headers,
});
