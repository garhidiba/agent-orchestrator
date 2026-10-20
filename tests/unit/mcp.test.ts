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
    for (const name of ['orch_environment', 'orch_task_prepare', 'orch_task_bind', 'orch_task_commit', 'orch_review_submit', 'orch_finalize', 'orch_cleanup']) assert.equal(tools.tools.some(tool => tool.name === name), true);
    const result = await client.callTool({ name: 'orch_run_create', arguments: { coordinator_token: 'wrong', trusted_commands_hash: 'fake' } });
    assert.equal(result.isError, true); assert.match(JSON.stringify(result), /COORDINATOR_RELAY_REQUIRED/);
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

test('installed MCP connects the current native coordinator without a daemon and prepares inherited workers', async () => {
  const { runtimeFixture } = await import('../fixtures/runtime.ts');
  const { readFile, realpath } = await import('node:fs/promises');
  const { git } = await import('../../packages/core/src/git/repository.ts');
  const f = await runtimeFixture(false), tokenPath = join(f.dir, 'host.token');
  const server = await createServer(f.root, 'codex', join(f.dir, 'managed'), tokenPath);
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
    const receipt = { ...auth, native_tool: 'spawn_agent', native_agent_id: '/root/native-probe',
      probe: { challenge: environment.nativeHandshake.challenge, cwd: await realpath(f.root), origin_root: await realpath(f.root),
        branch: await git(f.root, 'branch', '--show-current'), head: await git(f.root, 'rev-parse', 'HEAD') } };
    assert.equal((await call('orch_host_connect', { ...receipt, coordinator_token: 'worker' })).error.code, 'COORDINATOR_RELAY_REQUIRED');
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
  } finally { await client.close(); await server.close(); await f.close(); }
});
