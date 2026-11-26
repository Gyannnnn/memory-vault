-- Near-duplicate finder (Phase 2, M3): pairs the owner said are not duplicates. Additive only.

CREATE TABLE "duplicate_dismissals" (
    "user_id" UUID NOT NULL,
    "asset_a" UUID NOT NULL,
    "asset_b" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "duplicate_dismissals_pkey" PRIMARY KEY ("user_id", "asset_a", "asset_b"),
    CONSTRAINT "duplicate_dismissals_ordered" CHECK ("asset_a" < "asset_b")
);

ALTER TABLE "duplicate_dismissals" ADD CONSTRAINT "duplicate_dismissals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "duplicate_dismissals" ADD CONSTRAINT "duplicate_dismissals_asset_a_fkey" FOREIGN KEY ("asset_a") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "duplicate_dismissals" ADD CONSTRAINT "duplicate_dismissals_asset_b_fkey" FOREIGN KEY ("asset_b") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "duplicate_dismissals" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "duplicate_dismissals"
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
