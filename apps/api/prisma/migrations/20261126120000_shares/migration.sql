-- Share links (Phase 2, M3). Additive only.
-- Outside row-level security on purpose (like the identity tables): a visitor's link is
-- looked up by its token hash before anyone is known. The API filters every owner query
-- on user_id and reads the shared photos with the owner's row-level security context.

CREATE TYPE "ShareKind" AS ENUM ('photo', 'album', 'folder');

CREATE TABLE "share_links" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_ciphertext" BYTEA NOT NULL,
    "kind" "ShareKind" NOT NULL,
    "target_id" UUID NOT NULL,
    "allow_download" BOOLEAN NOT NULL DEFAULT false,
    "password_hash" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "open_count" INTEGER NOT NULL DEFAULT 0,
    "last_opened_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "share_links_token_hash_key" ON "share_links"("token_hash");
CREATE INDEX "share_links_user_id_created_at_idx" ON "share_links"("user_id", "created_at" DESC);
CREATE INDEX "share_links_user_id_target_id_idx" ON "share_links"("user_id", "target_id");

ALTER TABLE "share_links" ADD CONSTRAINT "share_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
