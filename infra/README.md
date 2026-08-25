# Serving ProofChain so the camera and offline queue work

Everything in this directory exists because of one browser rule: **the camera and
service workers require a secure context** — HTTPS, or `localhost`. A phone
opening the capture app at `http://192.168.1.20:3002` is an insecure origin, so
the camera is refused and the service worker never registers, which takes the
offline queue with it. Nothing in the application code can lift that.

There are three ways to serve this, for three different situations. Pick by what
you are actually doing.

---

## 1. Developing on this machine

```bash
npm run dev:capture          # http://localhost:3002
```

`localhost` is already a secure context, so the camera and service worker work
with no certificates at all. This is why HTTPS is opt-in rather than the default.

---

## 2. Testing on a real phone over wifi

This is the case that looks broken and isn't.

```bash
npm run dev:capture:https    # https://<your-lan-ip>:3002
```

Then **in the app, set Backend URL to `https://<your-lan-ip>:3002/api`** — not
`http://<your-lan-ip>:3000`.

That second step is the one everybody misses. Serving the page over HTTPS creates
a new problem behind the first: a secure page may not `fetch()` a plain-HTTP
endpoint, so pointing at the backend directly is blocked as mixed content. The
camera starts working and every request fails instead. `apps/capture/vite.config.ts`
runs a dev proxy at `/api` so the phone talks to exactly one origin over TLS and
Vite forwards to the backend server-side, where scheme mixing is nobody's
business.

The certificate is self-signed, so the phone shows a warning once. Accept it.

**Known limits of this mode:** `vite dev` and `vite preview` serve that proxy;
`vite build` does not. And a click-through certificate warning on every
collector's phone is acceptable for a test, not for a rollout — for that, see
below.

---

## 3. Production

```bash
# Build the capture PWA — Caddy serves it from disk.
npm run build -w @proofchain/capture

# Bring up the whole stack.
docker compose -f infra/docker-compose.yml \
               -f infra/docker-compose.prod.yml up -d
```

Required environment (the compose file refuses to start without them, rather
than defaulting to a placeholder and requesting a certificate for someone else's
domain):

| Variable | Example | Why |
|---|---|---|
| `CAPTURE_HOST` | `collect.proofchain.example` | Hostname Caddy gets a certificate for |
| `DASHBOARD_HOST` | `dashboard.proofchain.example` | Same, for operators |
| `ACME_EMAIL` | `ops@proofchain.example` | Certificate expiry notices |
| `JWT_SECRET` | — | Operator session signing |
| `STELLAR_SECRET` | — | The anchoring account |

Both hostnames must resolve to this host in public DNS **before** first start, or
the ACME challenge fails.

What the stack does:

- **Caddy** terminates TLS, obtains and renews certificates automatically, and
  is the only service with published ports.
- **Capture** is served as static files with its API at `/api` on the *same
  origin* — no mixed content, no CORS, and a real secure context, so the camera
  and service worker work.
- **The dashboard** is proxied whole, because Next.js in server mode owns its own
  routing and streaming.
- **The backend has no published port.** Exposing `3000` would reintroduce the
  plain-HTTP endpoint this whole arrangement exists to remove, and a phone that
  found it would work right up until the day it silently stopped.
- **`TRUST_PROXY=1`** because there is exactly one hop in front. Without it the
  backend cannot see the real client IP and rate-limits every collector as a
  single client; set higher than the true hop count and a client could forge it.

### If you have no public DNS

For a pilot on a closed network, [`mkcert`](https://github.com/FiloSottile/mkcert)
issues a certificate from a local CA you install once on each phone. That gets a
real secure context with no warning and no internet, at the cost of provisioning
the root certificate onto every device. Caddy's `tls internal` does the same
thing with the same caveat.

---

## What this does *not* fix

HTTPS makes the camera and the service worker **possible**, not the network
**reliable**. A field link drops, and a phone can spend a whole shift with no
signal at all.

The capture app handles that separately: every weigh-in is signed on the spot and
queued in IndexedDB, then synced whenever a connection appears. See
`apps/capture/src/lib/queue.ts`.

So: **HTTPS is the fix for the secure context. The offline queue is the fix for
no signal.** They are not alternatives.
