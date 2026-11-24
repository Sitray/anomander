# The base image is pinned by digest (the multi-arch index), so a rebuild gets the same bytes. To
# refresh it, take the new digest of `node:24-slim` and replace the one below:
#   docker buildx imagetools inspect node:24-slim   (the "Digest:" line)
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

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

# The SQLite file and the receipt inbox live in a volume (compose.yaml), readable by its owner only
# (PRD §16). A new volume takes this mode; an existing one keeps its own.
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data
USER node

# Liveness: a running daemon holds an exclusive SQLite lock on `<database>.lock` for its whole life
# (DK-2 AC1, store/daemon-lock.ts), in every mode, Telegram, setup guide or read API. The check
# opens that file read-only with Node's own SQLite: "locked" means a daemon holds it, so the
# container is healthy; a file it can read, or no file, means none does. No curl, no open port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "--no-warnings", "-e", "const{DatabaseSync}=require('node:sqlite');const f=(process.env.ANOMANDER_DB_PATH||'./data/anomander.db')+'.lock';try{new DatabaseSync(f,{readOnly:true}).prepare('SELECT 1 FROM sqlite_master').all();console.log('no daemon holds '+f);process.exit(1)}catch(e){const held=e.errcode===5;console.log(held?'daemon holds '+f:'cannot read '+f+': '+e.message);process.exit(held?0:1)}"]

# Node 24 runs TypeScript directly by stripping types; there is no build step.
CMD ["node", "packages/daemon/src/main.ts"]
