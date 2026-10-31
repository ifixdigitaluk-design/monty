# Monty production images. One file, three targets:
#   docker build --target api -t monty-api .
#   docker build --target web --build-arg API_INTERNAL_URL=http://api:4000 -t monty-web .
#   (database migrations run from the api image: see compose.yaml "migrate")
#
# Pin NODE_IMAGE to a digest in your registry for reproducible builds, e.g. node:22.21.0-bookworm-slim@sha256:…
ARG NODE_IMAGE=node:22.21.0-bookworm-slim

# ---------- build: install with the lockfile, compile everything ----------
FROM ${NODE_IMAGE} AS build
ENV CI=true NEXT_TELEMETRY_DISABLED=1 PNPM_HOME=/pnpm
RUN corepack enable
WORKDIR /repo
# Manifests first so dependency installation is cached until a lockfile or package.json changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/api-client/package.json packages/api-client/
COPY packages/database/package.json packages/database/
COPY packages/domain/package.json packages/domain/
COPY packages/editor/package.json packages/editor/
COPY packages/validation/package.json packages/validation/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter '!@monty/e2e' --filter '!@monty/desktop'
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
COPY apps/web apps/web
# The web app proxies /api to this address; Next.js reads it at build time.
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL} NEXT_OUTPUT=standalone
RUN pnpm --filter './packages/*' run build \
 && pnpm --filter @monty/api run build \
 && pnpm --filter @monty/web run build
# Self-contained API folder with production dependencies only (workspace packages copied in).
RUN pnpm --filter @monty/api deploy --prod --legacy /out/api

# ---------- api runtime ----------
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production API_PORT=4000
RUN groupadd --system --gid 10001 monty && useradd --system --uid 10001 --gid monty --no-create-home --shell /usr/sbin/nologin monty
WORKDIR /app
COPY --from=build --chown=root:root /out/api /app
# Code is root-owned and read-only for the runtime user; the API writes nothing to disk (logs go to stdout).
USER 10001:10001
EXPOSE 4000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/v1/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

# ---------- web runtime ----------
FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd --system --gid 10001 monty && useradd --system --uid 10001 --gid monty --no-create-home --shell /usr/sbin/nologin monty
WORKDIR /app
COPY --from=build --chown=root:root /repo/apps/web/.next/standalone ./
COPY --from=build --chown=root:root /repo/apps/web/.next/static ./apps/web/.next/static
USER 10001:10001
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
