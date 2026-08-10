/**
 * Side-effect imports of stylesheets.
 *
 * TypeScript 6 stopped tolerating `import "./globals.css"` without a matching
 * declaration (TS2882). Next.js handles the import itself at build time — the
 * bundler strips it and emits a stylesheet — so nothing here needs a real type;
 * this only tells the compiler the module legitimately exists.
 *
 * `next-env.d.ts` is generated and carries a "should not be edited" notice, so
 * the declaration lives here instead of being appended to it.
 */

declare module "*.css";
