FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/daemon/package.json packages/daemon/
COPY packages/protocol/package.json packages/protocol/
COPY apps/telegram/package.json apps/telegram/
RUN pnpm install --frozen-lockfile --prod

COPY packages ./packages
COPY apps ./apps

# The SQLite file and the receipt inbox live in a volume (compose.yaml).
RUN mkdir -p /app/data && chown node:node /app/data
USER node

# Node 24 runs TypeScript directly by stripping types; there is no build step.
CMD ["node", "packages/daemon/src/main.ts"]
