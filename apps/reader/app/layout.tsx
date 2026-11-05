import type { Metadata } from "next";
// Self-hosted: Inter (DESIGN.md's primary face) and JetBrains Mono (its substitute for Berkeley Mono).
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hexera Reader — private x402 on Hedera",
  description: "Pay per article without publishing your reading history.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
