import { Layer } from "effect";
import { DownloadService, DownloadServiceLive } from "../services/download/service.js";

/** Everything the request-side runtime can provide. */
export type RuntimeDeps = DownloadService;

/**
 * The single fully-closed layer behind the request runtime (`RIn` is `never`,
 * which is what `createHonoEffectRuntime` requires). New services join here.
 */
export const AppLive: Layer.Layer<RuntimeDeps> = Layer.mergeAll(DownloadServiceLive);
