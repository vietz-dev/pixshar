import { createHonoEffectRuntime } from "@vietz-dev/hono-effect";
import { AppLive } from "./dependencies/runtime-deps.js";

/**
 * The one request-side Effect runtime. Handlers reach services through
 * `runService` and never call `Effect.runPromise` themselves; `dispose` joins
 * the SIGTERM drain in index.ts so scoped resources are released.
 */
export const { run, runService, dispose } = createHonoEffectRuntime(AppLive);
