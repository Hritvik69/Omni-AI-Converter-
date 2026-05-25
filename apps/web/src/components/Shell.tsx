"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import { Activity, FileCog, LayoutDashboard, Sparkles } from "lucide-react";
import clsx from "clsx";

const links = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/ai-tools", label: "AI Tools", icon: Sparkles },
  { href: "/history", label: "History", icon: Activity },
  { href: "/features", label: "Features", icon: FileCog }
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-50 border-b border-white/10 bg-[#05070d]/82 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white text-ink shadow-glow">
              <FileCog size={21} />
            </div>
            <div>
              <div className="text-sm font-black tracking-[0.18em] text-white">OMNICONVERT AI</div>
              <div className="text-[10px] font-bold uppercase tracking-[0.28em] text-neon-cyan">Universal Engine</div>
            </div>
          </Link>

          <nav className="hidden items-center gap-1 rounded-full border border-white/10 bg-white/[0.045] p-1 lg:flex">
            {links.map((link) => {
              const Icon = link.icon;
              const active = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={clsx(
                    "flex items-center gap-2 rounded-full px-3 py-2 text-xs font-bold transition",
                    active ? "bg-white text-ink shadow-glow" : "text-slate-300 hover:bg-white/10 hover:text-white"
                  )}
                >
                  <Icon size={14} />
                  {link.label}
                </Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-3">
            <SignedOut>
              <SignInButton
                mode="modal"
                fallbackRedirectUrl="/dashboard"
                forceRedirectUrl="/dashboard"
                signUpFallbackRedirectUrl="/dashboard"
                signUpForceRedirectUrl="/dashboard"
              >
                <button className="focus-ring rounded-full border border-line px-4 py-2 text-xs font-bold text-slate-200 transition hover:border-neon-cyan hover:text-white">
                  Login
                </button>
              </SignInButton>
              <Link
                href="/sign-up"
                className="focus-ring rounded-full bg-neon-cyan px-4 py-2 text-xs font-black text-ink shadow-glow transition hover:bg-white"
              >
                Register
              </Link>
            </SignedOut>
            <SignedIn>
              <UserButton afterSignOutUrl="/" />
            </SignedIn>
          </div>
        </div>
      </header>

      <main>{children}</main>
    </div>
  );
}
