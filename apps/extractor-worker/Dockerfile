# Build: docker build -t cogent42-team/extractor-worker:latest -f apps/extractor-worker/Dockerfile .
FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/db/package.json                packages/db/package.json
COPY packages/shared/package.json            packages/shared/package.json
COPY apps/extractor-worker/package.json      apps/extractor-worker/package.json

RUN npm install --omit=dev --workspaces --include-workspace-root

COPY packages ./packages
COPY apps/extractor-worker ./apps/extractor-worker

ENV NODE_ENV=production
WORKDIR /app/apps/extractor-worker
CMD ["node", "src/index.js"]
