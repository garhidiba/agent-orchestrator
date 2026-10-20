import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
import { allocateAttemptResources, reservePort } from '../../packages/core/src/runtime/resources.ts';

test('attempt resource allocation isolates all writable paths and never overwrites existing attempts or source env', async () => {
  const origin = await realpath(await mkdtemp(join(tmpdir(), 'orch-resources-')));
  try {
    await writeFile(join(origin, '.env'), 'DATABASE_URL=private');
    const first = await allocateAttemptResources(origin, 'run-1', 'task-1-1');
    const second = await allocateAttemptResources(origin, 'run-1', 'task-1-2');
    assert.notEqual(first.root, second.root);
    assert.equal(first.environment.TMPDIR, first.tmp);
    assert.equal(first.environment.ORCH_DATABASE_PATH, join(first.db, 'test.db'));
    assert.equal(first.environment.DATABASE_URL, `file:${join(first.db, 'test.db')}`);
    assert.equal(first.environment.ORCH_BUILD_DIR, first.build);
    assert.equal(await readFile(join(origin, '.env'), 'utf8'), 'DATABASE_URL=private');
    assert.match(await readFile(first.envFile, 'utf8'), /ORCH_BUILD_DIR=/);
    await assert.rejects(allocateAttemptResources(origin, 'run-1', 'task-1-1'), /RESOURCE_ALREADY_ALLOCATED/);
    await assert.rejects(allocateAttemptResources(origin, 'run-1', '../outside'));
  } finally { await rm(origin, { recursive: true, force: true }); }
});

test('resource allocation rejects symlinked attempt paths before writing outside the run', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-linked-resources-'))), origin = join(root, 'repo'), outside = join(root, 'outside');
  try {
    await mkdir(join(origin, '.orch/state/runs/run-1'), { recursive: true }); await mkdir(outside);
    await symlink(outside, join(origin, '.orch/state/runs/run-1/attempts'));
    await assert.rejects(allocateAttemptResources(origin, 'run-1', 'task-1'), /STATE_PATH_UNSAFE/);
    await assert.rejects(readFile(join(outside, 'task-1/env')), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('port reservations hold a real socket and explicitly become unreserved before a service can claim it', async () => {
  const reservation = await reservePort();
  const competitor = createServer();
  try {
    await assert.rejects(new Promise<void>((resolve, reject) => {
      competitor.once('error', reject); competitor.listen(reservation.port, reservation.host, resolve);
    }), (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE');
    assert.equal(reservation.state, 'reserved');
    const probe = createConnection({ port: reservation.port, host: reservation.host });
    await once(probe, 'close');
    assert.deepEqual(await reservation.releaseForClaim(), { host: '127.0.0.1', port: reservation.port, reserved: false });
    assert.equal(reservation.state, 'released_for_claim');
    const service = createServer();
    try { await new Promise<void>(resolve => service.listen(reservation.port, reservation.host, resolve)); }
    finally { await new Promise<void>((resolve, reject) => service.close(error => error ? reject(error) : resolve())); }
  } finally { await reservation.release(); competitor.close(); }
});
