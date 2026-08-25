"use client";

import { useEffect, useState } from "react";
import { THEME_KEY, type Theme } from "@/lib/theme";

/**
 * Light/dark switch for the dashboard.
 *
 * The palette already had a full dark set behind `prefers-color-scheme`; this
 * only adds the ability to override it. Three states are preserved rather than
 * two: no stored choice means "follow the system", which is what a reader who
 * never touched this gets, and it keeps following the system if they change it
 * later. Clicking stamps an explicit choice that wins in both directions.
 *
 * Nothing here paints the icon — `globals.css` does, off the same `data-theme`
 * attribute. React only owns the click, the persistence, and the label.
 */
export function ThemeToggle() {
  /**
   * Null until mounted, because the honest answer on the server is "unknown":
   * the choice lives in localStorage and the fallback is a media query, neither
   * of which exists during SSR. Rendering a guess would either mismatch on
   * hydration or announce the wrong action to a screen reader.
   */
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    const explicit = root.dataset.theme as Theme | undefined;

    // The inline script in `layout.tsx` has already applied any stored choice
    // before first paint, so reading the attribute back is the cheapest source
    // of truth. Absent it, the system preference is what is on screen.
    setTheme(
      explicit ??
        (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    );
  }, []);

  /**
   * Follow the system for as long as the reader has not chosen — but only while
   * they have not chosen. Once `data-theme` is set, an OS change must not
   * silently override a deliberate decision.
   */
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");

    const onSystemChange = (event: MediaQueryListEvent) => {
      if (document.documentElement.dataset.theme) return;
      setTheme(event.matches ? "dark" : "light");
    };

    query.addEventListener("change", onSystemChange);
    return () => query.removeEventListener("change", onSystemChange);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";

    document.documentElement.dataset.theme = next;
    setTheme(next);

    // A private window or a browser with storage blocked must still toggle for
    // the current session; losing the preference is a far smaller failure than
    // an inert button.
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* preference is not persistable here; the theme still applied above */
    }
  }

  // Before mount the action is genuinely unknown, so the button announces its
  // purpose rather than a destination it cannot yet name.
  const label =
    theme === null
      ? "Switch colour theme"
      : theme === "dark"
        ? "Switch to light theme"
        : "Switch to dark theme";

  return (
    <button
      type="button"
      className="btn theme-toggle"
      onClick={toggle}
      aria-label={label}
      title={label}
    >
      {/* Both icons always render; CSS shows exactly one. See globals.css. */}
      <svg
        className="icon-moon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
      </svg>

      <svg
        className="icon-sun"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </svg>
    </button>
  );
}
