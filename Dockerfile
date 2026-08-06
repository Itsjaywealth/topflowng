# syntax=docker/dockerfile:1
# TopFlowNG — production image.
#
# Non-root user, production-only deps, minimal image. The entrypoint runs the
# idempotent migration runner, then starts the web server. Healthcheck uses the
# liveness endpoint (/api/health); platform orchestrators should gate traffic
# on the readiness endpoint (/api/ready).
#
#   docker build -t topflowng .
#   docker run -p 3000:3000 --env-file .env topflowng
# (on a TLS-less Postgres, set DATABASE_URL with ?sslmode=disable)
#
#   Build:  docker build -t topflowng .
#   Run:    docker run --rm -p 3000:3000 \
#             --env NODE_ENV=production \
#             --env DATABASE_URL=postgres://...?sslmode=require \
#             --env JWT_SECRET=... ... (all REQUIRED vars, see config.js) \
#             topflowng

FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install production dependencies first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the application (build context is already pruned by .dockerignore).
COPY . .

# Non-root user for the web process.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health | grep -q '"status":"ok"' || exit 1

# Run idempotent migrations, then start. Migrations must run as the DB owner.
CMD ["sh", "-c", "node migrations/migrate.js && node server.js"]