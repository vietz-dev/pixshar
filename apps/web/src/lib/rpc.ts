import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { Contract } from "@pixshar/contracts";

/**
 * Browser RPC client. Same-origin `/api/rpc` so the existing Next catch-all
 * proxy (src/app/api/[...path]/route.ts) carries the traffic and its cookies
 * unchanged. The URL is resolved lazily — this module is imported by client
 * components that Next also renders on the server, where `window` is absent.
 */
const link = new RPCLink({
  url: () => `${globalThis.location?.origin ?? ""}/api/rpc`,
  fetch: (url, init) => fetch(url, { ...init, credentials: "include" }),
});

export const api: ContractRouterClient<Contract> = createORPCClient(link);
