interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const store = new Map<string, RateLimitEntry>();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now > entry.resetTime) {
      store.delete(key);
    }
  }
}, 5 * 60 * 1000);

export function checkRateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now > entry.resetTime) {
    store.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }

  if (entry.count >= maxRequests) {
    return false;
  }

  entry.count++;
  return true;
}

export function getRateLimitKey(
  c: { req: { header: (name: string) => string | undefined } },
  prefix: string
): string {
  // X-Forwarded-For can be forged by clients. Only trust it if the app is behind a trusted proxy.
  // For direct deployments, use the last IP in the chain (closest to server) or fall back to "unknown".
  const forwarded = c.req.header("x-forwarded-for");
  let ip: string;
  if (forwarded) {
    // Take the LAST IP in the chain (closest to the server), which is harder to forge
    const ips = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    ip = ips[ips.length - 1] ?? "unknown";
  } else {
    ip = c.req.header("x-real-ip") || "unknown";
  }
  return `${prefix}:${ip}`;
}
