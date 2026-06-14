import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    const apiUrl = process.env.API_URL || "http://pixshar-api:3001";
    const path = request.nextUrl.pathname;
    const search = request.nextUrl.search;
    const targetUrl = new URL(`${path}${search}`, apiUrl);
    return NextResponse.rewrite(targetUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
