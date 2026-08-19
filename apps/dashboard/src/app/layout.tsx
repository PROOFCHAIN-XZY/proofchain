import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "ProofChain — verified waste-to-credit",
  description:
    "Operator and auditor views over verified weigh-ins, sealed batches and Stellar-anchored proofs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar no-print">
          <div className="topbar-inner">
            <Link className="brand" href="/">
              ProofChain <em>ledger</em>
            </Link>
            <nav className="links">
              <Link href="/">Batches</Link>
              <Link href="/events">Weigh-ins</Link>
              <Link href="/materials">Materials</Link>
              <Link href="/login">Sign in</Link>
            </nav>
          </div>
        </header>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
