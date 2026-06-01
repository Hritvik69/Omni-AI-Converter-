import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { Shell } from "../components/Shell";

export const metadata: Metadata = {
  applicationName: "OmniConvert AI",
  title: "OmniConvert AI",
  description: "AI-powered universal file conversion platform with real backend processing engines.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" }
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }]
  },
  appleWebApp: {
    capable: true,
    title: "OmniConvert AI",
    statusBarStyle: "black-translucent"
  }
};

function resolveClerkPublishableKey(): string {
  const key = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();
  if (!key || key.includes("replace_me")) return "pk_test_Y2xlcmsubG9jYWwuZGV2JA==";
  return key;
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const publishableKey = resolveClerkPublishableKey();

  return (
    <ClerkProvider publishableKey={publishableKey}>
      <html lang="en" className="dark">
        <body>
          <Shell>{children}</Shell>
        </body>
      </html>
    </ClerkProvider>
  );
}
