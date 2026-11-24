FROM node:24-trixie-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates tini perl ffmpeg poppler-utils libraw-bin \
    libheif-examples libheif-plugin-libde265 postgresql-client-17 \
  && rm -rf /var/lib/apt/lists/*
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/
COPY packages/shared/package.json packages/shared/
COPY packages/media/package.json packages/media/
COPY packages/api-client/package.json packages/api-client/
COPY packages/config/package.json packages/config/
RUN pnpm install --frozen-lockfile --filter "@memory-vault/api..."

COPY packages packages
COPY apps/api apps/api
COPY apps/cli apps/cli
RUN pnpm --filter @memory-vault/api exec prisma generate

WORKDIR /app/apps/api
ENV NODE_ENV=production
ENTRYPOINT ["tini", "--"]
CMD ["pnpm", "exec", "tsx", "src/worker.ts"]
