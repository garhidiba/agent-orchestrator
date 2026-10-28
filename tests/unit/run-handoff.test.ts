import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runtimeFixture, fixtureTaskResult } from '../fixtures/runtime.ts';
import { git } from '../../packages/core/src/git/repository.ts';
import { packRelease } from '../../packages/installer/src/installation/index.ts';
import { roleIds } from '../../packages/protocol/src/config.ts';
import { modelSchema } from '../../packages/core/src/model-registry/index.ts';

let bundle: string, checksum: string, bundleParent: string;
before(async () => {
  bundleParent = await realpath(await mkdtemp(join(tmpdir(), 'orch-handoff-bundle-')));
  bundle = join(bundleParent, 'release');
  checksum = await packRelease(fileURLToPath(new URL('../../', import.meta.url)), bundle);
});
after(async () => { await rm(bundleParent, { recursive: true, force: true }); });

async function takeoverFixture(host: 'codex' | 'claude' = 'claude') {
  const f = await runtimeFixture();
  const previousHost = host === 'codex' ? 'claude' : 'codex';
  await f.change({}, async run => { run.host = previousHost; });
  f.engine.native!.host = previousHost;
  await f.change({}, run => f.engine.plan(run, f.plan, true));
  const before = f.engine.status(f.created.runId);
  f.engine.runtimeRoot = bundle;
  f.engine.native = { host, model: null, effort: null, verified: true, contextMatches: true,
    source: 'coordinator_native_receipt', evidence: [host === 'codex' ? 'spawn_agent' : 'Agent', 'new-coordinator', before.data.origin, before.data.targetBase] };
  const approval = { approved: true, reason: 'Continue stopped run', previous_coordinator_stopped: true,
    expected_host: previousHost, target_host: host, expected_runtime_root: before.data.runtimeRoot,
    target_runtime_root: bundle, target_runtime_checksum: checksum, runtime_migration_approved: true };
  let operation = 0;
  return { ...f, approval, handoff: (input: unknown = approval, version = f.engine.status(f.created.runId).version) =>
    f.engine.handoff(f.created.runId, `handoff-${++operation}`, version, input) };
}

for (const host of ['claude', 'codex'] as const) test(`approved takeover continues the same run on ${host} and preserves stopped dirty attempts`, async () => {
  const f = await runtimeFixture();
  try {
    const previousHost = host === 'codex' ? 'claude' : 'codex';
    await f.change({}, async run => { run.host = previousHost; return {}; });
    f.engine.native!.host = previousHost;
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    await f.change({}, run => f.engine.prepare(run, 'T1'));
    let task = f.engine.status(f.created.runId).data.tasks.T1;
    await f.change({}, run => f.engine.bind(run, 'T1', task.lease, task.attempt, 'old-worker', null, null));
    task = f.engine.status(f.created.runId).data.tasks.T1;
    await writeFile(join(task.path, 'T1.txt'), 'unfinished work must survive\n');
    const queued = await f.change({}, run => f.engine.prepare(run, 'T2'));
    await f.change({}, run => f.engine.bind(run, 'T2', queued.result.leaseId, queued.result.fencingToken, 'finished-worker', null, null));
    await writeFile(join(queued.result.worktreePath, 'T2.txt'), 'completed work\n');
    await f.change({}, run => f.engine.validate(run, 'T2', queued.result.leaseId, queued.result.fencingToken));
    await f.change({}, run => f.engine.commit(run, 'T2', queued.result.leaseId, queued.result.fencingToken, 'U1'));
    await f.change({}, async run => f.engine.complete(run, 'T2', queued.result.leaseId, queued.result.fencingToken, true, await fixtureTaskResult(run, 'T2')));
    const before = f.engine.status(f.created.runId), snapshots = f.engine.store.snapshots(f.created.runId);
    const oldRuntime = f.engine.runtimeRoot;
    f.engine.runtimeRoot = bundle;
    f.engine.native = { host, model: 'current-model', effort: 'high', verified: true, contextMatches: true,
      source: 'coordinator_native_receipt', evidence: [host === 'codex' ? 'spawn_agent' : 'Agent', 'new-coordinator', before.data.origin, await git(f.root, 'rev-parse', 'HEAD')] };
    const approval = { approved: true, reason: 'Continue existing run on current host', previous_coordinator_stopped: true,
      expected_host: previousHost, target_host: host, expected_runtime_root: oldRuntime, target_runtime_root: bundle, target_runtime_checksum: checksum, runtime_migration_approved: true, stopped_agents: ['old-worker'] };
    const result = await f.engine.handoff(f.created.runId, 'takeover', before.version, approval);
    const after = f.engine.status(f.created.runId);
    assert.equal(after.data.id, before.data.id);
    assert.equal(after.data.host, host);
    assert.equal(after.data.runtimeRoot, bundle);
    assert.equal(after.data.tasks.T1.state, 'RETRYABLE_FAILED');
    assert.equal(after.data.tasks.T1.expires, 0);
    assert.deepEqual(after.data.tasks.T2, before.data.tasks.T2);
    assert.equal(await readFile(join(task.path, 'T1.txt'), 'utf8'), 'unfinished work must survive\n');
    assert.deepEqual(after.data.gates, before.data.gates);
    assert.deepEqual(after.data.reviews, before.data.reviews);
    assert.deepEqual(f.engine.store.snapshots(f.created.runId).slice(0, snapshots.length), snapshots);
    assert.equal(after.data.hostHandoffs?.[0].fromRuntimeRoot, oldRuntime);
    assert.deepEqual(await f.engine.handoff(f.created.runId, 'takeover', before.version, approval), result);
    await assert.rejects(f.change({}, run => f.engine.bind(run, 'T1', task.lease, task.attempt, 'stale-worker', null, null)), /STALE_LEASE/);
    await f.change({}, run => f.engine.prepare(run, 'T1'));
    const replacement = f.engine.status(f.created.runId).data.tasks.T1;
    assert.equal(replacement.attempt, 2);
    assert.notEqual(replacement.path, task.path);
    assert.equal(replacement.nativeContext?.host, host);
    assert.equal(await git(replacement.path, 'status', '--porcelain'), '');
    f.engine.runtimeRoot = oldRuntime;
    await assert.rejects(f.change({}, async () => ({})), /RUNTIME_VERSION_PINNED/);
  } finally { await f.close(); }
});

test('handoff rejects stale CAS, approval, context, pending operations and runtime tampering without changing the run', async () => {
  const f = await takeoverFixture();
  try {
    const before = f.engine.status(f.created.runId);
    await assert.rejects(f.handoff(f.approval, before.version - 1), /STATE_CONFLICT/);
    for (const input of [{ ...f.approval, approved: false }, { ...f.approval, previous_coordinator_stopped: false }, { ...f.approval, force: true }]) await assert.rejects(f.handoff(input));
    await assert.rejects(f.handoff({ ...f.approval, runtime_migration_approved: undefined }), /RUNTIME_MIGRATION_APPROVAL_REQUIRED/);
    await assert.rejects(f.handoff({ ...f.approval, target_runtime_checksum: '0'.repeat(64) }), /RELEASE_CHECKSUM_MISMATCH/);
    await assert.rejects(f.handoff({ ...f.approval, expected_host: 'claude' }), /HOST_HANDOFF_CONFLICT/);
    f.engine.native!.contextMatches = false;
    await assert.rejects(f.handoff(), /HOST_CONTEXT_MISMATCH/);
    f.engine.native!.contextMatches = true;
    f.engine.native!.evidence[3] = 'a'.repeat(40);
    await assert.rejects(f.handoff(), /HOST_CONTEXT_MISMATCH/);
    f.engine.native!.evidence[3] = before.data.targetBase;
    f.engine.store.intent(f.created.runId, 'unreconciled', { tool: 'orch_integrate' }, before);
    await assert.rejects(f.handoff(), /RECONCILIATION_REQUIRED/);
    assert.deepEqual(f.engine.status(f.created.runId), before);
    assert.equal(f.engine.store.snapshots(f.created.runId).filter(item => item.kind === 'handoff').length, 0);
  } finally { await f.close(); }
});

test('paused takeover requires all old agents stopped and resumes with bounded fresh attempts', async () => {
  const f = await runtimeFixture();
  try {
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    await f.change({}, run => f.engine.prepare(run, 'T1'));
    await f.change({}, run => f.engine.prepare(run, 'T2'));
    const old = f.engine.status(f.created.runId).data.tasks.T1;
    await f.change({}, run => f.engine.bind(run, 'T1', old.lease, old.attempt, 'old-worker', null, null));
    await writeFile(join(old.path, 'T1.txt'), 'dirty paused work\n');
    await f.change({}, run => f.engine.control(run, 'pause'));
    const before = f.engine.status(f.created.runId);
    f.engine.runtimeRoot = bundle;
    f.engine.native = { host: 'claude', model: null, effort: null, verified: true, contextMatches: true,
      source: 'coordinator_native_receipt', evidence: ['Agent', 'new-coordinator', before.data.origin, before.data.targetBase] };
    const approval = { approved: true, reason: 'Continue paused run', previous_coordinator_stopped: true,
      expected_host: 'codex', target_host: 'claude', expected_runtime_root: before.data.runtimeRoot,
      target_runtime_root: bundle, target_runtime_checksum: checksum, runtime_migration_approved: true };
    await assert.rejects(f.engine.handoff(f.created.runId, 'unknown-workers', before.version, approval), /WORKER_STOP_UNCONFIRMED/);
    await assert.rejects(f.engine.handoff(f.created.runId, 'unknown-lease', before.version, { ...approval, stopped_agents: ['old-worker'] }), /WORKER_STOP_UNCONFIRMED/);
    assert.deepEqual(f.engine.status(f.created.runId), before);
    await f.engine.handoff(f.created.runId, 'confirmed-paused', before.version, { ...approval, stopped_agents: ['old-worker'], never_started_tasks: ['T2'] });
    assert.equal(f.engine.status(f.created.runId).data.state, 'PAUSED');
    await f.change({}, run => f.engine.control(run, 'resume'));
    await f.change({}, run => f.engine.prepare(run, 'T1'));
    assert.equal(f.engine.status(f.created.runId).data.tasks.T1.attempt, 2);
    assert.equal(await readFile(join(old.path, 'T1.txt'), 'utf8'), 'dirty paused work\n');
  } finally { await f.close(); }
});

for (const host of ['codex', 'claude'] as const) test(`handoff adopts ${host} role pins while preserving config history and rejecting unsupported pins`, async () => {
  const f = await takeoverFixture(host);
  try {
    const previous = f.engine.status(f.created.runId).data.config;
    const next = structuredClone(previous);
    for (const role of roleIds) next.hosts[host].roles[role] = { model: role === 'coder' || role === 'repair' ? `${host}-coder` : `${host}-reviewer`, effort: 'high' };
    f.engine.readConfig = async () => next;
    await assert.rejects(f.handoff(), host === 'claude' ? /CLAUDE_ROLE_DEFINITION_REQUIRED/ : /MODEL_NOT_SUPPORTED/);
    f.engine.native!.perInvocationModel = true; f.engine.native!.perInvocationEffort = true;
    f.engine.native!.models = [`${host}-coder`, `${host}-reviewer`].map(id => modelSchema.parse({ host, id, displayName: id, resolvedId: id,
      family: host === 'codex' ? 'openai' : 'claude', support: 'advertised', access: 'unknown', availability: 'unknown', efforts: ['high'], defaultEffort: 'high',
      hidden: false, source: 'synthetic-native-tool-metadata', sourceVersion: null, fetchedAt: new Date().toISOString(), expiresAt: null, evidence: [] }));
    next.hosts[host].roles.tester.effort = 'unsupported';
    await assert.rejects(f.handoff(), /EFFORT_NOT_SUPPORTED/);
    next.hosts[host].roles.tester.effort = 'high';
    await f.handoff();
    const run = f.engine.status(f.created.runId).data;
    assert.equal(run.configRevision, 2);
    assert.deepEqual(run.configRevisions![0].roles, previous.hosts);
    assert.deepEqual(run.config, next);
    assert.equal(run.config.model_selection.allow_cross_host, false);
    const prepared = await f.change({}, run => f.engine.prepare(run, 'T1'));
    assert.equal(prepared.result.modelId, `${host}-coder`);
    assert.deepEqual(prepared.result.nativeArguments, { model: `${host}-coder`, reasoning_effort: 'high' });
  } finally { await f.close(); }
});

test('handoff settles stopped read-only dispatches without manufacturing completed reviews', async () => {
  const f = await runtimeFixture();
  try {
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    await f.change({}, async run => { run.state = 'REVIEWING'; });
    const dispatch = await f.change({}, run => f.engine.prepareReview(run, 'reviewer'));
    await f.change({}, run => f.engine.bindReview(run, dispatch.result.dispatchId, 'old-reviewer', null, null, run.integrationSha!));
    const before = f.engine.status(f.created.runId);
    f.engine.runtimeRoot = bundle;
    f.engine.native = { host: 'claude', model: null, effort: null, verified: true, contextMatches: true,
      source: 'coordinator_native_receipt', evidence: ['Agent', 'new-coordinator', before.data.origin, before.data.targetBase] };
    const approval = { approved: true, reason: 'Continue stopped review', previous_coordinator_stopped: true,
      expected_host: 'codex', target_host: 'claude', expected_runtime_root: before.data.runtimeRoot,
      target_runtime_root: bundle, target_runtime_checksum: checksum, runtime_migration_approved: true };
    await assert.rejects(f.engine.handoff(f.created.runId, 'unconfirmed-review', before.version, approval), /REVIEW_STOP_UNCONFIRMED/);
    await f.engine.handoff(f.created.runId, 'stopped-review', before.version, { ...approval, stopped_agents: ['old-reviewer'] });
    const run = f.engine.status(f.created.runId).data;
    assert.equal(run.reviewDispatches![dispatch.result.dispatchId].state, 'STOPPED');
    assert.deepEqual(run.reviews, before.data.reviews);
    await f.change({}, run => f.engine.prepareReview(run, 'reviewer'));
  } finally { await f.close(); }
});

test('a packaged MCP authenticates takeover then uses ordinary preparation on the same run', async () => {
  const f = await runtimeFixture();
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createServer } = await import(pathToFileURL(join(bundle, 'packages/mcp-server/src/server.ts')).href);
  const tokenPath = join(f.dir, 'handoff.token');
  const server = await createServer(f.root, 'claude', join(f.dir, 'managed'), tokenPath);
  const client = new Client({ name: 'packaged-handoff-contract', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await f.change({}, run => f.engine.plan(run, f.plan, true));
    await server.connect(a); await client.connect(b);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await client.callTool({ name, arguments: args });
      return JSON.parse((response.content as { text: string }[])[0].text);
    };
    const before = f.engine.status(f.created.runId), environment = (await call('orch_environment')).data;
    const auth = { coordinator_token: await readFile(tokenPath, 'utf8') };
    const envelope = { ...auth, protocol_version: 1, run_id: f.created.runId, operation_id: 'mcp-takeover', expected_state_version: before.version,
      input: { approved: true, reason: 'Continue same run via authenticated MCP', previous_coordinator_stopped: true,
        expected_host: 'codex', target_host: 'claude', expected_runtime_root: before.data.runtimeRoot,
        target_runtime_root: `${bundle}/`, target_runtime_checksum: checksum, runtime_migration_approved: true } };
    assert.equal((await call('orch_run_handoff', { ...envelope, coordinator_token: 'worker' })).error.code, 'COORDINATOR_RELAY_REQUIRED');
    assert.ok((await call('orch_run_handoff', { ...envelope, lease_id: 'unpaired' })).error);
    assert.equal((await call('orch_run_handoff', envelope)).error.code, 'HOST_CONTEXT_MISMATCH');
    await call('orch_host_connect', { ...auth, native_tool: 'Agent', native_agent_id: 'synthetic-native-probe', probe: {
      challenge: environment.nativeHandshake.challenge, cwd: before.data.origin, origin_root: before.data.origin, branch: before.data.target, head: before.data.targetBase } });
    const handedOff = await call('orch_run_handoff', { ...envelope, operation_id: 'mcp-connected-takeover' });
    assert.equal(handedOff.error, undefined, JSON.stringify(handedOff));
    const prepared = await call('orch_task_prepare', { ...envelope, operation_id: 'mcp-next-worker', expected_state_version: handedOff.data.version, input: { task_id: 'T1' } });
    assert.equal(prepared.error, undefined, JSON.stringify(prepared));
    assert.equal(prepared.data.result.host, 'claude');
    assert.equal(prepared.data.result.runId, f.created.runId);
    const oldServer = await createServer(f.root, 'codex', join(f.dir, 'managed'), join(f.dir, 'old-host.token'));
    const oldClient = new Client({ name: 'old-host-recovery', version: '1' });
    const [oldA, oldB] = InMemoryTransport.createLinkedPair();
    try {
      await oldServer.connect(oldA); await oldClient.connect(oldB);
      const pending = 'new-host-pending-prepare', current = f.engine.status(f.created.runId);
      f.engine.store.intent(f.created.runId, pending, { tool: 'orch_task_prepare', input: { task_id: 'T1' } }, current);
      const request = { run_id: f.created.runId, operation_id: pending, previous_coordinator_stopped: true };
      const oldResponse = await oldClient.callTool({ name: 'orch_reconcile', arguments: { ...request, coordinator_token: await readFile(join(f.dir, 'old-host.token'), 'utf8') } });
      assert.equal(JSON.parse((oldResponse.content as { text: string }[])[0].text).error?.code, 'RUN_HOST_MISMATCH');
      assert.deepEqual(f.engine.status(f.created.runId), current);
      assert.equal((await call('orch_reconcile', { ...auth, ...request })).error, undefined);
      const completed = await oldClient.callTool({ name: 'orch_reconcile', arguments: { ...request, coordinator_token: await readFile(join(f.dir, 'old-host.token'), 'utf8') } });
      assert.equal(completed.isError, undefined);
    } finally { await oldClient.close(); await oldServer.close(); }
  } finally { await client.close(); await server.close(); await f.close(); }
});

test('interrupted administrative handoff reconciles the same operation without duplicating history', async () => {
  const f = await takeoverFixture();
  try {
    const save = f.engine.store.save.bind(f.engine.store);
    f.engine.store.save = () => { throw new Error('SIMULATED_BEFORE_SAVE'); };
    await assert.rejects(f.engine.handoff(f.created.runId, 'interrupted-handoff', f.engine.status(f.created.runId).version, f.approval), /SIMULATED_BEFORE_SAVE/);
    f.engine.store.save = save;
    await f.engine.reconcile(f.created.runId, 'interrupted-handoff', true);
    assert.equal(f.engine.status(f.created.runId).data.hostHandoffs!.length, 1);
    assert.equal(f.engine.status(f.created.runId).data.host, 'claude');
    const version = f.engine.status(f.created.runId).version;
    await f.engine.reconcile(f.created.runId, 'interrupted-handoff', true);
    assert.equal(f.engine.status(f.created.runId).version, version);
  } finally { await f.close(); }
});
