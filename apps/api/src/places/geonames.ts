import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { Db } from '../db';

/**
 * GeoNames "cities1000": every place with at least 1,000 people (about 150,000),
 * with state and country names. Licence: CC BY 4.0 — attribution "GeoNames".
 * Photos' coordinates are matched against this table inside Postgres; they are
 * never sent to an online geocoding service.
 */
export const GEONAMES_BASE = 'https://download.geonames.org/export/dump';
export const GEONAMES_FILES = ['cities1000.zip', 'admin1CodesASCII.txt', 'countryInfo.txt'] as const;

export interface PlaceRow {
  id: number;
  name: string;
  asciiName: string;
  latitude: number;
  longitude: number;
  countryCode: string;
  countryName: string | null;
  admin1Name: string | null;
  population: number;
}

/** Reads the single file inside a small (non-ZIP64) archive such as cities1000.zip. */
export function unzipSingle(archive: Buffer, wanted: string): Buffer {
  let end = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip archive');
  const entries = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  for (let index = 0; index < entries; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name !== wanted) continue;
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('corrupt zip entry');
    const dataStart =
      localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const data = archive.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data);
    throw new Error(`unsupported zip compression method ${method}`);
  }
  throw new Error(`${wanted} is not in the archive`);
}

const rows = (text: string) =>
  text
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('\t'));

export function parsePlaces(cities: string, admin1Codes: string, countryInfo: string): PlaceRow[] {
  const admin1 = new Map(rows(admin1Codes).map(([code, name]) => [code!, name!]));
  const countries = new Map(rows(countryInfo).map((columns) => [columns[0]!, columns[4]!]));
  const places: PlaceRow[] = [];
  for (const columns of rows(cities)) {
    const [id, name, asciiName, , latitude, longitude, , , countryCode, , admin1Code, , , , population] =
      columns;
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!id || !name || !countryCode || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    places.push({
      id: Number(id),
      name,
      asciiName: asciiName || name,
      latitude: lat,
      longitude: lng,
      countryCode,
      countryName: countries.get(countryCode) ?? null,
      admin1Name: admin1.get(`${countryCode}.${admin1Code}`) ?? null,
      population: Number(population) || 0,
    });
  }
  return places;
}

/** Downloads (or reads from `directory`) the three GeoNames files. */
export async function readGeonames(
  directory?: string,
): Promise<{ cities: string; admin1: string; countries: string }> {
  const get = async (file: (typeof GEONAMES_FILES)[number]): Promise<Buffer> => {
    if (directory) return readFile(join(directory, file));
    const response = await fetch(`${GEONAMES_BASE}/${file}`);
    if (!response.ok) throw new Error(`GeoNames download of ${file} failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const [zip, admin1, countries] = await Promise.all(GEONAMES_FILES.map(get));
  return {
    cities: unzipSingle(zip!, 'cities1000.txt').toString('utf8'),
    admin1: admin1!.toString('utf8'),
    countries: countries!.toString('utf8'),
  };
}

/** Inserts or refreshes places. Needs the owner connection: the app role can only read this table. */
export async function savePlaces(owner: Db, places: PlaceRow[], batchSize = 5000): Promise<void> {
  for (let start = 0; start < places.length; start += batchSize) {
    const batch = places.slice(start, start + batchSize);
    await owner.$executeRaw`
      INSERT INTO places (id, name, ascii_name, latitude, longitude, position, country_code, country_name, admin1_name, population)
      SELECT t.id, t.name, t.ascii_name, t.latitude, t.longitude, geo_vector(t.latitude, t.longitude),
             t.country_code, t.country_name, t.admin1_name, t.population
      FROM unnest(
        ${batch.map((place) => place.id)}::int[],
        ${batch.map((place) => place.name)}::text[],
        ${batch.map((place) => place.asciiName)}::text[],
        ${batch.map((place) => place.latitude)}::float8[],
        ${batch.map((place) => place.longitude)}::float8[],
        ${batch.map((place) => place.countryCode)}::text[],
        ${batch.map((place) => place.countryName)}::text[],
        ${batch.map((place) => place.admin1Name)}::text[],
        ${batch.map((place) => place.population)}::bigint[]
      ) AS t(id, name, ascii_name, latitude, longitude, country_code, country_name, admin1_name, population)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, ascii_name = EXCLUDED.ascii_name,
        latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, position = EXCLUDED.position,
        country_code = EXCLUDED.country_code, country_name = EXCLUDED.country_name,
        admin1_name = EXCLUDED.admin1_name, population = EXCLUDED.population`;
  }
}

/** Gives every asset with GPS its nearest place (all users; owner connection). Returns how many have one. */
export async function geocodeAllAssets(owner: Db): Promise<{ withGps: number; placed: number }> {
  await owner.$executeRaw`
    UPDATE assets SET place_id = nearest_place(gps_latitude, gps_longitude)
    WHERE gps_latitude IS NOT NULL AND gps_longitude IS NOT NULL`;
  const [counts] = await owner.$queryRaw<{ with_gps: number; placed: number }[]>`
    SELECT count(*) FILTER (WHERE gps_latitude IS NOT NULL)::int AS with_gps,
           count(place_id)::int AS placed
    FROM assets`;
  return { withGps: counts?.with_gps ?? 0, placed: counts?.placed ?? 0 };
}
