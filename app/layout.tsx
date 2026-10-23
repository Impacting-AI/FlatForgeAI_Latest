import type { Metadata } from "next";
import { Suspense } from "react";
import FlatForge from "@/components/flatforge/FlatForge";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlatForge — Panel Studio",
  description: "Reconstruct, review and inspect folded sheet-metal panels from fabrication drawings.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <Suspense fallback={<div className="app-loading">Opening FlatForge…</div>}>
          <FlatForge />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
