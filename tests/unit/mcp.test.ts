import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../../packages/mcp-server/src/server.ts';

test('MCP handshake exposes schema-validated tools and blocks fabricated Coordinator claims', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-mcp-'));
  const server = await createServer(dir, 'codex', join(dir, 'managed'), join(dir, 'coordinator.token'));
  const client = new Client({ name: 'orch-contract', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const tools = await client.listTools();
    for (const name of ['orch_environment', 'orch_task_prepare', 'orch_task_bind', 'orch_task_commit', 'orch_review_submit', 'orch_finalize', 'orch_cleanup', 'orch_run_abandon']) assert.equal(tools.tools.some(tool => tool.name === name), true);
    const result = await client.callTool({ name: 'orch_run_create', arguments: { coordinator_token: 'wrong', trusted_commands_hash: 'fake' } });
    assert.equal(result.isError, true); assert.match(JSON.stringify(result), /COORDINATOR_RELAY_REQUIRED/);
    const abandon = await client.callTool({ name: 'orch_run_abandon', arguments: { coordinator_token: 'wrong', protocol_version: 1, run_id: 'run', operation_id: 'abandon', expected_state_version: 0, input: { approved: true, reason: 'Discard stopped run', previous_coordinator_stopped: true } } });
    assert.equal(abandon.isError, true); assert.match(JSON.stringify(abandon), /COORDINATOR_RELAY_REQUIRED/);
    const role = await client.callTool({ name: 'orch_run_create', arguments: { role: 'coordinator', trusted_commands_hash: 'fake' } });
    assert.equal(role.isError, true);
    const wrongVersion = await client.callTool({ name: 'orch_finalize', arguments: { protocol_version: 2, run_id: 'run', operation_id: 'op', expected_state_version: 0, input: { approved: true, expected_target_sha: 'fake' } } });
    assert.equal(wrongVersion.isError, true);
  } finally { await client.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('stdio resolves global launch cwd to Git root and allows only global reads outside Git', async () => {
  const { StdioClientTransport, getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { mkdir, writeFile, access } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { git } = await import('../../packages/core/src/git/repository.ts');
  const dir = await mkdtemp(join(tmpdir(), 'orch-stdio-')), root = join(dir, 'repo'), nested = join(root, 'nested');
  try {
  await mkdir(nested, { recursive: true }); await mkdir(join(root, '.orch')); await git(root, 'init');
  await writeFile(join(root, '.orch/config.yaml'), 'model_selection: {profile: quality}\n');
  const cli = fileURLToPath(new URL('../../packages/mcp-server/src/stdio.ts', import.meta.url));
  const env = { ...getDefaultEnvironment(), HOME: dir, ORCH_CONFIG_HOME: join(dir, 'global') };
  for (const cwd of [nested, dir]) {
    const client = new Client({ name: 'stdio-contract', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--host', 'codex', '--origin', '.'], cwd, env, stderr: 'pipe' });
    try {
      await client.connect(transport);
      const response = await client.callTool({ name: 'orch_config', arguments: { action: 'effective' } });
      assert.equal(response.isError, undefined);
      const block = response.content as { text: string }[];
      const loaded = JSON.parse(block[0].text).data;
      if (cwd === nested) { assert.equal(loaded.config.model_selection.profile, 'quality'); assert.match(loaded.files.project, /repo[\/]\.orch[\/]config.yaml$/); }
      else { assert.equal(loaded.files.project, null); assert.equal(loaded.config.model_selection.profile, 'balanced'); }
      const diagnostic = await client.callTool({ name: 'orch_doctor', arguments: {} });
      assert.equal(diagnostic.isError, undefined);
      const status = JSON.parse((diagnostic.content as { text: string }[])[0].text).data;
      assert.equal(status.executionReady, false); assert.equal(status.mcp.status, 'not_configured');

    } finally { await client.close(); }
  }
  await assert.rejects(access(join(root, '.orch/state')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Coordinator token storage rejects a linked file instead of reading an unrelated secret', { skip: process.platform === 'win32' }, async () => {
  const { symlink, writeFile, readFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'orch-token-link-')), privateFile = join(dir, 'private'), tokenPath = join(dir, 'token');
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    await writeFile(privateFile, 'f'.repeat(64), { mode: 0o600 }); await symlink(privateFile, tokenPath);
    await assert.rejects(async () => { server = await createServer(dir, 'codex', join(dir, 'managed'), tokenPath); }, /COORDINATOR_TOKEN_UNSAFE/);
    assert.equal(await readFile(privateFile, 'utf8'), 'f'.repeat(64));
  } finally { await server?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('MCP session patches use CAS, dry-run and instance isolation without configuration file writes', async () => {
  const { readFile, access } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'orch-mcp-session-'));
  const priorPath = process.env.PATH, priorConfig = process.env.ORCH_CONFIG_HOME;
  process.env.PATH = dir; process.env.ORCH_CONFIG_HOME = join(dir, 'global');
  const connections: { server: Awaited<ReturnType<typeof createServer>>; client: Client }[] = [];
  try {
    for (const name of ['first', 'second']) {
      const server = await createServer(dir, 'codex', join(dir, 'managed'), join(dir, `${name}.token`));
      const client = new Client({ name, version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
      connections.push({ server, client });
    }
    const call = async (index: number, args: Record<string, unknown>) => {
      const response = await connections[index].client.callTool({ name: 'orch_config', arguments: args });
      const result = JSON.parse((response.content as { text: string }[])[0].text);
      return { response, ...result };
    };
    const before = await call(0, { action: 'effective' });
    const auth = { coordinator_token: await readFile(join(dir, 'first.token'), 'utf8') };
    const patch = { ...auth, action: 'patch', scope: 'session', expected_hash: before.data.hashes.session, patches: [{ path: ['model_selection', 'profile'], value: 'quality' }] };
    const preview = await call(0, { ...patch, dry_run: true });
    assert.equal(preview.data.applied, false);
    assert.equal((await call(0, { action: 'effective' })).data.config.model_selection.profile, 'balanced');
    assert.equal((await call(0, patch)).data.applied, true);
    const applied = await call(0, { action: 'effective' });
    assert.equal(applied.data.config.model_selection.profile, 'quality'); assert.equal(applied.data.sources['model_selection.profile'], 'session');
    assert.equal((await call(0, patch)).error.code, 'CONFIG_CONFLICT');
    assert.equal((await call(1, { action: 'effective' })).data.config.model_selection.profile, 'balanced');
    await call(0, { ...auth, action: 'unset', scope: 'session', expected_hash: applied.data.hashes.session, patches: [{ path: ['model_selection', 'profile'] }] });
    assert.equal((await call(0, { action: 'effective' })).data.config.model_selection.profile, 'balanced');
    await assert.rejects(access(join(dir, '.orch/config.yaml'))); await assert.rejects(access(join(dir, 'global/config.yaml')));
  } finally {
    for (const item of connections) { await item.client.close(); await item.server.close(); }
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (priorConfig === undefined) delete process.env.ORCH_CONFIG_HOME; else process.env.ORCH_CONFIG_HOME = priorConfig;
    await rm(dir, { recursive: true, force: true });
  }
});

for (const host of ['codex', 'hermes'] as const) test(`${host} MCP connects the current native coordinator without a daemon and prepares inherited workers`, async () => {
  const { runtimeFixture } = await import('../fixtures/runtime.ts');
  const { readFile, realpath } = await import('node:fs/promises');
  const { git } = await import('../../packages/core/src/git/repository.ts');
  const f = await runtimeFixture(false, {}, tmpdir(), {}, host), tokenPath = join(f.dir, 'host.token');
  const server = await createServer(f.root, host, join(f.dir, 'managed'), tokenPath);
  const client = new Client({ name: 'native-relay-contract', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await client.callTool({ name, arguments: args });
      return JSON.parse((response.content as { text: string }[])[0].text);
    };
    const environment = (await call('orch_environment')).data;
    assert.equal(environment.installation, 'READY');
    assert.equal(environment.nativeDispatch, 'NEEDS_HOST_HANDSHAKE');
    const auth = { coordinator_token: await readFile(tokenPath, 'utf8') };
    assert.equal(environment.nativeHandshake.nativeTool, host === 'hermes' ? 'delegate_task' : 'spawn_agent');
    const receipt = { ...auth, native_tool: host === 'hermes' ? 'delegate_task' : 'spawn_agent', native_agent_id: '/root/native-probe',
      probe: { challenge: environment.nativeHandshake.challenge, cwd: await realpath(f.root), origin_root: await realpath(f.root),
        branch: await git(f.root, 'branch', '--show-current'), head: await git(f.root, 'rev-parse', 'HEAD') } };
    assert.equal((await call('orch_host_connect', { ...receipt, coordinator_token: 'worker' })).error.code, 'COORDINATOR_RELAY_REQUIRED');
    assert.equal((await call('orch_host_connect', { ...receipt, native_tool: 'Agent' })).error.code, 'HOST_TOOL_MISMATCH');
    assert.equal((await call('orch_host_connect', { ...receipt, probe: { ...receipt.probe, head: 'a'.repeat(40) } })).error.code, 'HOST_CONTEXT_MISMATCH');
    assert.equal((await call('orch_host_connect', { ...receipt, probe: { ...receipt.probe, challenge: '0'.repeat(64) } })).error.code, 'HOST_CHALLENGE_MISMATCH');
    const connectResult = await call('orch_host_connect', receipt); assert.equal(connectResult.error, undefined, JSON.stringify(connectResult));
    const connected = connectResult.data;
    assert.equal(connected.state, 'READY'); assert.equal(connected.source, 'coordinator_native_receipt');
    assert.equal(connected.model, null); assert.equal(connected.effort, null);
    assert.equal((await call('orch_host_connect', receipt)).error.code, 'HOST_ALREADY_CONNECTED');
    const readyEnvironment = (await call('orch_environment')).data;
    assert.equal(readyEnvironment.nativeDispatch, 'READY'); assert.equal(readyEnvironment.host.executionReady, true);
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    const envelope = { ...auth, protocol_version: 1, run_id: f.created.runId, operation_id: 'prepare-native', expected_state_version: f.engine.status(f.created.runId).version, input: { task_id: 'T1' } };
    const prepareResult = await call('orch_task_prepare', envelope); assert.equal(prepareResult.error, undefined, JSON.stringify(prepareResult));
    const prepared = prepareResult.data;
    assert.ok(prepared.result.worktreePath); assert.equal(prepared.result.modelId, null); assert.equal(prepared.result.effort, null);
    const blocked = await call('orch_task_bind', { ...envelope, operation_id: 'bad-bootstrap', expected_state_version: prepared.version, input: { task_id: 'T1', lease_id: prepared.result.leaseId, fencing_token: prepared.result.fencingToken, native_id: '/root/native-worker', observed_model: null, observed_effort: null } });
    assert.ok(blocked.error, 'host-relay workers must supply their observed Git bootstrap identity');
    const path = prepared.result.worktreePath;
    const bootstrap = { cwd: await realpath(path), origin_root: await git(path, 'rev-parse', '--show-toplevel'), common_dir: await git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir'), branch: await git(path, 'branch', '--show-current'), head: await git(path, 'rev-parse', 'HEAD') };
    const bound = await call('orch_task_bind', { ...envelope, operation_id: 'bind-native', expected_state_version: prepared.version, input: { task_id: 'T1', lease_id: prepared.result.leaseId, fencing_token: prepared.result.fencingToken, native_id: '/root/native-worker', observed_model: null, observed_effort: null, bootstrap } });
    assert.equal(bound.error, undefined, JSON.stringify(bound)); assert.equal(bound.data.result.state, 'RUNNING');
    const heartbeat = await call('orch_heartbeat', { ...envelope, operation_id: 'heartbeat-native', expected_state_version: bound.data.version,
      input: { task_id: 'T1', lease_id: prepared.result.leaseId, fencing_token: prepared.result.fencingToken, native_id: '/root/native-worker', receipt: { source: 'host_status', status: 'running', observedAt: Date.now(), evidenceRef: 'synthetic://parent/status/native-worker' } } });
    assert.equal(heartbeat.error, undefined, JSON.stringify(heartbeat)); assert.ok(heartbeat.data.result.expiresAt);
    const exported = await call('orch_export', { ...auth, run_id: f.created.runId });
    assert.equal(exported.error, undefined, JSON.stringify(exported));
    assert.match(await readFile(exported.data.events, 'utf8'), /heartbeat-native/);

  } finally { await client.close(); await server.close(); await f.close(); }
});

test('project initialization requires coordinator auth and ordinary config reads remain read-only', async () => {
  const { readFile, writeFile, access } = await import('node:fs/promises');
  const { git } = await import('../../packages/core/src/git/repository.ts');
  const dir = await mkdtemp(join(tmpdir(), 'orch-mcp-init-')), token = join(dir, 'parent.token');
  await git(dir, 'init');
  const server = await createServer(dir, 'codex', join(dir, 'managed'), token), client = new Client({ name: 'project-init-contract', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
    await call('orch_config', { action: 'effective' });
    const file = join(dir, '.orch/config.yaml'); await assert.rejects(access(file), { code: 'ENOENT' });
    assert.equal((await call('orch_project_init', { coordinator_token: 'worker' })).error.code, 'COORDINATOR_RELAY_REQUIRED');
    await assert.rejects(access(file), { code: 'ENOENT' });
    const auth = { coordinator_token: await readFile(token, 'utf8') };
    const first = await call('orch_project_init', { ...auth, complete: true, profile: 'balanced' }); assert.equal(first.error, undefined, JSON.stringify(first)); assert.equal(first.data.created, true);
    assert.equal(Object.keys(first.data.configuration.layers.project.hosts.codex.roles).length, 8);
    assert.equal(first.data.configuration.layers.project.model_selection.profile, 'balanced');
    await assert.rejects(access(join(dir, 'package.json')), { code: 'ENOENT' });
    await assert.rejects(access(join(dir, 'node_modules')), { code: 'ENOENT' });
    const custom = '# preserve me\nmodel_selection: {profile: quality}\n'; await writeFile(file, custom);
    const again = await call('orch_project_init', auth); assert.equal(again.data.created, false); assert.equal(again.data.configuration.config.model_selection.profile, 'quality');
    assert.equal(await readFile(file, 'utf8'), custom);
    const preview = await call('orch_project_init', { ...auth, complete: true, dry_run: true });
    assert.equal(preview.data.updated, true); assert.equal(await readFile(file, 'utf8'), custom);
    const complete = await call('orch_project_init', { ...auth, complete: true });
    assert.equal(complete.data.updated, true); assert.equal(complete.data.configuration.layers.project.model_selection.profile, 'quality');
    assert.equal(Object.keys(complete.data.configuration.layers.project.hosts.codex.roles).length, 8);
  } finally { await client.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('MCP exposes authenticated PRD recovery, role dispatch, heartbeat and recommendation tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-mcp-prd-'));
  const server = await createServer(dir, 'codex', join(dir, 'managed'), join(dir, 'coordinator.token'));
  const client = new Client({ name: 'prd-contract', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const names = new Set((await client.listTools()).tools.map(tool => tool.name));
    for (const name of ['orch_review_prepare', 'orch_review_bind', 'orch_review_stop', 'orch_attempt_port', 'orch_heartbeat', 'orch_liveness_reconcile', 'orch_reintegrate', 'orch_finding_disposition', 'orch_model_recommend', 'orch_export', 'orch_doctor']) assert.ok(names.has(name), name);
    const result = await client.callTool({ name: 'orch_review_prepare', arguments: { protocol_version: 1, run_id: 'run', operation_id: 'op', expected_state_version: 0, coordinator_token: 'worker', input: { role: 'reviewer' } } });
    assert.match(JSON.stringify(result), /COORDINATOR_RELAY_REQUIRED/);
    const stopped = await client.callTool({ name: 'orch_review_stop', arguments: { protocol_version: 1, run_id: 'run', operation_id: 'stop-review', expected_state_version: 0, coordinator_token: 'worker', input: { dispatch_id: 'dispatch-1', native_id: '/root/reviewer', native_stopped: true } } });
    assert.match(JSON.stringify(stopped), /COORDINATOR_RELAY_REQUIRED/);
    const port = await client.callTool({ name: 'orch_attempt_port', arguments: { protocol_version: 1, run_id: 'run', operation_id: 'attempt-port', expected_state_version: 0, coordinator_token: 'worker', input: { task_id: 'T1', lease_id: 'lease-1', fencing_token: 1, action: 'status' } } });
    assert.match(JSON.stringify(port), /COORDINATOR_RELAY_REQUIRED/);

    const tools = (await client.listTools()).tools;
    const submitSchema = tools.find(tool => tool.name === 'orch_review_submit')!.inputSchema.properties!.input as { properties: Record<string, unknown> };
    assert.deepEqual(submitSchema.properties.native_stopped, { type: 'boolean', default: false });
    const stopSchema = tools.find(tool => tool.name === 'orch_review_stop')!.inputSchema.properties!.input as { properties: Record<string, unknown> };
    assert.deepEqual(stopSchema.properties.native_stopped, { type: 'boolean', const: true });
    const portSchema = tools.find(tool => tool.name === 'orch_attempt_port')!.inputSchema.properties!.input as { properties: Record<string, unknown> };
    assert.deepEqual(portSchema.properties.action, { type: 'string', enum: ['status', 'release_for_claim'] });

  } finally { await client.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('authenticated host metadata drives recommendation preview and CAS apply while preserving user pins', async t => {
  const { runtimeFixture } = await import('../fixtures/runtime.ts');
  const { readFile, writeFile, realpath, mkdir, symlink } = await import('node:fs/promises');
  const { git } = await import('../../packages/core/src/git/repository.ts');
  const { resolveExecutable } = await import('../../packages/core/src/process/executable.ts');
  const f = await runtimeFixture(false), tokenPath = join(f.dir, 'metadata.token');
  const isolatedBin = join(f.dir, 'bin'); await mkdir(isolatedBin);
  await symlink((await resolveExecutable('git', { cwd: f.root })).path, join(isolatedBin, process.platform === 'win32' ? 'git.exe' : 'git'));
  const priorConfig = process.env.ORCH_CONFIG_HOME, priorPath = process.env.PATH, priorCodex = process.env.CODEX_HOME;
  process.env.ORCH_CONFIG_HOME = join(f.dir, 'global'); process.env.CODEX_HOME = join(f.dir, 'codex'); process.env.PATH = isolatedBin;
  const server = await createServer(f.root, 'codex', join(f.dir, 'managed'), tokenPath);
  const client = new Client({ name: 'metadata-contract', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
    const auth = { coordinator_token: await readFile(tokenPath, 'utf8') }, environment = (await call('orch_environment')).data;
    const model = { host: 'codex', id: 'synthetic-option', displayName: 'Synthetic fixture', resolvedId: 'synthetic-concrete', family: 'openai', support: 'advertised', access: 'unknown', availability: 'unknown', efforts: ['high'], defaultEffort: 'high', hidden: false, source: 'synthetic-host-receipt', sourceVersion: null, fetchedAt: new Date().toISOString(), expiresAt: null, evidence: [{ kind: 'synthetic', ref: 'fixture://host/models' }] };
    const receipt = { ...auth, native_tool: 'spawn_agent', native_agent_id: 'fixture-probe',
      probe: { challenge: environment.nativeHandshake.challenge, cwd: await realpath(f.root), origin_root: await realpath(f.root), branch: await git(f.root, 'branch', '--show-current'), head: await git(f.root, 'rev-parse', 'HEAD') },
      native_context: { model: model.id, effort: 'high', perInvocationModel: true, perInvocationEffort: true, models: [model, { ...model, id: 'synthetic-pinned' }] } };
    assert.equal((await call('orch_host_connect', { ...receipt, native_context: { ...receipt.native_context, models: [{ ...model, host: 'claude' }] } })).error.code, 'HOST_MODEL_METADATA_MISMATCH');
    assert.equal((await call('orch_host_connect', receipt)).data.model, 'synthetic-option');
    const { challenge: _challenge, ...refreshProbe } = receipt.probe;
    const refresh = { ...auth, native_context: receipt.native_context, probe: refreshProbe };
    assert.equal((await call('orch_host_refresh', { ...refresh, coordinator_token: 'worker' })).error.code, 'COORDINATOR_RELAY_REQUIRED');
    await call('orch_host_refresh', { ...refresh, native_context: { ...refresh.native_context, perInvocationModel: false } });
    assert.equal((await call('orch_model_recommend', { scope: 'session' })).data.recommendation.proposedPatch.length, 0);
    assert.equal((await call('orch_host_refresh', refresh)).data.state, 'READY');
    const initial = (await call('orch_config', { action: 'effective' })).data;
    const explicitPin = await call('orch_config', { ...auth, action: 'patch', scope: 'session', expected_hash: initial.hashes.session, patches: [{ path: ['hosts', 'codex', 'roles', 'reviewer', 'model'], value: model.id }, { path: ['hosts', 'codex', 'roles', 'reviewer', 'effort'], value: 'high' }] });
    assert.equal(explicitPin.error, undefined, JSON.stringify(explicitPin));
    const projectFile = join(f.root, '.orch/config.yaml'), originalProject = await readFile(projectFile, 'utf8');
    const explicitEffort = JSON.parse(originalProject); explicitEffort.hosts.codex.roles.coder.effort = 'high';
    await writeFile(projectFile, JSON.stringify(explicitEffort));
    await call('orch_host_refresh', { ...refresh, native_context: { ...refresh.native_context, perInvocationEffort: false,
      models: refresh.native_context.models.map(option => ({ ...option, defaultEffort: null })) } });
    const unsupportedRole = (await call('orch_model_recommend', { scope: 'project' })).data;
    assert.equal(unsupportedRole.recommendation.selections.some((selection: { role: string }) => selection.role === 'coder'), false);
    assert.equal(unsupportedRole.recommendation.proposedPatch.some((patch: { path: string }) => patch.path.startsWith('/hosts/codex/roles/coder/')), false);
    assert.ok(unsupportedRole.recommendation.selections.some((selection: { role: string }) => selection.role === 'tester'));
    assert.ok(unsupportedRole.recommendation.warnings.some((warning: string) => warning.includes('coder')));
    const supportedRolesApplied = await call('orch_model_recommend', { ...auth, scope: 'project', action: 'apply', approved: true,
      expected_hash: unsupportedRole.expected_hash, recommendation_hash: unsupportedRole.recommendation_hash });
    assert.equal(supportedRolesApplied.error, undefined, JSON.stringify(supportedRolesApplied));
    assert.deepEqual((await call('orch_config', { action: 'effective' })).data.layers.project.hosts.codex.roles.coder, { model: 'auto', effort: 'high' });
    await writeFile(projectFile, originalProject); await call('orch_host_refresh', refresh);
    const assessments = [
      { modelId: 'synthetic-option', quality: 9, latencyMs: 200, evidenceRefs: ['synthetic://measurement/quality-option'] },
      { modelId: 'synthetic-pinned', quality: 5, latencyMs: 20, evidenceRefs: ['synthetic://measurement/fast-option'] },
      { modelId: 'catalog-only-unsupported', quality: 100, latencyMs: 1, evidenceRefs: ['synthetic://measurement/not-native'] },
    ];
    const measured = { ...auth, scope: 'session', assessments };
    for (const invalid of [{ ...assessments[0], quality: -1 }, { ...assessments[0], latencyMs: Infinity }, { ...assessments[0], evidenceRefs: [] }]) {
      assert.equal((await client.callTool({ name: 'orch_model_recommend', arguments: { ...measured, assessments: [invalid] } })).isError, true);
    }

    assert.equal((await call('orch_model_recommend', { ...measured, coordinator_token: 'worker', profile: 'quality' })).error.code, 'COORDINATOR_RELAY_REQUIRED');
    const quality = await call('orch_model_recommend', { ...measured, profile: 'quality' });
    const fast = await call('orch_model_recommend', { ...measured, profile: 'fast' });
    assert.equal(quality.error, undefined, JSON.stringify(quality)); assert.equal(fast.error, undefined, JSON.stringify(fast));
    assert.equal(quality.data.recommendation.selections.find((selection: { role: string }) => selection.role === 'coder').modelId, 'synthetic-option');
    assert.equal(fast.data.recommendation.selections.find((selection: { role: string }) => selection.role === 'coder').modelId, 'synthetic-pinned');
    assert.ok(fast.data.recommendation.preservedOverrides.includes('/hosts/codex/roles/reviewer/model'));
    assert.equal((await call('orch_model_recommend', { ...measured, action: 'apply', profile: 'quality', approved: true,
      expected_hash: quality.data.expected_hash, recommendation_hash: quality.data.recommendation_hash,
      assessments: [{ ...assessments[0], quality: 10 }, ...assessments.slice(1)] })).error.code, 'RECOMMENDATION_CONFLICT');
    await call('orch_host_refresh', { ...refresh, native_context: { ...refresh.native_context, perInvocationEffort: false } });
    assert.equal((await call('orch_model_recommend', { ...measured, profile: 'fast' })).data.recommendation.proposedPatch.length, 0);
    await call('orch_host_refresh', refresh);
    const before = (await call('orch_config', { action: 'effective' })).data;
    const preview = await call('orch_model_recommend', { ...measured, profile: 'quality' });
    assert.equal(preview.error, undefined, JSON.stringify(preview));
    assert.equal(preview.data.recommendation.selections.find((selection: { role: string }) => selection.role === 'coder').modelId, model.id);
    assert.equal((await call('orch_config', { action: 'effective' })).data.hashes.session, before.hashes.session);
    const apply = { ...measured, profile: 'quality', action: 'apply', scope: 'session', expected_hash: preview.data.expected_hash, recommendation_hash: preview.data.recommendation_hash, approved: true };
    assert.equal((await call('orch_model_recommend', { ...apply, approved: undefined })).error.code, 'APPROVAL_REQUIRED');
    assert.equal((await call('orch_model_recommend', { ...apply, recommendation_hash: 'stale-recommendation' })).error.code, 'RECOMMENDATION_CONFLICT');
    assert.equal((await call('orch_model_recommend', apply)).error, undefined);
    assert.equal((await call('orch_model_recommend', apply)).error.code, 'CONFIG_CONFLICT');
    const effective = (await call('orch_config', { action: 'effective' })).data;
    assert.equal(effective.config.hosts.codex.roles.coder.model, model.id);
    const pinned = await call('orch_model_recommend', { scope: 'session' });
    assert.ok(pinned.data.recommendation.preservedOverrides.includes('/hosts/codex/roles/coder/model'));
    assert.equal(pinned.data.recommendation.proposedPatch.some((patch: { path: string }) => patch.path === '/hosts/codex/roles/coder/model'), false);
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    const prepared = await call('orch_task_prepare', { ...auth, protocol_version: 1, run_id: f.created.runId, operation_id: 'prepare-selected-model',
      expected_state_version: f.engine.status(f.created.runId).version, input: { task_id: 'T1' } });
    assert.equal(prepared.error, undefined, JSON.stringify(prepared));
    assert.deepEqual(prepared.data.result.nativeArguments, { model: 'synthetic-option', reasoning_effort: 'high' });
    assert.equal(prepared.data.result.modelId, 'synthetic-option'); assert.equal(prepared.data.result.effort, 'high');
    for (const scope of ['global', 'project'] as const) await t.test(`${scope} recommendation preserves pins hidden by a higher scope auto policy`, async () => {
      const initial = (await call('orch_config', { action: 'effective' })).data;
      const pin = await call('orch_config', { ...auth, action: 'patch', scope, expected_hash: initial.hashes[scope], patches: [
        { path: ['hosts', 'codex', 'roles', 'coder', 'model'], value: 'synthetic-pinned' },
        { path: ['hosts', 'codex', 'roles', 'coder', 'effort'], value: 'high' },
      ] });
      assert.equal(pin.error, undefined, JSON.stringify(pin));
      const current = (await call('orch_config', { action: 'effective' })).data;
      const mask = await call('orch_config', { ...auth, action: 'patch', scope: 'session', expected_hash: current.hashes.session, patches: [
        { path: ['hosts', 'codex', 'roles', 'coder', 'model'], value: 'auto' },
        { path: ['hosts', 'codex', 'roles', 'coder', 'effort'], value: 'auto' },
      ] });
      assert.equal(mask.error, undefined, JSON.stringify(mask));
      const recommendation = (await call('orch_model_recommend', { scope })).data;
      assert.ok(recommendation.recommendation.preservedOverrides.includes('/hosts/codex/roles/coder/model'));
      assert.equal(recommendation.recommendation.proposedPatch.some((patch: { path: string }) => patch.path === '/hosts/codex/roles/coder/model'), false);
      const applied = await call('orch_model_recommend', { ...auth, scope, action: 'apply', approved: true,
        expected_hash: recommendation.expected_hash, recommendation_hash: recommendation.recommendation_hash });
      assert.equal(applied.error, undefined, JSON.stringify(applied));
      assert.equal((await call('orch_config', { action: 'effective' })).data.layers[scope].hosts.codex.roles.coder.model, 'synthetic-pinned');
    });


  } finally {
    await client.close(); await server.close(); await f.close();
    if (priorConfig === undefined) delete process.env.ORCH_CONFIG_HOME; else process.env.ORCH_CONFIG_HOME = priorConfig;
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (priorCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodex;
  }
});
