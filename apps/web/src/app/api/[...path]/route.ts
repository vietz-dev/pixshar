import { NextRequest } from "next/server";

// Streaming reverse proxy for /api/* → the API service. Replaces the old
// middleware `NextResponse.rewrite()`, which terminated long-lived streaming
// responses (SSE) after the first flush, causing EventSource reconnect loops.
//
// Runs on the Node runtime and returns the upstream ReadableStream body
// directly, so Server-Sent Events stream through untouched. API_URL is read per
// request, preserving runtime (container env) overrides.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function apiBase(): string {
  return process.env.API_URL || "http://pixshar-api:3001";
}

async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  const { path } = await ctx.params;
  const target = `${apiBase()}/api/${path.join("/")}${req.nextUrl.search}`;

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("connection");
  // Avoid any compression that would buffer/garble the SSE stream.
  headers.delete("accept-encoding");

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    redirect: "manual",
    // Propagate client disconnects (tab refresh/close) to the upstream fetch so
    // the API-side SSE connection is aborted promptly — this fires the API's
    // stream.onAbort cleanup (no event-bus listener leak) and prevents
    // "failed to pipe response" ECONNRESET rejections from a half-open pipe.
    signal: req.signal,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    // Client went away before/while connecting — expected, not an error.
    if (req.signal.aborted || (e as Error)?.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    throw e;
  }

  const respHeaders = new Headers(upstream.headers);
  // Body is re-streamed as-is; drop framing headers that no longer apply.
  respHeaders.delete("content-encoding");
  respHeaders.delete("content-length");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
