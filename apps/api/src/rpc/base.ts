import { implement } from "@orpc/server";
import { contract, type Contract } from "@pixshar/contracts";
import type { RpcContext } from "./context.js";

/**
 * Root implementer. Access-level variants (adminOs, galleryOs, …) are built
 * from this with `.use(...)` and live in `./middleware.ts`.
 */
export const base = implement<Contract, RpcContext>(contract);
