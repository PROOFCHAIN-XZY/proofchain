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

export default defineConfig({
  server: { port: 3002, host: true },
  preview: { port: 3002, host: true },
  plugins: useHttps ? [basicSsl()] : [],
  resolve: {
    alias: {
      // Import the PURE canonical encoder directly from source: the browser must
      // produce byte-identical payloads to the server, from one implementation.
      "@shared/canonical": resolve(__dirname, "../../packages/shared/src/canonical-core.ts"),
      "@shared/types": resolve(__dirname, "../../packages/shared/src/types.ts"),
      "@shared/geo": resolve(__dirname, "../../packages/shared/src/geo.ts"),
    },
  },
  build: { target: "es2022", sourcemap: true },
});
