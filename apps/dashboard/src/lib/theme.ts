/**
 * Where the reader's theme choice is stored.
 *
 * This lives in its own module rather than alongside the toggle because the
 * root layout — a server component — needs it to build the pre-paint script,
 * and a `"use client"` module's exports arrive on the server as client
 * references, not values. Importing it from there yields `undefined` and the
 * script silently reads the wrong key, which is a bug that looks exactly like
 * "persistence doesn't work".
 */
export const THEME_KEY = "proofchain.dashboard.theme";

export type Theme = "light" | "dark";
