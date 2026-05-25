import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { Shell } from "../components/Shell";

export const metadata: Metadata = {
  title: "OmniConvert AI",
  description: "AI-powered universal file conversion platform with real backend processing engines."
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
