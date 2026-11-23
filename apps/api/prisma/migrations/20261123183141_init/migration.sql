-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended', 'deleted');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('photo', 'raw', 'video', 'audio', 'document', 'other');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('uploading', 'verified', 'missing');

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('uploading', 'completed', 'aborted', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "storage_quota_bytes" BIGINT NOT NULL,
    "storage_used_bytes" BIGINT NOT NULL DEFAULT 0,
    "plan_code" TEXT NOT NULL DEFAULT 'personal',
    "billing_customer_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_credentials" (
    "user_id" UUID NOT NULL,
    "hash" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "password_credentials_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "totp_credentials" (
    "user_id" UUID NOT NULL,
    "secret_ciphertext" BYTEA NOT NULL,
    "last_used_step" BIGINT,
    "confirmed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "totp_credentials_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passkeys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL,
    "transports" TEXT[],
    "device_type" TEXT NOT NULL,
    "backed_up" BOOLEAN NOT NULL,
    "nickname" TEXT NOT NULL,
    "aaguid" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),

    CONSTRAINT "passkeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_name" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "auth_method" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "hash" TEXT NOT NULL,
    "session_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "type" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "extension" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "original_modified_at" TIMESTAMPTZ(3),
    "s3_key" TEXT NOT NULL,
    "s3_version_id" TEXT,
    "s3_checksum_sha256" TEXT,
    "storage_class" TEXT NOT NULL DEFAULT 'INTELLIGENT_TIERING',
    "status" "AssetStatus" NOT NULL DEFAULT 'uploading',
    "verified_at" TIMESTAMPTZ(3),
    "last_seen_in_s3_at" TIMESTAMPTZ(3),
    "taken_at" TIMESTAMPTZ(3),
    "taken_at_offset_minutes" INTEGER,
    "gps_latitude" DOUBLE PRECISION,
    "gps_longitude" DOUBLE PRECISION,
    "gps_altitude" DOUBLE PRECISION,
    "camera_make" TEXT,
    "camera_model" TEXT,
    "lens_model" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "duration_ms" INTEGER,
    "is_motion_photo" BOOLEAN NOT NULL DEFAULT false,
    "phash" TEXT,
    "exif" JSONB,
    "processed_at" TIMESTAMPTZ(3),
    "processing_error" TEXT,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "derivatives" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "variant" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "derivatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_entries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "folder_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "file_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_origins" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "source_id" TEXT NOT NULL,
    "original_path" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "original_modified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_origins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "s3_upload_id" TEXT,
    "part_size_bytes" INTEGER,
    "part_count" INTEGER NOT NULL,
    "status" "UploadStatus" NOT NULL DEFAULT 'uploading',
    "origin" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_snapshots" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "taken_on" DATE NOT NULL,
    "storage_bytes" BIGINT NOT NULL,
    "object_count" INTEGER NOT NULL,

    CONSTRAINT "usage_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "recovery_codes_user_id_idx" ON "recovery_codes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "passkeys_credential_id_key" ON "passkeys"("credential_id");

-- CreateIndex
CREATE INDEX "passkeys_user_id_idx" ON "passkeys"("user_id");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");

-- CreateIndex
CREATE INDEX "audit_events_user_id_created_at_idx" ON "audit_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "assets_user_id_taken_at_id_idx" ON "assets"("user_id", "taken_at" DESC, "id");

-- CreateIndex
CREATE INDEX "assets_user_id_created_at_id_idx" ON "assets"("user_id", "created_at" DESC, "id");

-- CreateIndex
CREATE INDEX "assets_user_id_kind_idx" ON "assets"("user_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "assets_user_id_sha256_key" ON "assets"("user_id", "sha256");

-- CreateIndex
CREATE INDEX "derivatives_user_id_idx" ON "derivatives"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "derivatives_asset_id_variant_key" ON "derivatives"("asset_id", "variant");

-- CreateIndex
CREATE UNIQUE INDEX "folders_user_id_parent_id_name_key" ON "folders"("user_id", "parent_id", "name");

-- CreateIndex
CREATE INDEX "file_entries_user_id_folder_id_idx" ON "file_entries"("user_id", "folder_id");

-- CreateIndex
CREATE INDEX "file_entries_asset_id_idx" ON "file_entries"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "file_entries_folder_id_name_key" ON "file_entries"("folder_id", "name");

-- CreateIndex
CREATE INDEX "asset_origins_asset_id_idx" ON "asset_origins"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_origins_user_id_source_id_original_path_key" ON "asset_origins"("user_id", "source_id", "original_path");

-- CreateIndex
CREATE INDEX "upload_sessions_user_id_status_idx" ON "upload_sessions"("user_id", "status");

-- CreateIndex
CREATE INDEX "upload_sessions_asset_id_idx" ON "upload_sessions"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_snapshots_user_id_taken_on_key" ON "usage_snapshots"("user_id", "taken_on");

-- AddForeignKey
ALTER TABLE "password_credentials" ADD CONSTRAINT "password_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "totp_credentials" ADD CONSTRAINT "totp_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "derivatives" ADD CONSTRAINT "derivatives_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "derivatives" ADD CONSTRAINT "derivatives_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "folders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_entries" ADD CONSTRAINT "file_entries_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_entries" ADD CONSTRAINT "file_entries_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_entries" ADD CONSTRAINT "file_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_origins" ADD CONSTRAINT "asset_origins_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_origins" ADD CONSTRAINT "asset_origins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_snapshots" ADD CONSTRAINT "usage_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security: the app role only ever sees rows of the user set in the
-- transaction-local setting app.user_id. With no setting, it sees nothing.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'assets', 'derivatives', 'folders', 'file_entries', 'asset_origins', 'upload_sessions', 'usage_snapshots'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (user_id = NULLIF(current_setting(''app.user_id'', true), '''')::uuid)
         WITH CHECK (user_id = NULLIF(current_setting(''app.user_id'', true), '''')::uuid)',
      tbl
    );
  END LOOP;
END $$;
