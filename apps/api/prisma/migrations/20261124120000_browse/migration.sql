-- Browsing (Phase 2, M1): wall-clock capture time, places from GPS, full-text search.
-- Everything here is additive. Triggers keep the derived columns current, so every
-- code path that writes assets or origins (uploads, ingest, S3 events, rebuild) is covered.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── Places: GeoNames cities1000 (CC BY 4.0), the same for every user ─────────

CREATE TABLE "places" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "ascii_name" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "position" vector(3) NOT NULL,
    "country_code" TEXT NOT NULL,
    "country_name" TEXT,
    "admin1_name" TEXT,
    "population" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "places_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "places_position_idx" ON "places" USING hnsw ("position" vector_l2_ops);

-- Reference data is written only by the owner role (vault-admin load-places).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vault_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "places" FROM vault_app;
    GRANT SELECT ON "places" TO vault_app;
  END IF;
END $$;

-- A point on the unit sphere; straight-line distance between two of these grows with
-- the great-circle distance, so nearest-neighbour search finds the nearest place.
CREATE FUNCTION geo_vector(lat DOUBLE PRECISION, lng DOUBLE PRECISION) RETURNS vector
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT ARRAY[
    cos(radians(lat)) * cos(radians(lng)),
    cos(radians(lat)) * sin(radians(lng)),
    sin(radians(lat))
  ]::vector
$$;

-- The nearest place within about 150 km, or NULL (open sea, remote areas, no places loaded).
CREATE FUNCTION nearest_place(lat DOUBLE PRECISION, lng DOUBLE PRECISION) RETURNS INTEGER
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nearest.id
  FROM (
    SELECT p.id, p.position <-> geo_vector(lat, lng) AS distance
    FROM places p
    ORDER BY p.position <-> geo_vector(lat, lng)
    LIMIT 1
  ) nearest
  WHERE nearest.distance < 0.0236
$$;

-- ─── Assets: new columns ─────────────────────────────────────────────────────

ALTER TABLE "assets"
    ADD COLUMN "local_at" TIMESTAMP(3),
    ADD COLUMN "place_id" INTEGER,
    ADD COLUMN "search_tsv" tsvector;

ALTER TABLE "assets" ADD CONSTRAINT "assets_place_id_fkey"
    FOREIGN KEY ("place_id") REFERENCES "places"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "assets_user_id_local_at_id_idx" ON "assets"("user_id", "local_at" DESC, "id" DESC);
CREATE INDEX "assets_user_id_place_id_idx" ON "assets"("user_id", "place_id");
CREATE INDEX "assets_search_tsv_idx" ON "assets" USING gin ("search_tsv");
CREATE INDEX "assets_original_name_trgm_idx" ON "assets" USING gin ("original_name" gin_trgm_ops);

-- ─── local_at: the wall-clock time the photo was taken ───────────────────────
-- With a known UTC offset (EXIF, or the owner's zone applied at ingest) that is exact.
-- Otherwise (not yet processed, or only a file date) the owner's time zone is used.

CREATE FUNCTION assets_local_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.taken_at IS NOT NULL AND NEW.taken_at_offset_minutes IS NOT NULL THEN
    NEW.local_at := (NEW.taken_at AT TIME ZONE 'UTC') + make_interval(mins => NEW.taken_at_offset_minutes);
  ELSE
    NEW.local_at := coalesce(NEW.taken_at, NEW.original_modified_at, NEW.created_at)
      AT TIME ZONE coalesce((SELECT u.timezone FROM users u WHERE u.id = NEW.user_id), 'UTC');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "assets_local_time"
    BEFORE INSERT OR UPDATE OF taken_at, taken_at_offset_minutes, original_modified_at ON "assets"
    FOR EACH ROW EXECUTE FUNCTION assets_local_time();

-- ─── search_tsv: file name, place, original paths, camera, kind ──────────────

-- "DCIM/Camera/IMG_20250101.jpg" → "dcim camera img 20250101 jpg", so each part is a word.
CREATE FUNCTION search_words(input TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT trim(regexp_replace(lower(coalesce(input, '')), '[^[:alnum:]]+', ' ', 'g'))
$$;

CREATE FUNCTION asset_search_document(
  p_asset_id UUID, p_name TEXT, p_kind TEXT, p_make TEXT, p_model TEXT, p_place_id INTEGER
) RETURNS tsvector LANGUAGE sql STABLE AS $$
  SELECT
    setweight(to_tsvector('simple', search_words(p_name)), 'A')
    || setweight(to_tsvector('simple', search_words((
         SELECT concat_ws(' ', p.name, p.ascii_name, p.admin1_name, p.country_name)
         FROM places p WHERE p.id = p_place_id))), 'A')
    || setweight(to_tsvector('simple', search_words((
         SELECT string_agg(o.original_path, ' ') FROM asset_origins o WHERE o.asset_id = p_asset_id))), 'B')
    || setweight(to_tsvector('simple', search_words(concat_ws(' ', p_make, p_model))), 'C')
    || setweight(to_tsvector('simple', coalesce(p_kind, '')), 'D')
$$;

CREATE FUNCTION assets_search_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv := asset_search_document(
    NEW.id, NEW.original_name, NEW.kind::text, NEW.camera_make, NEW.camera_model, NEW.place_id);
  RETURN NEW;
END $$;

CREATE TRIGGER "assets_search"
    BEFORE INSERT OR UPDATE OF original_name, kind, camera_make, camera_model, place_id ON "assets"
    FOR EACH ROW EXECUTE FUNCTION assets_search_refresh();

CREATE FUNCTION asset_origins_search_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE assets a
       SET search_tsv = asset_search_document(a.id, a.original_name, a.kind::text, a.camera_make, a.camera_model, a.place_id)
     WHERE a.id = NEW.asset_id;
  END IF;
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.asset_id <> NEW.asset_id) THEN
    UPDATE assets a
       SET search_tsv = asset_search_document(a.id, a.original_name, a.kind::text, a.camera_make, a.camera_model, a.place_id)
     WHERE a.id = OLD.asset_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER "asset_origins_search"
    AFTER INSERT OR UPDATE OR DELETE ON "asset_origins"
    FOR EACH ROW EXECUTE FUNCTION asset_origins_search_refresh();

-- ─── Backfill existing rows (assigning a column to itself fires the triggers) ─

UPDATE "assets" SET "taken_at" = "taken_at", "original_name" = "original_name";
