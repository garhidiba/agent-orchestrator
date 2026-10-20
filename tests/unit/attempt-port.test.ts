import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Engine } from '../../packages/core/src/runtime/engine.ts';
import { runtimeFixture } from '../fixtures/runtime.ts';

async function bind(host: string, port: number) {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ host, port, exclusive: true }, resolve); });
    return server;
  } catch (error) { server.close(); throw error; }
}
async function close(server: Server | undefined) {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('prepared attempts hold an OS port until exact fenced release and serialize only the service address', async () => {
  const f = await runtimeFixture();
  let service: Server | undefined;
  try {
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    const dispatch = (await f.change({}, run => f.engine.prepare(run, 'T1'))).result;
    const { host, port } = dispatch.resources.service!;
    assert.equal(host, '127.0.0.1');
    assert.equal(dispatch.resources.environment.ORCH_SERVICE_HOST, host);
    assert.equal(dispatch.resources.environment.ORCH_SERVICE_PORT, String(port));
    assert.match(await readFile(dispatch.resources.envFile, 'utf8'), new RegExp(`ORCH_SERVICE_PORT="${port}"`));
    await assert.rejects(bind(host, port), (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE');
    await assert.rejects(f.change({}, run => f.engine.attemptPort(run, 'T1', dispatch.leaseId, dispatch.fencingToken + 1, 'release_for_claim')), /STALE_LEASE/);
    const status = await f.engine.attemptPort(f.engine.status(f.created.runId).data, 'T1', dispatch.leaseId, dispatch.fencingToken, 'status');
    assert.equal(status.state, 'reserved'); assert.equal(status.reserved, true);
    const release = await f.change({}, run => f.engine.attemptPort(run, 'T1', dispatch.leaseId, dispatch.fencingToken, 'release_for_claim'));
    assert.equal(release.result.state, 'released_for_claim'); assert.equal(release.result.reserved, false);
    assert.equal(release.result.claimRequiresBindEvidence, true);
    service = await bind(host, port);
    await f.change({}, run => f.engine.attemptPort(run, 'T1', dispatch.leaseId, dispatch.fencingToken, 'release_for_claim'));
    await f.engine.disposePorts();
    assert.equal(service.listening, true);
  } finally { await close(service); await f.close(); }
});

test('restarted Engines report unknown and never rebind or release a service using the persisted address', async () => {
  const f = await runtimeFixture();
  let restarted: Engine | undefined, service: Server | undefined;
  try {
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    const dispatch = (await f.change({}, run => f.engine.prepare(run, 'T1'))).result;
    await f.engine.disposePorts();
    service = await bind(dispatch.resources.service!.host, dispatch.resources.service!.port);
    restarted = new Engine(join(f.root, '.orch/state/state.db'));
    const run = restarted.status(f.created.runId).data;
    const status = await restarted.attemptPort(run, 'T1', dispatch.leaseId, dispatch.fencingToken, 'status');
    assert.equal(status.state, 'unknown'); assert.equal(status.reserved, null);
    assert.equal(status.port, dispatch.resources.service!.port);
    await assert.rejects(restarted.attemptPort(run, 'T1', dispatch.leaseId, dispatch.fencingToken, 'release_for_claim'), /PORT_RESERVATION_UNKNOWN/);
    await restarted.disposePorts();
    assert.equal(service.listening, true);
  } finally { restarted?.store.close(); await close(service); await f.close(); }
});

test('retry and completed cleanup release only their own sockets and preserve an already claimed service', async () => {
  const f = await runtimeFixture();
  let claimed: Server | undefined, probe: Server | undefined;
  try {
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    const first = (await f.change({}, run => f.engine.prepare(run, 'T1'))).result;
    await assert.rejects(f.change({}, run => f.engine.retry(run, 'T1', first.leaseId, first.fencingToken, false, 'retry')), /WORKER_STOP_UNCONFIRMED/);
    await assert.rejects(bind(first.resources.service!.host, first.resources.service!.port), (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE');
    await f.change({}, run => f.engine.retry(run, 'T1', first.leaseId, first.fencingToken, true, 'retry'));
    claimed = await bind(first.resources.service!.host, first.resources.service!.port);
    const second = (await f.change({}, run => f.engine.prepare(run, 'T1'))).result;
    await assert.rejects(f.engine.attemptPort(f.engine.status(f.created.runId).data, 'T1', first.leaseId, first.fencingToken, 'status'), /STALE_LEASE/);
    await assert.rejects(bind(second.resources.service!.host, second.resources.service!.port), (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE');
    await f.change({}, async run => {
      run.state = 'COMPLETED'; run.tasks.T1.state = 'INTEGRATED';
      return f.engine.cleanup(run, false);
    });
    probe = await bind(second.resources.service!.host, second.resources.service!.port);
    assert.equal(claimed.listening, true);
  } finally { await close(probe); await close(claimed); await f.close(); }
});

test('resume preserves orphaned reservations until exact confirmation and clean validation, then releases the old generation', async () => {
  const f = await runtimeFixture();
  let previousService: Server | undefined, probe: Server | undefined;
  try {
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    const first = (await f.change({}, run => f.engine.prepare(run, 'T1'))).result;
    const { host, port } = first.resources.service!;
    await f.change({}, run => f.engine.control(run, 'pause'));
    await assert.rejects(bind(host, port), (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE');
    await assert.rejects(f.change({}, run => f.engine.control(run, 'resume')), /ORPHANED_UNKNOWN/);
    await assert.rejects(bind(host, port), (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE');
    const dirty = join(first.worktreePath, 'T1.txt');
    await writeFile(dirty, 'preserve this work');
    await assert.rejects(f.change({}, run => f.engine.control(run, 'resume', [], ['T1'])), /DIRTY_RECOVERY_PRESERVED/);
    await assert.rejects(bind(host, port), (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE');
    await rm(dirty);
    await f.change({}, run => f.engine.control(run, 'resume', [], ['T1']));
    previousService = await bind(host, port);
    const second = (await f.change({}, run => f.engine.prepare(run, 'T1'))).result;
    await f.change({}, async run => {
      run.state = 'COMPLETED'; run.tasks.T1.state = 'INTEGRATED';
      return f.engine.cleanup(run, false);
    });
    probe = await bind(second.resources.service!.host, second.resources.service!.port);
    assert.equal(previousService.listening, true);
  } finally { await close(probe); await close(previousService); await f.close(); }
});
