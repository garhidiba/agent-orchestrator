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
