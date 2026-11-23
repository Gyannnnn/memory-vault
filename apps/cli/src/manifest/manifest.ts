import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { FileRoute, MediaKind, ReviewReason, SourceId } from '@memory-vault/shared';

export const fileStatuses = [
  'pending',
  'uploaded',
  'deduplicated',
  'awaiting_review',
  'skipped',
  'excluded',
  'failed',
  'missing',
] as const;
export type FileStatus = (typeof fileStatuses)[number];

export type EntryType = 'file' | 'symlink' | 'other' | 'error';
export type SourceKind = 'local' | 'phone';

export interface SourceRow {
  id: SourceId;
  kind: SourceKind;
  root: string;
  deviceSerial: string | null;
  lastScanId: number | null;
}

export interface FileRow {
  sourceId: SourceId;
  path: string;
  entryType: EntryType;
  size: number | null;
  mtimeMs: number | null;
  mtimeNs: string | null;
  ino: string | null;
  sha256: string | null;
  kind: MediaKind | null;
  ext: string | null;
  route: FileRoute | null;
  reasons: ReviewReason[];
  selected: boolean;
  status: FileStatus;
  decision: 'approved' | 'skipped' | null;
  error: string | null;
  stagedPath: string | null;
}

export interface EntryUpsert {
  path: string;
  entryType: EntryType;
  size?: number | null;
  mtimeMs?: number | null;
  mtimeNs?: string | null;
  ino?: string | null;
  kind?: MediaKind | null;
  ext?: string | null;
  route?: FileRoute | null;
  reasons?: ReviewReason[];
  error?: string | null;
  sha256?: string | null;
  defaultSelected?: boolean;
}

const migrations: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    root TEXT NOT NULL,
    device_serial TEXT,
    created_at INTEGER NOT NULL,
    last_scan_id INTEGER
  );
  CREATE TABLE scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL REFERENCES sources(id),
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    entries INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE files (
    source_id TEXT NOT NULL REFERENCES sources(id),
    path TEXT NOT NULL,
    entry_type TEXT NOT NULL,
    size INTEGER,
    mtime_ms INTEGER,
    mtime_ns TEXT,
    ino TEXT,
    sha256 TEXT,
    hashed_size INTEGER,
    hashed_mtime_ns TEXT,
    kind TEXT,
    ext TEXT,
    route TEXT,
    reasons TEXT NOT NULL DEFAULT '[]',
    selected INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    decision TEXT,
    error TEXT,
    staged_path TEXT,
    last_seen_scan INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, path)
  );
  CREATE INDEX files_sha256 ON files (sha256);
  CREATE INDEX files_source_status ON files (source_id, status);
  `,
];

type Row = Record<string, unknown>;

function toFileRow(row: Row): FileRow {
  return {
    sourceId: row.source_id as string,
    path: row.path as string,
    entryType: row.entry_type as EntryType,
    size: row.size as number | null,
    mtimeMs: row.mtime_ms as number | null,
    mtimeNs: row.mtime_ns as string | null,
    ino: row.ino as string | null,
    sha256: row.sha256 as string | null,
    kind: row.kind as MediaKind | null,
    ext: row.ext as string | null,
    route: row.route as FileRoute | null,
    reasons: JSON.parse(row.reasons as string) as ReviewReason[],
    selected: row.selected === 1,
    status: row.status as FileStatus,
    decision: row.decision as FileRow['decision'],
    error: row.error as string | null,
    stagedPath: row.staged_path as string | null,
  };
}

export class Manifest {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const current = (this.db.prepare('SELECT version FROM schema_version').get()?.version as number) ?? 0;
    for (let version = current; version < migrations.length; version += 1) {
      this.transaction(() => {
        this.db.exec(migrations[version]!);
        this.db.exec('DELETE FROM schema_version');
        this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version + 1);
      });
    }
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  getSource(id: SourceId): SourceRow | undefined {
    const row = this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
    if (!row) return undefined;
    return {
      id: row.id as string,
      kind: row.kind as SourceKind,
      root: row.root as string,
      deviceSerial: row.device_serial as string | null,
      lastScanId: row.last_scan_id as number | null,
    };
  }

  listSources(): SourceRow[] {
    return this.db
      .prepare('SELECT id FROM sources ORDER BY created_at')
      .all()
      .map((row) => this.getSource(row.id as string)!);
  }

  registerSource(source: { id: SourceId; kind: SourceKind; root: string; deviceSerial?: string }): SourceRow {
    const existing = this.getSource(source.id);
    if (existing) {
      if (existing.root !== source.root || existing.kind !== source.kind) {
        throw new Error(
          `source ${source.id} is already registered for ${existing.kind} ${existing.root}; use a different source id`,
        );
      }
      return existing;
    }
    this.db
      .prepare('INSERT INTO sources (id, kind, root, device_serial, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(source.id, source.kind, source.root, source.deviceSerial ?? null, Date.now());
    return this.getSource(source.id)!;
  }

  startScan(sourceId: SourceId): number {
    const result = this.db
      .prepare('INSERT INTO scans (source_id, started_at) VALUES (?, ?)')
      .run(sourceId, Date.now());
    return Number(result.lastInsertRowid);
  }

  finishScan(sourceId: SourceId, scanId: number): { missing: number } {
    return this.transaction(() => {
      const entries = this.db
        .prepare('SELECT COUNT(*) AS n FROM files WHERE source_id = ? AND last_seen_scan = ?')
        .get(sourceId, scanId)!.n as number;
      this.db
        .prepare('UPDATE scans SET finished_at = ?, entries = ? WHERE id = ?')
        .run(Date.now(), entries, scanId);
      this.db.prepare('UPDATE sources SET last_scan_id = ? WHERE id = ?').run(scanId, sourceId);
      const missing = this.db
        .prepare(
          `UPDATE files SET status = 'missing', updated_at = ?
           WHERE source_id = ? AND last_seen_scan < ? AND status NOT IN ('uploaded', 'deduplicated', 'missing')`,
        )
        .run(Date.now(), sourceId, scanId);
      return { missing: Number(missing.changes) };
    });
  }

  /**
   * Inserts or refreshes entries seen during a scan. A file whose size or mtime
   * changed since it was hashed loses its hash so it gets hashed again.
   */
  upsertEntries(sourceId: SourceId, scanId: number, entries: EntryUpsert[]): void {
    const statement = this.db.prepare(`
      INSERT INTO files (
        source_id, path, entry_type, size, mtime_ms, mtime_ns, ino, sha256, kind, ext, route, reasons,
        selected, status, error, last_seen_scan, updated_at
      ) VALUES (
        $source, $path, $entryType, $size, $mtimeMs, $mtimeNs, $ino, $sha256, $kind, $ext, $route, $reasons,
        $selected, $status, $error, $scan, $now
      )
      ON CONFLICT (source_id, path) DO UPDATE SET
        entry_type = excluded.entry_type,
        sha256 = CASE
          WHEN excluded.sha256 IS NOT NULL THEN excluded.sha256
          WHEN files.hashed_size IS excluded.size AND files.hashed_mtime_ns IS excluded.mtime_ns THEN files.sha256
          ELSE NULL END,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        mtime_ns = excluded.mtime_ns,
        ino = excluded.ino,
        kind = excluded.kind,
        ext = excluded.ext,
        route = excluded.route,
        reasons = excluded.reasons,
        error = excluded.error,
        status = CASE WHEN files.status = 'missing' THEN 'pending' ELSE files.status END,
        last_seen_scan = excluded.last_seen_scan,
        updated_at = excluded.updated_at
    `);
    const now = Date.now();
    this.transaction(() => {
      for (const entry of entries) {
        const params: Record<string, SQLInputValue> = {
          source: sourceId,
          path: entry.path,
          entryType: entry.entryType,
          size: entry.size ?? null,
          mtimeMs: entry.mtimeMs ?? null,
          mtimeNs: entry.mtimeNs ?? null,
          ino: entry.ino ?? null,
          sha256: entry.sha256 ?? null,
          kind: entry.kind ?? null,
          ext: entry.ext ?? null,
          route: entry.route ?? null,
          reasons: JSON.stringify(entry.reasons ?? []),
          selected: entry.defaultSelected === false ? 0 : 1,
          status: entry.defaultSelected === false ? 'excluded' : 'pending',
          error: entry.error ?? null,
          scan: scanId,
          now,
        };
        statement.run(params);
      }
    });
  }

  filesNeedingHash(sourceId: SourceId): FileRow[] {
    return this.db
      .prepare(
        `SELECT * FROM files WHERE source_id = ? AND entry_type = 'file' AND sha256 IS NULL
         AND status != 'missing' AND selected = 1 ORDER BY path`,
      )
      .all(sourceId)
      .map(toFileRow);
  }

  setHash(sourceId: SourceId, path: string, sha256: string, size: number, mtimeNs: string | null): void {
    this.db
      .prepare(
        `UPDATE files SET sha256 = ?, hashed_size = ?, hashed_mtime_ns = ?, error = NULL, updated_at = ?
         WHERE source_id = ? AND path = ?`,
      )
      .run(sha256, size, mtimeNs, Date.now(), sourceId, path);
  }

  setError(sourceId: SourceId, path: string, error: string): void {
    this.db
      .prepare('UPDATE files SET error = ?, updated_at = ? WHERE source_id = ? AND path = ?')
      .run(error, Date.now(), sourceId, path);
  }

  files(sourceId: SourceId): FileRow[] {
    return this.db
      .prepare('SELECT * FROM files WHERE source_id = ? ORDER BY path')
      .all(sourceId)
      .map(toFileRow);
  }

  setSelected(sourceId: SourceId, pathPrefix: string, selected: boolean): number {
    const prefix = pathPrefix.replace(/\/+$/, '');
    const result = this.db
      .prepare(
        `UPDATE files SET selected = ?, updated_at = ?,
           status = CASE
             WHEN ? = 0 AND status = 'pending' THEN 'excluded'
             WHEN ? = 1 AND status = 'excluded' THEN 'pending'
             ELSE status END
         WHERE source_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')`,
      )
      .run(
        selected ? 1 : 0,
        Date.now(),
        selected ? 1 : 0,
        selected ? 1 : 0,
        sourceId,
        prefix,
        `${prefix.replace(/[\\%_]/g, (match) => `\\${match}`)}/%`,
      );
    return Number(result.changes);
  }
}
