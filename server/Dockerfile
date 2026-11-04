# syntax=docker/dockerfile:1

# Build the workspace once, then keep only runtime dependencies in the final
# image. Production installs pull this image; they never need Node or npm.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install with the lockfile before copying sources so dependency layers cache.
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

COPY backend backend
COPY frontend frontend
RUN npm run build

# Production dependencies only, and only for the backend workspace. The
# frontend is already built into static files, so React, Radix and Vite are
# not carried into the runtime image.
FROM node:22-bookworm-slim AS prod-deps
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

# A fresh named volume inherits this directory's ownership, so the non-root
# `node` user can write the release/media cache.
RUN mkdir -p /app/.churn-cache && chown node:node /app/.churn-cache

USER node

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/dist/index.js"]
