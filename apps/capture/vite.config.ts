import { defineConfig } from "vite";
import { resolve } from "node:path";
import basicSsl from "@vitejs/plugin-basic-ssl";

/**
 * HTTPS is opt-in via `HTTPS=1`.
 *
 * Geolocation, the camera and service workers are all gated behind a *secure
 * context*: HTTPS, or localhost. Testing this app the way it is actually used —
 * on a phone, over the office wifi, at `http://192.168.x.x:3002` — is therefore
 * an insecure origin, where the browser reports GPS as "permission denied" no
 * matter what the phone's settings say.
 *
 * Turning it on serves a self-signed certificate, so the phone shows a warning
 * once. That is the trade for a real secure context on a real device.
 *
 * It stays off by default because plain http://localhost is already secure, and
 * the headless test suite talks to it over http.
 */
const useHttps = process.env.HTTPS === "1";

/**
 * Same-origin path to the backend, so a phone never mixes schemes.
 *
 * Serving the app over HTTPS creates a second problem behind the first: a secure
 * page may not `fetch()` a plain-http endpoint, so pointing the app's Backend URL
 * at `http://192.168.x.x:3000` — the obvious move, and what the runbook used to
 * say — is blocked as mixed content. The GPS works and every request fails.
 *
 * Proxying here means the phone talks to exactly one origin, over TLS, and Vite
 * forwards to the backend server-side where scheme mixing is nobody's business.
 * Set the app's Backend URL to `https://<this-host>:<port>/api`.
 *
 * Development only: `vite dev`/`preview` serve this, production does not.
 */
const backendTarget = process.env.BACKEND_URL ?? "http://localhost:3000";

const apiProxy = {
  "/api": {
    target: backendTarget,
    changeOrigin: true,
    // The backend owns its routes at the root (`/events`, `/auth/login`), so the
    // `/api` marker is ours alone and must come off before forwarding.
    rewrite: (path: string) => path.replace(/^\/api/, ""),
  },
};

export default defineConfig({
  server: { port: 3002, host: true, proxy: apiProxy },
  preview: { port: 3002, host: true, proxy: apiProxy },
  plugins: useHttps ? [basicSsl()] : [],
  resolve: {
    alias: {
      // Import the PURE canonical encoder directly from source: the browser must
      // produce byte-identical payloads to the server, from one implementation.
      "@shared/canonical": resolve(__dirname, "../../packages/shared/src/canonical-core.ts"),
      "@shared/types": resolve(__dirname, "../../packages/shared/src/types.ts"),
      "@shared/geo": resolve(__dirname, "../../packages/shared/src/geo.ts"),
      // Source, not dist, for the same reason as the others: one implementation
      // of the code shape and label rules across device and server.
      "@shared/materials": resolve(__dirname, "../../packages/shared/src/materials.ts"),
    },
  },
  build: { target: "es2022", sourcemap: true },
});
