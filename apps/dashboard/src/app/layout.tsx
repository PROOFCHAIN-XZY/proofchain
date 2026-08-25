import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "./ThemeToggle";
import { THEME_KEY } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "ProofChain — verified waste-to-credit",
  description:
    "Operator and auditor views over verified weigh-ins, sealed batches and Stellar-anchored proofs.",
};

/**
 * Applies a stored theme choice before the first paint.
 *
 * This has to be a blocking inline script in the head, not an effect: an effect
 * runs after React hydrates, by which point the browser has already painted the
 * page in the system theme. A reader who chose light on a dark machine would
 * see a dark flash on every navigation — worse on the audit report, which is
 * the page most likely to be read by someone we are trying to convince.
 *
 * Wrapped in try/catch because `localStorage` throws outright in some privacy
 * modes, and an exception here would abort the parser before the page renders.
 */
const applyStoredTheme = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the script above sets `data-theme` on this
    // element before React hydrates, so the server markup and the live DOM are
    // expected to differ here. It is scoped to this element only.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: applyStoredTheme }} />
      </head>
      <body>
        <header className="topbar no-print">
          <div className="topbar-inner">
            <Link className="brand" href="/">
              ProofChain <em>ledger</em>
            </Link>
            <div className="topbar-actions">
              <nav className="links">
                <Link href="/">Batches</Link>
                <Link href="/events">Weigh-ins</Link>
                <Link href="/materials">Materials</Link>
                <Link href="/login">Sign in</Link>
              </nav>
              <ThemeToggle />
            </div>
          </div>
        </header>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
