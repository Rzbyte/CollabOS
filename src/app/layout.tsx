import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "CollabOS — Creator Partnership Director",
  description:
    "A persistent Creator Partnership Director that remembers creator relationships, " +
    "brings approved partners into a trusted Mind Circle, and runs the joint campaign.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {/* Skip link — keyboard users should not have to tab the whole nav. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:text-accent-ink"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
