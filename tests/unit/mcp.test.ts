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
