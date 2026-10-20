import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { requireCondition } from '../../../protocol/src/runtime.ts';

export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata(version INTEGER NOT NULL);
      INSERT INTO metadata SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM metadata);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY, run_id TEXT NOT NULL, type TEXT NOT NULL, timestamp TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(run_id TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, result TEXT, PRIMARY KEY(run_id,id));`);
    requireCondition((this.db.prepare('SELECT version FROM metadata').get() as { version: number }).version === 1, 'STATE_VERSION_UNSUPPORTED');
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
    this.db.prepare('INSERT INTO events(run_id,type,timestamp,payload) VALUES(?,?,?,?)').run(run, type, new Date().toISOString(), JSON.stringify(payload));
  }
  // External effects have a durable intent. Recovery must reconcile pending intents, never replay them blindly.
  intent(run: string, id: string, input: unknown) {
    const fingerprint = hash(input);
    const prior = this.db.prepare('SELECT fingerprint,status,result FROM operations WHERE run_id=? AND id=?').get(run, id);
    if (prior) {
      requireCondition(prior.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT');
      return { status: prior.status as string, result: prior.result ? JSON.parse(prior.result as string) as unknown : null };
    }
    this.db.prepare('INSERT INTO operations VALUES(?,?,?,\'pending\',NULL)').run(run, id, fingerprint);
    return null;
  }
  save<T>(run: string, version: number, data: T, type: string, operation: string, result: unknown) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const change = this.db.prepare('UPDATE runs SET version=version+1,data=? WHERE id=? AND version=?').run(JSON.stringify(data), run, version);
      requireCondition(change.changes === 1, 'STATE_CONFLICT');
      this.event(run, type, { operation });
      this.db.prepare('UPDATE operations SET status=\'complete\',result=? WHERE run_id=? AND id=?').run(JSON.stringify(result), run, operation);
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
