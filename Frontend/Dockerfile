# syntax=docker/dockerfile:1
#
# Standalone SPA image, served by nginx.
#
# The production topology serves the SPA from the backend image (same origin,
# one service — see Backend/Dockerfile). This image exists for deployments that
# want the static bundle on a CDN or separate host, and it is built in CI so
# that path never silently rots.
#
# The previous version of this file ran `npm run dev` as the container command:
# it shipped the Vite DEV SERVER — source maps, no minification, a file watcher
# — as if it were a production artifact.

# ---------------------------------------------------------------------------
# Stage 1 — build
# ---------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# vite.config.js emits to ../Backend/public/dist for the single-service
# topology. Override it here so the bundle lands inside this build context.
RUN npx vite build --outDir dist --emptyOutDir

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM nginx:1.31-alpine AS runtime

# Port 8080, not 80: binding below 1024 requires privileges we are about to
# drop.
ENV NGINX_PORT=8080

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

# nginx needs to write its pid, caches and temp files. Grant exactly those
# paths to the unprivileged `nginx` user rather than running the whole server
# as root.
RUN touch /var/run/nginx.pid \
 && chown -R nginx:nginx /var/run/nginx.pid /var/cache/nginx /usr/share/nginx/html

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
