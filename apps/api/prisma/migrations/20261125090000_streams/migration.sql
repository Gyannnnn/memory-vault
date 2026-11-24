-- Video renditions (HLS) keep their playlist, bandwidth and codecs with the derivative row.
ALTER TABLE "derivatives" ADD COLUMN "details" JSONB;
