# Build: docker build -t cogent42-team/gmail-worker:latest -f apps/gmail-worker/Dockerfile .
FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/db/package.json             packages/db/package.json
COPY packages/shared/package.json         packages/shared/package.json
COPY apps/gmail-worker/package.json       apps/gmail-worker/package.json

RUN npm install --omit=dev --workspaces --include-workspace-root

COPY packages ./packages
COPY apps/gmail-worker ./apps/gmail-worker

ENV NODE_ENV=production
WORKDIR /app/apps/gmail-worker
CMD ["node", "src/index.js"]
