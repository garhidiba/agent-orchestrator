import { redactEvidence } from './evidence.ts';
import { transitionEvents } from './events.ts';
import type { SemanticEvent } from './events.ts';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { id, requireCondition } from '../../../protocol/src/runtime.ts';

export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) =>
  item !== null && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest('hex');

export type SnapshotKind = 'config' | 'catalog' | 'model' | 'attempt';
export type StateSnapshot = { kind: SnapshotKind; key: string; hash: string; createdAt: string; value: unknown; redacted: boolean };

const tableDefinitions = {
  metadata: 'CREATE TABLE metadata(version INTEGER NOT NULL)',
  runs: 'CREATE TABLE runs(id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL)',
  events: 'CREATE TABLE events(sequence INTEGER PRIMARY KEY, run_id TEXT NOT NULL, type TEXT NOT NULL, timestamp TEXT NOT NULL, payload TEXT NOT NULL)',
  operations: 'CREATE TABLE operations(run_id TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, result TEXT, input TEXT, snapshot TEXT, PRIMARY KEY(run_id,id))',
  snapshots: 'CREATE TABLE snapshots(run_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, timestamp TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,kind,key))',
};
const normalizeDefinition = (sql: string) => sql.replace(/\bIF\s+NOT\s+EXISTS\b/gi, '').toUpperCase()
  .replace(/\s+/g, ' ').replace(/\s*([(),;])\s*/g, '$1').trim().replace(/;$/, '');

// Version three only added snapshots; older pinned bundles must still read and write the core tables.
function requireCompatibleSchema(database: DatabaseSync) {
  const version = (database.prepare('SELECT version FROM metadata').get() as { version: number }).version;
  requireCondition(version <= 3, 'STATE_VERSION_UNSUPPORTED');
  if (version !== 3) return;
  for (const [table, expected] of Object.entries(tableDefinitions)) {
    const sql = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
    requireCondition(typeof sql === 'string' && normalizeDefinition(sql) === normalizeDefinition(expected) &&
      database.prepare(`PRAGMA index_list(${table})`).all().every(row => row.origin === 'pk') &&
      !database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?").get(table), 'STATE_VERSION_UNSUPPORTED');
  }
}

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      requireCondition(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'STATE_PATH_UNSAFE');
      if (lstatSync(path).size > 0) {
        const probe = new DatabaseSync(path, { readOnly: true });
        try {
          requireCondition(probe.prepare('PRAGMA application_id').get()?.application_id === 0x4f524348, 'STATE_DATABASE_UNOWNED');
          requireCompatibleSchema(probe);
        } finally { probe.close(); }
      }
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA application_id=0x4f524348');
    const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'").get();
    if (existing) requireCompatibleSchema(this.db);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      ${Object.values(tableDefinitions).map(sql => sql.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS')).join(';')};
      INSERT INTO metadata SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM metadata);`);
    const columns = this.db.prepare('PRAGMA table_info(operations)').all().map(row => row.name);
    if (!columns.includes('input')) this.db.exec('ALTER TABLE operations ADD COLUMN input TEXT');
    if (!columns.includes('snapshot')) this.db.exec('ALTER TABLE operations ADD COLUMN snapshot TEXT');
    this.db.exec('UPDATE metadata SET version=2');
  }
  create(id: string, data: unknown) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO runs VALUES(?,0,?)').run(id, JSON.stringify(data));
      this.event(id, 'run.created', {});
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get<T>(id: string): { version: number; data: T } {
    const row = this.db.prepare('SELECT version,data FROM runs WHERE id=?').get(id) as { version: number; data: string } | undefined;
    requireCondition(row, 'RUN_NOT_FOUND');
    return { version: row.version, data: JSON.parse(row.data) as T };
  }
  list() { return this.db.prepare('SELECT id,version,data FROM runs').all().map(row => ({ id: row.id, version: row.version, data: JSON.parse(row.data as string) as unknown })); }
  event(run: string, type: string, payload: unknown) {
    this.db.prepare('INSERT INTO events(run_id,type,timestamp,payload) VALUES(?,?,?,?)').run(run, type, new Date().toISOString(), JSON.stringify(redactEvidence(payload)));
  }
  events(run: string) {
    return this.db.prepare('SELECT sequence,type,timestamp,payload FROM events WHERE run_id=? ORDER BY sequence').all(run).map(row => ({
      sequence: row.sequence as number, type: row.type as string, timestamp: row.timestamp as string, payload: JSON.parse(row.payload as string) as unknown,
    }));
  }
  snapshot(run: string, kind: SnapshotKind, key: string, value: unknown): StateSnapshot {
    this.get(run); id.parse(key);
    requireCondition(['config', 'catalog', 'model', 'attempt'].includes(kind), 'SNAPSHOT_KIND_INVALID');
    const serialized = JSON.stringify(value);
    requireCondition(serialized !== undefined, 'SNAPSHOT_VALUE_INVALID');
    const fingerprint = hash(value), data = JSON.stringify(redactEvidence(JSON.parse(serialized)));
    const redacted = hash(JSON.parse(data)) !== fingerprint;
    const previous = this.db.prepare('SELECT hash,timestamp,data FROM snapshots WHERE run_id=? AND kind=? AND key=?').get(run, kind, key);
    if (previous) {
      requireCondition(previous.hash === fingerprint, 'SNAPSHOT_CONFLICT');
      return { kind, key, hash: fingerprint, createdAt: previous.timestamp as string, value: JSON.parse(previous.data as string) as unknown, redacted: hash(JSON.parse(previous.data as string)) !== fingerprint };
    }
    const timestamp = new Date().toISOString();
    this.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?)').run(run, kind, key, fingerprint, timestamp, data);
    return { kind, key, hash: fingerprint, createdAt: timestamp, value: JSON.parse(data) as unknown, redacted };
  }
  snapshots(run: string): StateSnapshot[] {
    return this.db.prepare('SELECT kind,key,hash,timestamp,data FROM snapshots WHERE run_id=? ORDER BY rowid').all(run).map(row => ({
      kind: row.kind as SnapshotKind, key: row.key as string, hash: row.hash as string, createdAt: row.timestamp as string, value: JSON.parse(row.data as string) as unknown, redacted: hash(JSON.parse(row.data as string)) !== row.hash,
    }));
  }
  // External effects have a durable intent. Recovery must reconcile pending intents, never replay them blindly.
  intent(run: string, id: string, input: unknown, snapshot?: unknown) {
    const fingerprint = hash(input);
    const prior = this.db.prepare('SELECT fingerprint,status,result FROM operations WHERE run_id=? AND id=?').get(run, id);
    if (prior) {
      requireCondition(prior.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT');
      return { status: prior.status as string, result: prior.result ? JSON.parse(prior.result as string) as unknown : null };
    }
    this.db.prepare('INSERT INTO operations(run_id,id,fingerprint,status,result,input,snapshot) VALUES(?,?,?,\'pending\',NULL,?,?)').run(run, id, fingerprint, JSON.stringify(input), snapshot === undefined ? null : JSON.stringify(snapshot));
    return null;
  }
  operation(run: string, id: string) { return this.db.prepare('SELECT status,fingerprint,result FROM operations WHERE run_id=? AND id=?').get(run, id); }
  pending(run: string) {
    return this.db.prepare("SELECT id,input,snapshot FROM operations WHERE run_id=? AND status='pending'").all(run).map(row => ({
      id: row.id as string, input: row.input ? JSON.parse(row.input as string) as unknown : null,
      snapshot: row.snapshot ? JSON.parse(row.snapshot as string) as unknown : null,
    }));
  }
  reject(run: string, operation: string, code: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE operations SET status='rejected',result=? WHERE run_id=? AND id=? AND status='pending'").run(JSON.stringify({ code }), run, operation);
      this.event(run, 'operation.rejected', { operation, code }); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  save<T, R>(run: string, version: number, data: T, type: string, operation: string, result: R, events: SemanticEvent[] = []) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.get<unknown>(run);
      const change = this.db.prepare('UPDATE runs SET version=version+1,data=? WHERE id=? AND version=?').run(JSON.stringify(data), run, version);
      requireCondition(change.changes === 1, 'STATE_CONFLICT');
      this.event(run, type, { operation, state: (data as { state?: string }).state ?? null });
      for (const event of [...transitionEvents(previous.data, data), ...events]) this.event(run, event.type, event.payload);
      const completion = this.db.prepare('UPDATE operations SET status=\'complete\',result=? WHERE run_id=? AND id=? AND status=\'pending\'').run(JSON.stringify(result), run, operation);
      requireCondition(completion.changes === 1, 'OPERATION_NOT_PENDING');
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
