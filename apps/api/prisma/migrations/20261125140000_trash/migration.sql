-- Trash (Phase 2, M3): purge bookkeeping and a record of content deleted for good. Additive only.

ALTER TABLE "assets" ADD COLUMN "purge_requested_at" TIMESTAMPTZ(3);
ALTER TABLE "assets" ADD COLUMN "purge_error" TEXT;
CREATE INDEX "assets_trash_idx" ON "assets" ("user_id", "deleted_at" DESC, "id" DESC) WHERE "deleted_at" IS NOT NULL;

CREATE TABLE "deleted_content" (
    "user_id" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "trashed_at" TIMESTAMPTZ(3) NOT NULL,
    "purged_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deleted_content_pkey" PRIMARY KEY ("user_id", "sha256")
);

ALTER TABLE "deleted_content" ADD CONSTRAINT "deleted_content_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "deleted_content" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "deleted_content"
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
