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
pnpm vault scan <dir> --source laptop:s21fe --dry-run
pnpm vault phone inventory
pnpm vault upload laptop:s21fe
pnpm vault report
pnpm test
```

Progress and decisions are tracked in [PROGRESS.md](PROGRESS.md).
