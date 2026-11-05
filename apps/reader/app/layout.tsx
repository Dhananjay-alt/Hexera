import type { Metadata } from "next";
// Self-hosted substitutes for DESIGN.md's Faire Octave (display) and Suisse Intl (body).
import "@fontsource/cormorant-garamond/300.css";
import "@fontsource-variable/inter";
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
