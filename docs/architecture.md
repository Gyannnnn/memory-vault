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

| Key                                                   | Contents                                                   | Storage class                       |
| ----------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------- |
| `users/{userId}/originals/{sha[0:2]}/{sha256}.{ext}`  | Untouched originals                                        | Intelligent-Tiering (instant tiers) |
| `users/{userId}/thumbs/{sha256}/{sm,md,lg}.webp`      | 400/1080/2048 px previews, metadata stripped               | Intelligent-Tiering                 |
| `users/{userId}/streams/{sha256}/{360,720,1080}p.mp4` | Video renditions for streaming (fragmented MP4, HLS)       | Intelligent-Tiering                 |
| `users/{userId}/streams/{sha256}/motion.mp4`          | A motion photo's clip, H.264                               | Intelligent-Tiering                 |
| `users/{userId}/inbox/…`                              | Files dropped in directly; indexed and moved by the worker | —                                   |
| `system/db-backups/{daily,monthly}/…`                 | `pg_dump` custom-format backups                            | Intelligent-Tiering                 |
| `system/catalog/{userId}/…jsonl.gz`                   | Every file, its locations and origins                      | Intelligent-Tiering                 |
| `system/integrity/{date}.json`                        | Weekly database ↔ S3 check results                         | Intelligent-Tiering                 |

## Data model

- **Identity** (no row-level security, because sign-in must find users): `users`, `password_credentials`, `totp_credentials` (secret encrypted with AES-256-GCM), `recovery_codes` (argon2id), `passkeys`, `sessions` + `refresh_tokens` (single-use, reuse revokes the session), `audit_events`, and `share_links` (a visitor's link is looked up by its token before anyone is known; every owner query filters on `user_id`).
- **Library** (row-level security on `user_id`): `assets` (one per unique content per user), `file_entries` (an asset placed in a folder; an asset can appear in many), `folders` (tree under a per-user root), `asset_origins` (every source path it was found at), `derivatives`, `upload_sessions`, `usage_snapshots`, `albums` + `album_items`, `deleted_content` (content deleted for good), `duplicate_dismissals`.
- **Reference data** (no user data, read-only for the app role): `places`, GeoNames "cities1000" (CC BY 4.0), loaded with `pnpm vault-admin load-places`.

## Browsing (Phase 2)

- **Capture time.** `assets.local_at` is the wall-clock time a photo was taken (EXIF time with its offset, or the owner's time zone when that is all there is). A trigger keeps it current, so the timeline groups by the day the photo was actually taken wherever it was taken.
- **Places.** The nearest GeoNames place within about 150 km of a photo's GPS position, found inside Postgres (pgvector nearest-neighbour on unit vectors). Coordinates are never sent to an online geocoder.
- **Search.** `assets.search_tsv` holds the file name, place, every original path (so folder names like WhatsApp or Screenshots match), camera and kind. Triggers on `assets` and `asset_origins` keep it current. Queries match word prefixes ("kora" finds Koraput) plus a trigram match on file names; filters cover type, dates, place, camera, source and map area.
- **Media links.** Thumbnails and originals are fetched straight from S3 with presigned GET links. They are signed against the start of the hour, so the same image keeps the same link for an hour and the browser cache works, and expire within three hours.
- **Endpoints.** `GET /v1/timeline` (months with per-day counts, so the web app lays out the whole timeline before loading it), `/v1/timeline/{YYYY-MM}`, `/v1/assets` (search, keyset pages), `/v1/assets/{id}`, `/v1/search/facets`, `/v1/folders[/{id}]`, `/v1/map/points`, `/v1/memories/on-this-day`.

## Sign-in

| Path                                | Needs                          | Notes                                                            |
| ----------------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| Passkey (fingerprint/face, YubiKey) | A registered authenticator     | Primary on web and mobile (Phase 2/3); bound to the app's domain |
| Password + TOTP                     | Password and authenticator app | CLI sign-in in Phase 1                                           |
| Recovery code                       | One of 10 printed codes        | Works without password, phone or email; each code works once     |

Access tokens are EdDSA JWTs valid for 10 minutes. Refresh tokens rotate on every use and are stored only as hashes. Signing a device out takes effect immediately.

## Video, motion photos, downloads (Phase 2, M2)

- **Streaming versions.** A `transcode` job (after ingest; `vault-admin transcode-backfill` for older videos) makes 360p, 720p and 1080p H.264/AAC renditions, named by their short side and never larger than the original. One ffmpeg run decodes once, applies rotation and tone-maps HDR (PQ, HLG) to BT.709 after shrinking. Threads are capped so 4K HDR fits the Docker VM's memory, and ffmpeg runs at low CPU priority. Each rendition is a single fragmented MP4 that its HLS playlist addresses by byte range; the playlist, bandwidth and codecs are kept on the derivative row (`details`).
- **Playback.** `GET /v1/assets/{id}/stream.m3u8` lists the renditions; `/stream/{quality}.m3u8` returns a rendition's playlist with a presigned link to its file, which the player reads by range straight from S3 (the bucket's CORS rule allows it). The web player is Vidstack with hls.js bundled (never loaded from a CDN) and no Cast button. Until a stream exists, the original plays.
- **Queue order.** Transcode-queue priorities: 1 motion clips (seconds each), 2 videos with a local copy, 3 videos that must be downloaded. The worker looks for a local copy at each of the file's origins (laptop mount, `staging/{device}-{label}/`) before downloading.
- **Motion photos.** The clip Samsung and Google append to a photo is found by its own `ftyp` box, measured by walking the MP4's top-level boxes (so a HEIC image or Samsung's trailer around it doesn't matter), and turned into an H.264 clip of up to 720p.
- **Downloads.** Originals download under their own names (a presigned link with `Content-Disposition: attachment`). Zips of chosen files or a folder are prepared with `POST /v1/downloads` (files checked against the caller's library), then streamed by `GET /v1/downloads/{id}` straight from S3. The zip writer stores rather than compresses, so the exact size is known up front and sent as `Content-Length` (real progress in the browser). Zip64 takes over where needed, and a file that isn't its recorded size cuts the download off rather than leaving a corrupt archive.
- **Uploads from the browser.** The web app uses the same upload API as the CLI. Each file is hashed in a Web Worker (hash-wasm, streaming); known content only gets its location recorded; new files go to S3 through presigned requests (parts with their own SHA-256). Choosing a file again after a reload continues from the parts S3 already has. Files are recorded under the source `web:browser`.
- **Export.** `vault export <folder>` writes every original back into its source folders with its name and date (extra locations as hard links), checks each against its SHA-256, resumes with range requests, and adds `catalogue.json` and a README. It reads `GET /v1/export` (the library a page at a time, with presigned links).

## Organise, share and protect (Phase 2, M3)

- **Favourites and albums.** `assets.favorite_at`; `albums` and `album_items` hold references, never files, so a photo can be in any number of albums and deleting an album leaves its photos alone. Every list goes through the same `visible()` condition, so trashed items never count or show.
- **Trash.** Moving to Trash sets `assets.deleted_at`. The nightly `trash-purge` job (03:30 India time), or "Delete now" (`purge_requested_at`), deletes what is due: each S3 object (original, previews, streams) gets a delete marker, the original first, so if S3 refuses nothing of the item is touched and the reason is kept in `purge_error`. Then the rows go and `deleted_content` records the content. The versions stay recoverable for 30 more days: Object Lock (governance, 30 days) stops early deletion and the `expire-old-versions` rule removes them later ([setup](setup/phase-2-aws-setup.md), [recovery](runbook-restore.md#3b-recover-a-file-deleted-from-trash)).
- **Deleted content stays deleted.** `POST /v1/uploads/check` also answers `trashed` and `deleted`. The CLI records such files as "In your Trash" or "Deleted by you" and uploads them again only with `--include-deleted`; the browser offers "Upload anyway". Uploading on purpose clears the record. The nightly catalogue carries Trash state, favourites and albums, so `rebuild-index` restores them.
- **Share links.** A link covers a photo, an album or a folder subtree. Its token is 32 random bytes; the table keeps its SHA-256 for lookups and an AES-256-GCM copy so the owner can copy it again. Passwords are argon2id; the right one gives a 12-hour HMAC-signed session bound to the link and its password, kept by the web app in an httpOnly cookie scoped to that link's gateway path (`/api/share/{token}`), which never carries the owner's tokens. The public API (`/v1/public/shares/{token}/…`) reads with the owner's row-level security and checks every asset against the link's scope in SQL. It shows capture dates and previews only (no places, camera details, folder paths, or names unless downloads are allowed), gives one answer for unknown, expired and turned-off links, rate-limits per address and per password guess, and ties zips made through a link to that link.
- **Near-duplicates.** `GET /v1/duplicates` groups visible photos (and videos within a second of the same length) by the 64-bit perceptual hash. The hash is cut into 7 bands, so any pair within 6 bits shares a band (pigeonhole); candidates are compared with integer popcounts, joined with union-find, then split around centres taken best copy first (most pixels, then largest file), so every member is within 6 bits of the copy it is grouped with. About 0.2 s for 20,000 items. "Not duplicates" stores the pairs in `duplicate_dismissals`.
- **Activity.** `audit_events` also records Trash, restores and deletions, links (made, opened at most hourly per visitor, turned off, wrong passwords, downloads), zip and original downloads (originals go through a logged redirect, `GET /v1/assets/{id}/original`) and exports. `GET /v1/activity` pages the caller's own events by time.

## Upload flow

1. The CLI scans a source: walk, SHA-256, junk rules, manifest (SQLite).
2. `POST /v1/uploads/check` finds content already stored. Its locations are recorded with `POST /v1/assets/origins`.
3. For new content, `POST /v1/uploads` returns either a presigned single PUT (≤ 16 MiB) or a multipart upload. Parts are presigned with their SHA-256 (`POST /v1/uploads/{id}/parts`).
4. `POST /v1/uploads/{id}/complete` makes the API check size and checksum with S3, then mark the asset verified, record its origin and mirrored folder entry, and queue `ingest`.
5. The worker extracts EXIF, generates WebP previews and computes a perceptual hash. It prefers a local copy, trusted only if its size and SHA-256 match: the uploader's file (read-only mount) or, for a phone, a copy `vault phone stage-pending` put in staging. Otherwise it downloads the original from S3. S3 requests give up after 10 s connecting or 2 minutes without data, so a stalled download fails and is retried instead of holding a worker slot.

Files waiting for the worker: `GET /v1/processing/pending?source=…` lists them with their paths in that source, and `POST /v1/processing/status` reports which are done. `vault phone stage-pending` uses both: it pulls those files from the phone (read-only) a few GB ahead of the worker, at the path each waiting job already looks at, and deletes each copy once its file is processed. The viewer shows the original of a waiting photo when the browser can display it.

Resume: re-running finds the open upload session and asks S3 which parts it already has.
