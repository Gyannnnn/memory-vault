# Memory Vault

A private, long-lived home for photos, videos and files on AWS S3 — with a Node.js API, a `vault` CLI, a Next.js web app and an Expo mobile app. Built multi-tenant from day one.

## Repository layout

| Path                   | What it is                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `apps/api`             | Express API, background workers and admin scripts (Prisma + PostgreSQL/pgvector)           |
| `apps/cli`             | `vault` CLI: scan, dry-run, phone import over adb, resumable uploads, junk review, reports |
| `apps/web`             | Next.js web app (Phase 2)                                                                  |
| `apps/mobile`          | Expo app (Phase 3)                                                                         |
| `services/face-worker` | Python worker: junk classifier and face recognition                                        |
| `packages/shared`      | Zod schemas, types and rules shared by every app                                           |
| `packages/media`       | Node-only media utilities: hashing, perceptual hashes, read-only source access             |
| `packages/api-client`  | Typed API client                                                                           |
| `packages/tokens`      | Design tokens shared by web and mobile                                                     |
| `packages/config`      | TypeScript, ESLint and Prettier config                                                     |
| `docs/`                | Setup guides, architecture, costs and runbooks                                             |

## Getting started

```bash
nvm use            # Node 24
corepack enable    # pnpm
pnpm install
pnpm secrets:init  # generates local secrets into .env files
docker compose up -d
```

AWS setup: follow [docs/setup/phase-0-aws-setup.md](docs/setup/phase-0-aws-setup.md), then run `pnpm aws:verify`.

## Common commands

```bash
# Look before you upload (read-only)
pnpm vault scan <dir> --source laptop:s21fe --dry-run
pnpm vault phone inventory --source phone:s21fe
pnpm vault phone select --source phone:s21fe --exclude Android/data
pnpm vault phone hash --source phone:s21fe
pnpm vault dry-run

# Account
pnpm vault-admin create-user
pnpm vault login            # or: pnpm vault login --recovery

# Upload, review, reconcile
pnpm vault upload laptop:s21fe phone:s21fe
pnpm vault classify && pnpm vault review
pnpm vault report --verify   # every file checked in S3; writes safe-to-delete lists

# Upkeep
pnpm vault-admin integrity | backup | catalog | rebuild-index
pnpm test        # unit, integration and end-to-end tests (needs `docker compose --profile test up -d`)
pnpm test:aws    # checks presigned checksums against the real bucket
```

Progress and decisions are tracked in [PROGRESS.md](PROGRESS.md).
