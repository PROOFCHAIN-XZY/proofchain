# ProofChain backend + anchor worker.
#
# One image, two entrypoints. The backend and the worker share the trust kernel
# in packages/shared and must never disagree about how a leaf is hashed or a
# root is built — shipping them from a single build makes that impossible by
# construction, and halves the deploy surface. The process to run is chosen by
# the command:
#
#   docker run … proofchain node apps/backend/dist/main.js        # API
#   docker run … proofchain node services/anchor-worker/dist/index.js  # worker
#
# Debian slim rather than Alpine: argon2 (password hashing) is a native module,
# and prebuilt binaries are published for glibc. On musl it would be compiled
# from source at install time, in the runtime image, on every deploy.

ARG NODE_VERSION=20.19.4

# ---------------------------------------------------------------------------
# Dependencies — cached on the lockfile alone, so editing source does not
# reinstall node_modules.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app

# Toolchain for any dependency without a prebuilt binary for this platform.
# Builder-stage only; none of it reaches the runtime image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Every workspace's manifest, because `npm ci` resolves the whole workspace
# graph up front and fails on a missing member. apps/mobile is included for the
# same reason — the lockfile covers it — though nothing here builds it.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
COPY apps/capture/package.json apps/capture/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/mobile/package.json apps/mobile/
COPY services/anchor-worker/package.json services/anchor-worker/

RUN npm ci --fetch-retries=5 --fetch-retry-maxtimeout=60000

# ---------------------------------------------------------------------------
# Build — shared first: both other workspaces import it through its built .d.ts
# files, not its source, so tsc cannot type-check them until it exists.
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/backend apps/backend
COPY services/anchor-worker services/anchor-worker

RUN npm run build -w @proofchain/shared \
    && npm run build -w @proofchain/backend \
    && npm run build -w @proofchain/anchor-worker

# Drop devDependencies from the tree that ships. Done here rather than with a
# second `npm ci --omit=dev` so the workspace symlinks (node_modules/@proofchain/*
# -> packages/shared) survive intact.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Nothing writes to the image; the evidentiary record is in Postgres.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# Only the built output and the pruned production tree. No source, no compiler,
# no test fixtures, and no seed keys.
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/apps/backend/package.json ./apps/backend/
COPY --from=build --chown=node:node /app/apps/backend/dist ./apps/backend/dist
COPY --from=build --chown=node:node /app/services/anchor-worker/package.json ./services/anchor-worker/
COPY --from=build --chown=node:node /app/services/anchor-worker/dist ./services/anchor-worker/dist

# Never root: a container that can only read its own code cannot be used to
# rewrite it if the process is compromised.
USER node

EXPOSE 3000

# The API is useless without Postgres, and /health says so — it runs a query
# rather than merely proving the process is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>r.json()).then(b=>process.exit(b.status==='ok'?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/backend/dist/main.js"]
