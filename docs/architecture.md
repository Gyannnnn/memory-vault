# Architecture

```
            ┌──────────────┐   presigned PUTs (SHA-256 checked by S3)    ┌──────────────────────────┐
 vault CLI ─┤  API (Express)├──────────── never carries file bytes ────▶│ S3 bucket (ap-south-1)    │
 web/mobile │  stateless    │◀───────── ObjectCreated events ──── SQS ──┤ users/{id}/originals/…    │
            └──────┬────────┘                                           │ users/{id}/thumbs/…       │
                   │ Prisma (app role, row-level security)              │ users/{id}/inbox/…        │
              ┌────▼─────┐      ┌────────┐      ┌───────────────┐       │ system/…                  │
              │ Postgres │      │ Redis  │◀────▶│ Worker        │──────▶└──────────────────────────┘
              │ +pgvector│      │ BullMQ │      │ ingest, S3     │  thumbnails, backups, catalogue
              └──────────┘      └────────┘      │ events, upkeep │
                                                └───────────────┘
```

## Principles

- **The bucket is the source of truth.** Originals are stored once per user under a content-addressed key and carry their SHA-256, source and original path as metadata. The database is an index that can be rebuilt from the bucket (`vault-admin rebuild-index`).
- **File bytes never pass through the API.** Clients upload straight to S3 with presigned URLs. Each URL signs the expected SHA-256, so S3 itself rejects corrupted bytes. Multipart uploads sign a checksum per part, and the composite checksum is compared after completion.
- **Nothing is skipped silently.** Every scanned file ends in exactly one state (uploaded, already stored, awaiting review, skipped by you, excluded, failed, not yet attempted). The reconciliation report asserts that the counts add up.
- **Sources are read-only.** The source reader has no write operations (enforced by a test). The adb wrapper allows only `find`, `stat`, `sha256sum`, `df`, `getprop` and `pull -a`. Workers mount sources read-only.
- **Tenant isolation twice.** Every library query runs inside `withUser`, which sets `app.user_id` for the transaction, and Postgres row-level security restricts the app's role to that user's rows.

## Storage layout

| Key                                                  | Contents                                                   | Storage class                       |
| ---------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------- |
| `users/{userId}/originals/{sha[0:2]}/{sha256}.{ext}` | Untouched originals                                        | Intelligent-Tiering (instant tiers) |
| `users/{userId}/thumbs/{sha256}/{sm,md,lg}.webp`     | 400/1080/2048 px previews, metadata stripped               | Intelligent-Tiering                 |
| `users/{userId}/inbox/…`                             | Files dropped in directly; indexed and moved by the worker | —                                   |
| `system/db-backups/{daily,monthly}/…`                | `pg_dump` custom-format backups                            | Intelligent-Tiering                 |
| `system/catalog/{userId}/…jsonl.gz`                  | Every file, its locations and origins                      | Intelligent-Tiering                 |
| `system/integrity/{date}.json`                       | Weekly database ↔ S3 check results                         | Intelligent-Tiering                 |

## Data model

- **Identity** (no row-level security, because sign-in must find users): `users`, `password_credentials`, `totp_credentials` (secret encrypted with AES-256-GCM), `recovery_codes` (argon2id), `passkeys`, `sessions` + `refresh_tokens` (single-use, reuse revokes the session), `audit_events`.
- **Library** (row-level security on `user_id`): `assets` (one per unique content per user), `file_entries` (an asset placed in a folder; an asset can appear in many), `folders` (tree under a per-user root), `asset_origins` (every source path it was found at), `derivatives`, `upload_sessions`, `usage_snapshots`.

## Sign-in

| Path                                | Needs                          | Notes                                                            |
| ----------------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| Passkey (fingerprint/face, YubiKey) | A registered authenticator     | Primary on web and mobile (Phase 2/3); bound to the app's domain |
| Password + TOTP                     | Password and authenticator app | CLI sign-in in Phase 1                                           |
| Recovery code                       | One of 10 printed codes        | Works without password, phone or email; each code works once     |

Access tokens are EdDSA JWTs valid for 10 minutes. Refresh tokens rotate on every use and are stored only as hashes. Signing a device out takes effect immediately.

## Upload flow

1. The CLI scans a source: walk, SHA-256, junk rules, manifest (SQLite).
2. `POST /v1/uploads/check` finds content already stored. Its locations are recorded with `POST /v1/assets/origins`.
3. For new content, `POST /v1/uploads` returns either a presigned single PUT (≤ 16 MiB) or a multipart upload. Parts are presigned with their SHA-256 (`POST /v1/uploads/{id}/parts`).
4. `POST /v1/uploads/{id}/complete` makes the API check size and checksum with S3, then mark the asset verified, record its origin and mirrored folder entry, and queue `ingest`.
5. The worker extracts EXIF, generates WebP previews and computes a perceptual hash, preferring the uploader's local copy (read-only mount) over downloading.

Resume: re-running finds the open upload session and asks S3 which parts it already has.
