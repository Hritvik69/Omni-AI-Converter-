import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/features(.*)",
  "/pricing(.*)",
  "/api-docs(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)"
]);

function hasConfiguredClerk(): boolean {
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  return Boolean(secretKey && !secretKey.includes("replace_me"));
}

const protectedMiddleware = clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) await auth.protect();
});

export default function middleware(req: NextRequest, event: NextFetchEvent) {
  if (!hasConfiguredClerk()) return NextResponse.next();
  return protectedMiddleware(req, event);
}

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)"]
};
