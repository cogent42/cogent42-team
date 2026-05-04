# Build: docker build -t cogent42-team/bot:latest -f apps/bot/Dockerfile .
FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache git

COPY package.json package-lock.json* ./
COPY packages/db/package.json     packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY apps/bot/package.json        apps/bot/package.json

RUN npm install --omit=dev --workspaces --include-workspace-root

COPY packages ./packages
COPY apps/bot ./apps/bot

ENV NODE_ENV=production
WORKDIR /app/apps/bot
CMD ["node", "src/index.js"]
