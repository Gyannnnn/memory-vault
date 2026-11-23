# Progress

Status legend: `todo` · `in progress` · `done` · `blocked`

## Phase 0 — Prerequisites

| Task                                                         | Status | Notes                                               |
| ------------------------------------------------------------ | ------ | --------------------------------------------------- |
| Node 24 + pnpm via corepack                                  | done   | `.nvmrc` pins 24                                    |
| adb (Android platform-tools)                                 | todo   |                                                     |
| USB debugging on the S21 FE                                  | todo   | Needs you: see `docs/setup/phase-0-aws-setup.md` §0 |
| Docker Desktop running                                       | todo   | Needs you                                           |
| AWS account hardening (root MFA, contacts, budget)           | todo   | Needs you: guide §A                                 |
| S3 bucket, SQS queue, IAM user `memory-vault-app`            | todo   | Needs you: guide §B–E                               |
| Paste AWS values into `apps/api/.env`, run `pnpm aws:verify` | todo   | Needs you: guide §F                                 |

## Phase 1 — Backend, auth, upload everything

| #   | Task                                                                     | Status      | Notes                 |
| --- | ------------------------------------------------------------------------ | ----------- | --------------------- |
| 1   | Monorepo scaffold (pnpm, Turborepo, TS, ESLint, Prettier)                | in progress |                       |
| 2   | Docker Compose (Postgres + pgvector, Redis, S3 emulator for tests)       | todo        |                       |
| 3   | Dry-run scanner + manifest + junk rules (laptop)                         | todo        |                       |
| 3b  | Phone inventory + on-phone hashing (adb, read-only allowlist)            | todo        |                       |
| C1  | **Checkpoint:** show both dry runs + phone inventory                     | todo        |                       |
| 4   | AWS setup guide + `pnpm aws:verify`                                      | todo        |                       |
| 5   | Prisma schema, migrations, row-level security                            | todo        |                       |
| 6   | API: auth (password, TOTP, recovery codes, passkeys, sessions)           | todo        |                       |
| 6b  | API: uploads (check, presign, multipart, complete, verify)               | todo        |                       |
| 7   | CLI: login, resumable upload engine, progress, phone pull, report        | todo        |                       |
| 8   | Workers: ingest (EXIF, thumbnails, pHash), S3 events, integrity, backups | todo        |                       |
| 8b  | Python junk classifier (CLIP, CPU)                                       | todo        |                       |
| 9   | Junk review page (`vault review`)                                        | todo        | Needs UI skills first |
| 10  | Tests for critical paths                                                 | todo        |                       |
| 11  | Docs: restore runbook, architecture, costs, credentials                  | todo        |                       |
| 12  | Run the import: laptop → phone batches → review → reconciliation         | todo        |                       |
| C5  | **Checkpoint:** Phase 1 summary + feature suggestions                    | todo        |                       |

## Phase 2 — Web app (outline)

Next.js, CloudFront, passkey registration on the real domain, browse/timeline/map/search, folders, zip download, HLS + Vidstack, share links, stats, People, RDS.

## Phase 3 — Mobile app (outline)

Expo dev builds, approval-based sync, trip detection, junk review, native passkeys.

## Decisions

| Date       | Decision                                                                    | Why                                                                                          |
| ---------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 2026-11-23 | Junk review in Phase 1 is a local page served by the CLI                    | Laptop counterpart of the mobile review screen; lets Phase 1 finish                          |
| 2026-11-23 | Local Docker Postgres in Phase 1, RDS in Phase 2                            | Free; S3 objects carry their own metadata and a nightly catalog, so the index is rebuildable |
| 2026-11-23 | Folders mirror each source; content stored once                             | Faithful to the originals without duplicate storage                                          |
| 2026-11-23 | All objects in S3 Intelligent-Tiering, instant tiers only (no Deep Archive) | Hot when used, ~80% cheaper after 90 idle days, never a restore wait                         |
| 2026-11-23 | AWS resources created by hand in the console from a guide                   | Owner's choice; no admin keys used by tooling                                                |
| 2026-11-23 | AWS SDK credentials come only from `.env`, never the default chain          | Prevents silently using an unrelated admin profile on the laptop                             |
| 2026-11-23 | SSE-S3 rather than KMS                                                      | Free; no key whose deletion could make the archive unreadable                                |
| 2026-11-23 | Content-addressed keys `users/{id}/originals/{sha[0:2]}/{sha}.{ext}`        | Dedup by construction; renames are metadata-only                                             |
| 2026-11-23 | Hash phone files on the phone, pull only unseen ones                        | Heavy overlap with the laptop copy and ~129 GB free disk                                     |
| 2026-11-23 | Passkey registration UI ships with the web app on the real domain           | A passkey is bound to its domain; localhost passkeys would be throwaway                      |
| 2026-11-23 | ffmpeg worker for video, not MediaConvert                                   | ~$0 vs ~$80–120 one-off for the backlog; full control over HEVC/HDR                          |
| 2026-11-23 | TypeScript 6.0, Prisma 7.10                                                 | typescript-eslint supports TS < 6.1; Prisma 8 is still a release candidate                   |

## Open questions

- Phase 2: domain name for the app (becomes the passkey RP ID — keep it for life).
- Phase 2: where the API runs (ECS Fargate, App Runner, EC2, …).
