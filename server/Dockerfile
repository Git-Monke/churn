# syntax=docker/dockerfile:1

# Build the workspace once, then keep only runtime dependencies in the final
# image. Production installs pull this image; they never need Node or npm.
#
# The two prepare stages run on the build platform, not the target: the app is
# pure JavaScript (no native modules in the runtime dependency closure), so
# npm, tsc and vite emit identical bytes for every architecture. That keeps the
# multi-arch build from running them a second time under QEMU emulation, which
# costs minutes on the arm64 leg.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /app

# Install with the lockfile before copying sources so dependency layers cache.
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

COPY backend backend
COPY frontend frontend
RUN npm run build

# Mount points for the named volumes the compose service attaches.
RUN mkdir -p /app/state /app/.churn-cache

# Production dependencies only, and only for the backend workspace. The
# frontend is already built into static files, so React, Radix and Vite are
# not carried into the runtime image.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev --include-workspace-root=false --workspace @churn/backend

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    CHURN_SERVER_DIR=/app \
    PORT=4000
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/frontend/dist ./frontend/dist

# Fresh named volumes inherit these directories' ownership, so the non-root
# `node` user can write the release/media cache and the auth state. They are
# staged in the build stage and copied with --chown so the runtime stage runs
# no instruction that would need emulation on a foreign architecture.
COPY --from=build --chown=node:node /app/state /app/state
COPY --from=build --chown=node:node /app/.churn-cache /app/.churn-cache

USER node

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/dist/index.js"]
