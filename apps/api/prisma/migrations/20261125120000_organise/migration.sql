-- Organise (Phase 2, M3): favourites and albums. Additive only.

ALTER TABLE "assets" ADD COLUMN "favorite_at" TIMESTAMPTZ(3);
CREATE INDEX "assets_favorites_idx" ON "assets" ("user_id", "favorite_at" DESC) WHERE "favorite_at" IS NOT NULL;

CREATE TABLE "albums" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "cover_asset_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "albums_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "albums_name_length" CHECK (char_length("name") BETWEEN 1 AND 200)
);

CREATE INDEX "albums_user_id_updated_at_idx" ON "albums"("user_id", "updated_at" DESC);

CREATE TABLE "album_items" (
    "album_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "album_items_pkey" PRIMARY KEY ("album_id", "asset_id")
);

CREATE INDEX "album_items_asset_id_idx" ON "album_items"("asset_id");
CREATE INDEX "album_items_user_id_idx" ON "album_items"("user_id");

ALTER TABLE "albums" ADD CONSTRAINT "albums_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "albums" ADD CONSTRAINT "albums_cover_asset_id_fkey" FOREIGN KEY ("cover_asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "album_items" ADD CONSTRAINT "album_items_album_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "album_items" ADD CONSTRAINT "album_items_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "album_items" ADD CONSTRAINT "album_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same tenant isolation as the other library tables.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['albums', 'album_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (user_id = NULLIF(current_setting(''app.user_id'', true), '''')::uuid)
         WITH CHECK (user_id = NULLIF(current_setting(''app.user_id'', true), '''')::uuid)',
      tbl
    );
  END LOOP;
END $$;
