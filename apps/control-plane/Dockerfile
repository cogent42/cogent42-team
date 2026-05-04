# Build context: repo root (so workspaces resolve).
# Build: docker build -t cogent42-team/control-plane:latest -f apps/control-plane/Dockerfile .
FROM node:20-alpine
WORKDIR /app

# Copy workspace manifests first for better caching.
COPY package.json package-lock.json* ./
COPY packages/db/package.json         packages/db/package.json
COPY packages/shared/package.json     packages/shared/package.json
COPY apps/control-plane/package.json  apps/control-plane/package.json

RUN npm install --omit=dev --workspaces --include-workspace-root

# Copy source.
COPY packages ./packages
COPY apps/control-plane ./apps/control-plane

ENV NODE_ENV=production
WORKDIR /app/apps/control-plane
EXPOSE 8080
CMD ["node", "src/index.js"]
