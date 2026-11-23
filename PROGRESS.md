# Progress

Status legend: `todo` · `in progress` · `done` · `blocked`

## Phase 0 — Prerequisites

| Task                                                         | Status      | Notes                                                              |
| ------------------------------------------------------------ | ----------- | ------------------------------------------------------------------ |
| Node 24 + pnpm via corepack                                  | done        | `.nvmrc` pins 24                                                   |
| adb (Android platform-tools)                                 | done        | Installed at `~/.local/opt/platform-tools`; the CLI finds it there |
| Docker Desktop running                                       | done        |                                                                    |
| Local secrets and `.env` files                               | done        | `pnpm secrets:init`                                                |
| USB debugging on the S21 FE                                  | blocked     | Needs the owner: setup guide §0.2                                  |
| AWS account hardening (root MFA, contacts, budget)           | blocked     | Needs the owner: setup guide §A                                    |
| S3 bucket, SQS queue, IAM user `memory-vault-app`            | in progress | Owner is working through setup guide §B–E                          |
| Paste AWS values into `apps/api/.env`, run `pnpm aws:verify` | blocked     | Needs the owner: setup guide §F                                    |

## Phase 1 — Backend, auth, upload everything

| #   | Task                                                                      | Status      | Notes                                                                  |
| --- | ------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------- |
| 1   | Monorepo scaffold (pnpm, Turborepo, TS, ESLint, Prettier)                 | done        |                                                                        |
| 2   | Docker Compose (Postgres 17 + pgvector, Redis 8, S3 test gateway)         | done        | Postgres on 5433 to avoid another local Postgres                       |
| 3   | Dry-run scanner + manifest + junk rules                                   | done        | Laptop: 15,537 files / 86.9 GB; source unchanged afterwards (verified) |
| 3b  | Phone inventory + on-phone hashing (adb, read-only allowlist)             | done        | Waiting for USB debugging to run it                                    |
| C1  | **Checkpoint:** show both dry runs + phone inventory                      | in progress | Laptop dry run done; phone pending                                     |
| 4   | AWS setup guide + `pnpm aws:verify`                                       | done        | `docs/setup/phase-0-aws-setup.md`                                      |
| 5   | Prisma schema, migrations, row-level security                             | done        |                                                                        |
| 6   | API: auth (password + TOTP, recovery codes, passkeys, rotating sessions)  | done        | Passkey UI comes with the web app                                      |
| 6b  | API: uploads (check, presign, multipart, complete, verify)                | done        | SHA-256 enforced by S3 per request/part                                |
| 7   | CLI: login, resumable upload engine, progress, phone pull, reconciliation | done        | End-to-end test covers resume and reconciliation                       |
| 8   | Workers: ingest, S3 events, integrity, backups, catalogue, rebuild-index  | in progress | Code and tests done; Docker image smoke test pending                   |
| 8b  | Python junk classifier (CLIP, CPU)                                        | todo        |                                                                        |
| 9   | Junk review page (`vault review`)                                         | in progress | Server done; UI after reading the design skills                        |
| 10  | Tests for critical paths                                                  | done        | 140+ tests: auth, uploads, checksums, isolation, e2e, rebuild          |
| 11  | Docs: restore runbook, architecture, costs, credentials                   | done        |                                                                        |
| 12  | Run the import: laptop → phone batches → review → reconciliation          | blocked     | Needs AWS credentials and the phone                                    |
| C5  | **Checkpoint:** Phase 1 summary + feature suggestions                     | todo        |                                                                        |

## Phase 2 — Web app (outline)

Next.js, CloudFront, passkey registration on the real domain, browse/timeline/map/search, folders, zip download, HLS + Vidstack, share links, stats, People, RDS.

## Phase 3 — Mobile app (outline)

Expo dev builds, approval-based sync, trip detection, junk review, native passkeys.

## Decisions

| Date       | Decision                                                                                | Why                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-23 | Junk review in Phase 1 is a local page served by the CLI                                | Laptop counterpart of the mobile review screen; lets Phase 1 finish                                                                  |
| 2026-11-23 | Local Docker Postgres in Phase 1, RDS in Phase 2                                        | Free; S3 objects carry their own metadata and a nightly catalogue, so the index is rebuildable (`vault-admin rebuild-index`, tested) |
| 2026-11-23 | Folders mirror each source; content stored once                                         | Faithful to the originals without duplicate storage                                                                                  |
| 2026-11-23 | All objects in S3 Intelligent-Tiering, instant tiers only (no Deep Archive)             | Hot when used, ~80% cheaper after 90 idle days, never a restore wait                                                                 |
| 2026-11-23 | AWS resources created by hand in the console from a guide                               | Owner's choice; no admin keys used by tooling                                                                                        |
| 2026-11-23 | AWS SDK credentials come only from `.env`, never the default chain                      | Prevents silently using an unrelated admin profile on the laptop                                                                     |
| 2026-11-23 | SSE-S3 rather than KMS                                                                  | Free; no key whose deletion could make the archive unreadable                                                                        |
| 2026-11-23 | Content-addressed keys `users/{id}/originals/{sha[0:2]}/{sha}.{ext}`                    | Dedup by construction; renames are metadata-only                                                                                     |
| 2026-11-23 | Hash phone files on the phone, pull only unseen ones, one file at a time                | Heavy overlap with the laptop copy; staging never needs more than a few files of disk                                                |
| 2026-11-23 | Passkey registration UI ships with the web app on the real domain                       | A passkey is bound to its domain; localhost passkeys would be throwaway                                                              |
| 2026-11-23 | ffmpeg worker for video, not MediaConvert                                               | ~$0 vs ~$80–120 one-off for the backlog; full control over HEVC/HDR                                                                  |
| 2026-11-23 | TypeScript 6.0, Prisma 7.10, pnpm with a 7-day minimum release age                      | typescript-eslint supports TS < 6.1; Prisma 8 is a release candidate; supply-chain guard                                             |
| 2026-11-23 | Node's built-in `node:sqlite` for the CLI manifest                                      | No native dependency to build                                                                                                        |
| 2026-11-23 | Worker runs in Docker (libheif + libde265, ffmpeg, poppler, LibRaw)                     | sharp's prebuilt binaries can't decode HEVC-based HEIC; the laptop has no ffmpeg                                                     |
| 2026-11-23 | Identity tables outside row-level security; library tables under it                     | Sign-in must find a user before knowing who they are                                                                                 |
| 2026-11-24 | Capture time: EXIF with zone → EXIF in the account's time zone → file name → file mtime | WhatsApp images carry no EXIF; their names carry the date                                                                            |

## Open questions

- Phase 2: domain name for the app (becomes the passkey RP ID — keep it for life).
- Phase 2: where the API runs (ECS Fargate, App Runner, EC2, …).
