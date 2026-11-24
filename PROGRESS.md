# Progress

Status legend: `todo` · `in progress` · `done` · `blocked`

## Phase 0 — Prerequisites

| Task                                                         | Status | Notes                                                              |
| ------------------------------------------------------------ | ------ | ------------------------------------------------------------------ |
| Node 24 + pnpm via corepack                                  | done   | `.nvmrc` pins 24                                                   |
| adb (Android platform-tools)                                 | done   | Installed at `~/.local/opt/platform-tools`; the CLI finds it there |
| Docker Desktop running                                       | done   |                                                                    |
| Local secrets and `.env` files                               | done   | `pnpm secrets:init`                                                |
| USB debugging on the S21 FE                                  | done   | Phone connected and authorised                                     |
| AWS account hardening (root MFA, contacts, budget)           | todo   | Owner: setup guide §A (recommended before the import)              |
| S3 bucket, SQS queue, IAM user `memory-vault-app`            | done   | `pnpm aws:verify`: all 18 checks pass                              |
| Paste AWS values into `apps/api/.env`, run `pnpm aws:verify` | done   | `pnpm test:aws` also passes against the real bucket                |

## Phase 1 — Backend, auth, upload everything

| #   | Task                                                                      | Status | Notes                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Monorepo scaffold (pnpm, Turborepo, TS, ESLint, Prettier)                 | done   |                                                                                                                                                                           |
| 2   | Docker Compose (Postgres 17 + pgvector, Redis 8, S3 test gateway)         | done   | Postgres on 5433 to avoid another local Postgres                                                                                                                          |
| 3   | Dry-run scanner + manifest + junk rules                                   | done   | Laptop: 15,537 files / 86.9 GB; source unchanged afterwards (verified)                                                                                                    |
| 3b  | Phone inventory + on-phone hashing (adb, read-only allowlist)             | done   | Waiting for USB debugging to run it                                                                                                                                       |
| C1  | **Checkpoint:** show both dry runs + phone inventory                      | done   | Laptop and phone dry runs reviewed; phone listing bug found and fixed                                                                                                     |
| 4   | AWS setup guide + `pnpm aws:verify`                                       | done   | `docs/setup/phase-0-aws-setup.md`                                                                                                                                         |
| 5   | Prisma schema, migrations, row-level security                             | done   |                                                                                                                                                                           |
| 6   | API: auth (password + TOTP, recovery codes, passkeys, rotating sessions)  | done   | Passkey UI comes with the web app                                                                                                                                         |
| 6b  | API: uploads (check, presign, multipart, complete, verify)                | done   | SHA-256 enforced by S3 per request/part                                                                                                                                   |
| 7   | CLI: login, resumable upload engine, progress, phone pull, reconciliation | done   | End-to-end test covers resume and reconciliation                                                                                                                          |
| 8   | Workers: ingest, S3 events, integrity, backups, catalogue, rebuild-index  | done   | Smoke-tested in the Docker image on real HEIC, DNG, MP4, JPG, PNG and WhatsApp files                                                                                      |
| 8b  | Python junk classifier (CLIP, CPU)                                        | done   | Model pinned to a commit; image builds with the other services                                                                                                            |
| 9   | Junk review page (`vault review`)                                         | done   | Built with ui-ux-pro-max + shared tokens; checked in light and dark                                                                                                       |
| 10  | Tests for critical paths                                                  | done   | 140+ tests: auth, uploads, checksums, isolation, e2e, rebuild                                                                                                             |
| 11  | Docs: restore runbook, architecture, costs, credentials                   | done   |                                                                                                                                                                           |
| 12  | Run the import: laptop → phone → review → reconciliation                  | done   | 65,900 files found, each counted once: 20,346 uploaded (119 GB, all verified in S3), 12,543 duplicates, 22,576 skipped in review, 10,425 excluded, 10 undecided, 0 failed |
| C5  | **Checkpoint:** Phase 1 summary + feature suggestions                     | done   | Reviewed 2026-11-24: all 16 suggested features accepted; Phase 2 plan approved                                                                                            |

## Phase 2 — Web app

Runs on localhost for now; media via short-lived presigned S3 URLs (CloudFront and a domain come with deployment). Plan agreed 2026-11-24: milestones M0 (foundation and security screens) → M1 (browse) → M2 (upload, video, downloads) → M3 (organise, share, protect) → M4 (people, OCR, trips) → M5 (account continuity) → M6 (stats, encrypted folders).

| Milestone                                  | Status                                 |
| ------------------------------------------ | -------------------------------------- |
| M0 Web foundation and security screens     | done (checked by the owner 2026-11-24) |
| M1 Browse                                  | built, awaiting check-in               |
| M2 Upload, video, downloads, motion photos | todo                                   |
| M3 Organise, share and protect             | todo                                   |
| M4 People, OCR, trips                      | todo                                   |
| M5 Account continuity                      | todo                                   |
| M6 Stats, cost, encrypted folders          | todo                                   |

M0 delivered: `apps/web` (Next.js 16, Tailwind 4 with the shared design tokens, light/dark/system themes); sign-in with password + authenticator code, recovery code or passkey; tokens only in httpOnly cookies, renewed by `src/proxy.ts`; the app shell with every section in place; Settings › Security (passkeys and security keys: add, rename, remove; authenticator replacement and new recovery codes, both behind a fresh password + second-factor check; signed-in devices with sign out). Checked end to end in headless Chrome with a virtual authenticator against a throwaway API and test database.

M1 delivered: the Photos timeline (months laid out before they load, small days packed side by side, a year/month scrubber that works with the keyboard), "On this day", the photo viewer (zoom, pan, swipe, arrow keys, deep links, and details: capture time and where it came from, place with a mini map, camera settings, file, original locations), folders mirrored from each source, a map of every photo with GPS (clusters, plus the photos in view), and search (word prefixes over file names, original folders, places and cameras; filters for type, year, place, camera and source). Place names come from GeoNames inside Postgres (`pnpm vault-admin load-places`; loaded 2026-11-24, all 8,545 files with GPS named). Database backed up to `reports/db-before-m1-2026-11-24.dump` before the migration.

M1 follow-up (2026-11-24, after the first look at the real library): many 2026 photos had no preview because about 5,900 phone files were still waiting for the worker. Their staging copies had been deleted right after upload, so the worker re-downloaded each from S3 at the line's ~0.5 MB/s. The laptop then slept from 17:44 to 21:51; on waking, the worker's open S3 downloads hung with no timeout.

- S3 requests now give up after 10 s connecting or 2 minutes without data, so the job is retried.
- `vault phone stage-pending` copies the waiting phone files over USB (read-only, each checked against the server's SHA-256) to where the jobs look, a few GB ahead of the worker, and deletes each copy once processed. It pauses and waits if the phone is disconnected. Run on 2026-11-24: all 5,499 waiting files processed in about 1.5 hours (most from local copies at ~30 MB/s); staging left empty.
- Photos that are really HEIC but named `.jpg` (Instagram saves these) failed with "bad seek"; the worker now recognises HEIC by content. 16 such files processed after the fix.
- The viewer shows the original of a photo still being processed, and waiting tiles say so.
- Waiting jobs were reordered newest first, so the top of the timeline fills first.
- Result: 0 files waiting, 0 failed jobs; `vault-admin integrity` healthy (20,346 in S3); 11,045 of 11,112 files with GPS have a place name. The other 67 carry a blank (0°, 0°) GPS fix.
- Still to do: `vault upload` should keep a phone file's temporary copy until it is processed, so a big import doesn't leave a backlog again; failed jobs need a retry command, and the app should say when processing has stopped; ignore (0°, 0°) GPS positions.

Core (from the brief): browse, timeline, map, search and filters, folders, zip download, upload with progress, video playback (HLS + Vidstack), sharing links, statistics, People (faces), passkey sign-in screens.

Accepted feature suggestions (2026-11-24, all yes):

| #   | Feature                                                  | Phase    |
| --- | -------------------------------------------------------- | -------- |
| 1   | Trash with 30-day restore                                | 2        |
| 2   | Favorites and albums                                     | 2        |
| 3   | "On this day" memories                                   | 2        |
| 4   | EXIF viewer                                              | 2        |
| 5   | Near-duplicate finder                                    | 2        |
| 6   | Legacy / emergency access                                | 2        |
| 7   | One-click full export to an external drive               | 2        |
| 8   | Audit log of shares and downloads                        | 2        |
| 9   | Offline favorites on mobile                              | 3        |
| 10  | Opt-in end-to-end encrypted folders                      | 2 (late) |
| 11  | Deletion protection (Object Lock or second-account copy) | 2        |
| 12  | Printable emergency kit (PDF)                            | 2        |
| 13  | Yearly restore-drill reminder                            | 2        |
| 14  | Samsung motion-photo playback                            | 2        |
| 15  | Automatic trip albums                                    | 2        |
| 16  | Local OCR text search                                    | 2        |

## Phase 3 — Mobile app (outline)

Expo dev builds, approval-based sync, trip detection, junk review, native passkeys, offline favorites.

## Decisions

| Date       | Decision                                                                                                 | Why                                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-23 | Junk review in Phase 1 is a local page served by the CLI                                                 | Laptop counterpart of the mobile review screen; lets Phase 1 finish                                                                            |
| 2026-11-23 | Local Docker Postgres in Phase 1, RDS in Phase 2                                                         | Free; S3 objects carry their own metadata and a nightly catalogue, so the index is rebuildable (`vault-admin rebuild-index`, tested)           |
| 2026-11-23 | Folders mirror each source; content stored once                                                          | Faithful to the originals without duplicate storage                                                                                            |
| 2026-11-23 | All objects in S3 Intelligent-Tiering, instant tiers only (no Deep Archive)                              | Hot when used, ~80% cheaper after 90 idle days, never a restore wait                                                                           |
| 2026-11-23 | AWS resources created by hand in the console from a guide                                                | Owner's choice; no admin keys used by tooling                                                                                                  |
| 2026-11-23 | AWS SDK credentials come only from `.env`, never the default chain                                       | Prevents silently using an unrelated admin profile on the laptop                                                                               |
| 2026-11-23 | SSE-S3 rather than KMS                                                                                   | Free; no key whose deletion could make the archive unreadable                                                                                  |
| 2026-11-23 | Content-addressed keys `users/{id}/originals/{sha[0:2]}/{sha}.{ext}`                                     | Dedup by construction; renames are metadata-only                                                                                               |
| 2026-11-23 | Hash phone files on the phone, pull only unseen ones, one file at a time                                 | Heavy overlap with the laptop copy; staging never needs more than a few files of disk                                                          |
| 2026-11-23 | Passkey registration UI ships with the web app on the real domain                                        | A passkey is bound to its domain; localhost passkeys would be throwaway                                                                        |
| 2026-11-23 | ffmpeg worker for video, not MediaConvert                                                                | ~$0 vs ~$80–120 one-off for the backlog; full control over HEVC/HDR                                                                            |
| 2026-11-23 | TypeScript 6.0, Prisma 7.10, pnpm with a 7-day minimum release age                                       | typescript-eslint supports TS < 6.1; Prisma 8 is a release candidate; supply-chain guard                                                       |
| 2026-11-23 | Node's built-in `node:sqlite` for the CLI manifest                                                       | No native dependency to build                                                                                                                  |
| 2026-11-23 | Worker runs in Docker (libheif + libde265, ffmpeg, poppler, LibRaw)                                      | sharp's prebuilt binaries can't decode HEVC-based HEIC; the laptop has no ffmpeg                                                               |
| 2026-11-23 | Identity tables outside row-level security; library tables under it                                      | Sign-in must find a user before knowing who they are                                                                                           |
| 2026-11-24 | Capture time: EXIF with zone → EXIF in the account's time zone → file name → file mtime                  | WhatsApp images carry no EXIF; their names carry the date                                                                                      |
| 2026-11-24 | The "taste" skill is used only for marketing pages; app screens use ui-ux-pro-max + `packages/tokens`    | Owner's choice: taste targets marketing sites and runs a Stop hook plus many scripts                                                           |
| 2026-11-24 | Shared design tokens: neutral "gallery" palette, Inter, 4 px spacing, WCAG AA in light and dark (tested) | Photos carry the colour; one system for web, mobile and local tools                                                                            |
| 2026-11-24 | Phase 2 runs on localhost; deploy later (web on Vercel, API/worker on EC2 when load grows)               | Owner's choice; no hosting cost yet. Media via presigned S3 URLs until CloudFront                                                              |
| 2026-11-24 | All 16 suggested features accepted                                                                       | Owner's answers at the Phase 1 checkpoint                                                                                                      |
| 2026-11-24 | Faces: InsightFace buffalo_l                                                                             | Owner's choice for accuracy. **Its pretrained models are non-commercial only: replace (e.g. YuNet + SFace) or license before any paid launch** |
| 2026-11-24 | Email via Amazon SES (sandbox until a domain exists)                                                     | Owner's choice                                                                                                                                 |
| 2026-11-24 | Deletion protection: S3 Object Lock, governance, 30-day default retention                                | Versions can't be deleted for 30 days even with a stolen key; also backs the 30-day trash                                                      |
| 2026-11-24 | Process a phone backlog from USB copies (`vault phone stage-pending`), not S3 downloads                  | ~26 MB/s over USB vs ~0.5 MB/s down the line; copies verified by SHA-256 and deleted once processed                                            |

## Open questions

- Domain name: owner has or will buy one; passkeys registered on localhost must be re-registered on it.
