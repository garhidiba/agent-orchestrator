import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Engine } from '../../core/src/runtime/engine.ts';
import { loadConfig, globalConfigPath } from '../../core/src/config/index.ts';
import { patchConfig } from '../../core/src/config/write.ts';
import { detectHost } from '../../installer/src/detection/host.ts';
import { discoverCodexModels } from '../../host-codex/src/catalog.ts';
import { discoverClaudeModels } from '../../host-claude/src/catalog.ts';
import { envelopeSchema, id, planSchema, reviewSchema, requireCondition as check } from '../../protocol/src/runtime.ts';
import type { Run } from '../../core/src/runtime/engine.ts';

export async function createServer(origin: string, host: 'codex' | 'claude', managedRoot: string, tokenPath: string) {
  await mkdir(join(tokenPath, '..'), { recursive: true });
  try { await writeFile(tokenPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const token = (await readFile(tokenPath, 'utf8')).trim();
  check(token.length >= 32, 'COORDINATOR_TOKEN_INVALID');
  const server = new McpServer({ name: 'orch', version: '0.1.0' }, { maxToolInputElements: 20000 });
  let engine: Engine | null = null;
  const runtime = () => engine ??= new Engine(join(origin, '.orch', 'state', 'state.db'));
  const authenticate = (value: string) => {
    const incoming = Buffer.from(value), expected = Buffer.from(token);
    check(incoming.length === expected.length && timingSafeEqual(incoming, expected), 'COORDINATOR_RELAY_REQUIRED');
  };
  const output = (value: unknown) => {
    const text = JSON.stringify({ protocol_version: 1, data: value });
    check(Buffer.byteLength(text) < 256 * 1024, 'RESPONSE_TOO_LARGE_USE_RESOURCE');
    return { content: [{ type: 'text' as const, text }] };
  };
  function register<S extends z.ZodRawShape>(name: string, shape: S, fn: (input: z.infer<z.ZodObject<S>>) => Promise<unknown>) {
    server.registerTool<z.ZodRawShape, z.ZodRawShape>(name, { description: `ORCH ${name}; writes require coordinator relay, never a JSON role claim.`, inputSchema: shape }, async (raw: unknown) => {
      try { return output(await fn(z.strictObject(shape).parse(raw))); }
      catch (error) {
        const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'ORCH_OPERATION_FAILED';
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ protocol_version: 1, error: { code } }) }] };
      }
    });
  }
  const auth = { coordinator_token: z.string().default('') };
  const scoped = { run_id: id };
  function mutation<S extends z.ZodRawShape>(name: string, input: S, fn: (run: Run, data: z.infer<z.ZodObject<S>>) => Promise<unknown>) {
    register(name, { ...envelopeSchema.shape, ...auth, input: z.strictObject(input) }, async data => {
      authenticate(data.coordinator_token);
      return runtime().change(data.run_id, data.operation_id, data.expected_state_version, { tool: name, input: data.input }, run => fn(run, data.input as z.infer<z.ZodObject<S>>));
    });
  }
  register('orch_environment', {}, async () => ({ installation: 'development', host: await detectHost(host), coordinatorTokenRef: tokenPath, nativeDispatch: 'BLOCKED_CAPABILITY', originRoot: origin }));
  register('orch_models', { refresh: z.boolean().default(false) }, async () => host === 'codex' ? discoverCodexModels() : discoverClaudeModels());
  register('orch_config', { action: z.enum(['effective', 'patch', 'unset']), ...auth,
    scope: z.enum(['project', 'global']).default('project'), expected_hash: z.string().optional(),
    patches: z.array(z.strictObject({ path: z.array(z.string()).min(1), value: z.unknown().optional(), remove: z.boolean().optional() })).default([]),
  }, async data => {
    if (data.action === 'effective') return loadConfig(origin);
    authenticate(data.coordinator_token); check(data.expected_hash, 'CONFIG_HASH_REQUIRED');
    // Concrete model edits remain blocked until a same-context, provider-verified catalog exists.
    return patchConfig(data.scope === 'global' ? globalConfigPath() : join(origin, '.orch', 'config.yaml'), data.expected_hash,
      data.patches.map(patch => ({ ...patch, remove: data.action === 'unset' || patch.remove })));
  });
  register('orch_run_create', { ...auth, trusted_commands_hash: z.string() }, async data => {
    authenticate(data.coordinator_token); const config = await loadConfig(origin);
    return runtime().create(origin, config.config, host, managedRoot, data.trusted_commands_hash);
  });
  register('orch_run_status', scoped, async data => runtime().status(data.run_id));
  mutation('orch_plan_submit', { plan: planSchema, approved: z.boolean() }, (run, data) => runtime().plan(run, data.plan, data.approved));
  mutation('orch_task_prepare', { task_id: id }, (run, data) => runtime().prepare(run, data.task_id));
  const lease = { task_id: id, lease_id: z.string(), fencing_token: z.int().positive() };
  mutation('orch_task_bind', { ...lease, native_id: id, observed_model: z.string().nullable(), observed_effort: z.string().nullable() }, (run, data) => runtime().bind(run, data.task_id, data.lease_id, data.fencing_token, data.native_id, data.observed_model, data.observed_effort));
  mutation('orch_task_checkpoint', { ...lease, summary: z.string().max(4096) }, async (run, data) => {
    const task = runtime().leased(run, data.task_id, data.lease_id, data.fencing_token);
    return { state: task.state, summary: data.summary, leaseRenewed: false };
  });
  mutation('orch_task_validate', lease, (run, data) => runtime().validate(run, data.task_id, data.lease_id, data.fencing_token));
  mutation('orch_task_commit', { ...lease, unit_id: id }, (run, data) => runtime().commit(run, data.task_id, data.lease_id, data.fencing_token, data.unit_id));
  mutation('orch_task_complete', { ...lease, native_stopped: z.boolean() }, (run, data) => runtime().complete(run, data.task_id, data.lease_id, data.fencing_token, data.native_stopped));
  mutation('orch_integrate', { task_id: id, expected_integration_sha: z.string() }, (run, data) => runtime().integrate(run, data.task_id, data.expected_integration_sha));
  mutation('orch_verify', {}, run => runtime().verify(run));
  register('orch_review_snapshot', scoped, async data => {
    const snapshot = runtime().status(data.run_id); return { version: snapshot.version, plan: snapshot.data.plan, gates: snapshot.data.gates, findings: snapshot.data.findings, integrationPath: snapshot.data.integrationPath };
  });
  mutation('orch_review_submit', { review: reviewSchema, final: z.boolean().default(false) }, (run, data) => runtime().review(run, data.review, data.final));
  mutation('orch_repair_plan_submit', { plan: planSchema, finding_ids: z.array(id) }, (run, data) => runtime().repair(run, data.plan, data.finding_ids));
  mutation('orch_run_control', { action: z.enum(['pause', 'cancel', 'resume']), stopped_agents: z.array(id).default([]) }, (run, data) => runtime().control(run, data.action, data.stopped_agents));
  mutation('orch_finalize', { approved: z.boolean(), expected_target_sha: z.string() }, (run, data) => runtime().finalize(run, data.approved, data.expected_target_sha));
  mutation('orch_cleanup', { dry_run: z.boolean().default(true) }, (run, data) => runtime().cleanup(run, data.dry_run));
  register('orch_report', scoped, async data => {
    const { version, data: run } = runtime().status(data.run_id);
    return { version, state: run.state, host: run.host, target: run.target, base: run.targetBase, findings: run.findings, gates: run.gates, cleanup: run.cleanup, observedUsage: null, cost: null };
  });
  server.registerResource('run', new ResourceTemplate('orch://runs/{runId}', { list: undefined }), { mimeType: 'application/json' }, async (uri, vars) => {
    const runId = id.parse(vars.runId); return { contents: [{ uri: uri.href, text: JSON.stringify(runtime().status(runId)) }] };
  });
  server.server.onclose = () => { engine?.store.close(); };
  return server;
}
