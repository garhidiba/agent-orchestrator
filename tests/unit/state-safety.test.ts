import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../packages/core/src/state/store.ts';
import { Engine } from '../../packages/core/src/runtime/engine.ts';

test('state initialization never migrates or changes a foreign SQLite database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-foreign-state-')), file = join(dir, 'state.db');
  let opened: Store | undefined;
  try {
    const database = new DatabaseSync(file); database.exec("CREATE TABLE private_data(value TEXT); INSERT INTO private_data VALUES('keep');"); database.close();
    const before = await readFile(file);
    assert.throws(() => { opened = new Store(file); }, /STATE_DATABASE_UNOWNED/);
    assert.deepEqual(await readFile(file), before);
  } finally { opened?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('engine rejects linked project state before writing through to another directory', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-linked-state-')), root = join(dir, 'repo'), external = join(dir, 'external');
  let engine: Engine | undefined;
  try {
    await mkdir(join(root, '.orch'), { recursive: true }); await mkdir(external); await symlink(external, join(root, '.orch/state'));
    assert.throws(() => { engine = new Engine(join(root, '.orch/state/state.db')); }, /STATE_PATH_UNSAFE/);
  } finally { engine?.store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('future and unknown version-three schemas are rejected before changing the database', async () => {
  for (const mutation of [
    'UPDATE metadata SET version=4',
    'UPDATE metadata SET version=3; DROP TABLE snapshots',
    'UPDATE metadata SET version=3; ALTER TABLE snapshots ADD COLUMN incompatible TEXT',
    'UPDATE metadata SET version=3; CREATE UNIQUE INDEX incompatible ON runs(data)',
    "UPDATE metadata SET version=3; CREATE TRIGGER incompatible AFTER INSERT ON snapshots BEGIN DELETE FROM runs; END",
  ]) {
    const dir = await mkdtemp(join(tmpdir(), 'orch-unknown-schema-')), file = join(dir, 'state.db');
    let opened: Store | undefined;
    try {
      const store = new Store(file);
      store.create('run', { state: 'EXECUTING' });
      store.db.exec(mutation); store.close();
      const before = await readFile(file);
      assert.throws(() => { opened = new Store(file); }, /STATE_VERSION_UNSUPPORTED/);
      assert.deepEqual(await readFile(file), before);
    } finally { opened?.close(); await rm(dir, { recursive: true, force: true }); }
  }
});

for (const [name, table, definition] of [
  ['descending primary key', 'events', 'sequence INTEGER PRIMARY KEY DESC, run_id TEXT NOT NULL, type TEXT NOT NULL, timestamp TEXT NOT NULL, payload TEXT NOT NULL'],
  ['replacement conflict policy', 'runs', 'id TEXT PRIMARY KEY ON CONFLICT REPLACE, version INTEGER NOT NULL, data TEXT NOT NULL'],
]) test(`version-three ${name} semantics are not silently normalized`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-ddl-compat-')), file = join(dir, 'state.db');
  let opened: Store | undefined;
  try {
    const store = new Store(file); store.create('run', { state: 'EXECUTING' });
    store.db.exec(`UPDATE metadata SET version=3; ALTER TABLE ${table} RENAME TO previous; CREATE TABLE ${table}(${definition}); INSERT INTO ${table} SELECT * FROM previous; DROP TABLE previous`);
    store.close();
    const before = await readFile(file);
    assert.throws(() => { opened = new Store(file); }, /STATE_VERSION_UNSUPPORTED/);
    assert.deepEqual(await readFile(file), before);
  } finally { opened?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('state database symlinks are rejected before creating or changing their targets', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-linked-database-'));
  let opened: Store | undefined;
  try {
    const dangling = join(dir, 'not-created.db'), link = join(dir, 'state.db');
    await symlink(dangling, link);
    assert.throws(() => { opened = new Store(link); }, /STATE_PATH_UNSAFE/);
    await assert.rejects(readFile(dangling), { code: 'ENOENT' });
    await rm(link);
    const external = join(dir, 'external.db');
    const db = new DatabaseSync(external); db.exec('CREATE TABLE retained(value TEXT)'); db.close();
    const before = await readFile(external);
    await symlink(external, link);
    assert.throws(() => { opened = new Store(link); }, /STATE_PATH_UNSAFE/);
    assert.deepEqual(await readFile(external), before);
  } finally { opened?.close(); await rm(dir, { recursive: true, force: true }); }
});
