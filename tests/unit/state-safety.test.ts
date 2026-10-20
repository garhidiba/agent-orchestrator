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
