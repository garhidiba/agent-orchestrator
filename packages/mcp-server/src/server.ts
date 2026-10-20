import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../../core/src/runtime/engine.ts';
import { loadConfig, globalConfigPath, resolveConfig } from '../../core/src/config/index.ts';
import { createSessionConfig } from '../../core/src/config/session.ts';
import { initializeProjectConfig, patchConfig } from '../../core/src/config/write.ts';
import { doctor } from '../../installer/src/diagnostics/index.ts';
import { detectHost } from '../../installer/src/detection/host.ts';
import { getCatalogForHost } from '../../core/src/model-registry/service.ts';
import { nativeModelContextSchema, recommendModels } from '../../core/src/runtime/models.ts';
import { hash } from '../../core/src/state/store.ts';
import { exportRunEvidence } from '../../core/src/runtime/snapshots.ts';
import { buildReport, writeReport } from '../../core/src/reporting/index.ts';
import { git, inspectRepository } from '../../core/src/git/repository.ts';
import { envelopeSchema, id, nativeAgentId, sha, requirementsSchema, planSchema, reviewSchema, taskResultSchema, hostHeartbeatSchema, findingDispositionSchema, requireCondition as check } from '../../protocol/src/runtime.ts';
import type { NativeCapability, Run } from '../../core/src/runtime/engine.ts';

export async function createServer(origin: string | null, host: 'codex' | 'claude', managedRoot: string, tokenPath: string) {
  await mkdir(join(tokenPath, '..'), { recursive: true });
  try { await writeFile(tokenPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const tokenFile = await lstat(tokenPath);
  check(tokenFile.isFile() && !tokenFile.isSymbolicLink() && tokenFile.size <= 128 && (process.platform === 'win32' || (tokenFile.mode & 0o077) === 0), 'COORDINATOR_TOKEN_UNSAFE');
  const token = (await readFile(tokenPath, 'utf8')).trim();
  check(/^[a-f0-9]{64}$/.test(token), 'COORDINATOR_TOKEN_INVALID');
  const server = new McpServer({ name: 'orch', version: '0.1.0' }, { maxToolInputElements: 20000 });
  let engine: Engine | null = null, native: NativeCapability | null = null;
  let challenge = randomBytes(32).toString('hex'), challengeExpires = Date.now() + 300000;
  const session = createSessionConfig();
  const configuration = async () => {
    const loaded = await loadConfig(origin), snapshot = session.snapshot(loaded.layers);
    return { ...loaded, config: snapshot.effective, sources: snapshot.sources, layers: { ...loaded.layers, session: snapshot.config }, hashes: { ...loaded.hashes, session: snapshot.hash }, sessionRevision: snapshot.revision };
  };
  const runtime = (readOnly = false) => { check(origin, 'PROJECT_REQUIRED'); const path = join(origin, '.orch', 'state', 'state.db'); check(!readOnly || engine || existsSync(path), 'RUN_NOT_FOUND'); return engine ??= new Engine(path, native, async () => (await configuration()).config); };
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
      const { coordinator_token: _authorization, ...request } = data;
      envelopeSchema.parse(request);
      return runtime().change(data.run_id, data.operation_id, data.expected_state_version, { tool: name, input: data.input }, run => fn(run, data.input as z.infer<z.ZodObject<S>>));
    });
  }
  register('orch_doctor', {}, async () => doctor(origin, host));
  register('orch_environment', {}, async () => {
    if (!native && Date.now() > challengeExpires) { challenge = randomBytes(32).toString('hex'); challengeExpires = Date.now() + 300000; }
    const detected = await detectHost(host);
    return { installation: 'READY', host: { ...detected, executionReady: native !== null, capabilityEvidence: native?.source ?? null, capabilities: { ...detected.capabilities, nativeSubagents: native ? 'supported' : 'unknown' } }, coordinatorTokenRef: tokenPath,
      nativeDispatch: native ? 'READY' : 'NEEDS_HOST_HANDSHAKE', originRoot: origin,
      nativeControl: { transport: 'current_host_agent_tool', daemonRequired: false, executionReady: native !== null, source: native?.source ?? null, model: native?.model ?? null, effort: native?.effort ?? null, perInvocationModel: native?.perInvocationModel ?? false, perInvocationEffort: native?.perInvocationEffort ?? false },
      nativeHandshake: native ? null : { challenge, expiresAt: new Date(challengeExpires).toISOString(), originRoot: origin, nativeTool: host === 'codex' ? 'spawn_agent' : 'Agent' } };
  });
  register('orch_host_connect', { ...auth, native_tool: z.enum(['spawn_agent', 'Agent']), native_agent_id: nativeAgentId,
    native_context: nativeModelContextSchema.omit({ host: true, verified: true, contextMatches: true, evidence: true }).optional(),
    probe: z.strictObject({ challenge: z.string().regex(/^[a-f0-9]{64}$/), cwd: z.string(), origin_root: z.string(), branch: z.string(), head: sha }),
  }, async data => {
    authenticate(data.coordinator_token); check(origin, 'PROJECT_REQUIRED'); check(!native, 'HOST_ALREADY_CONNECTED');
    check(data.probe.challenge === challenge && Date.now() <= challengeExpires, 'HOST_CHALLENGE_MISMATCH');
    check(data.native_tool === (host === 'codex' ? 'spawn_agent' : 'Agent'), 'HOST_TOOL_MISMATCH');
    const repo = await inspectRepository(origin);
    check(data.probe.cwd === repo.root && data.probe.origin_root === repo.root && data.probe.branch === repo.branch && data.probe.head === repo.head, 'HOST_CONTEXT_MISMATCH');
    // Trust the authenticated parent's native-tool receipt, not a worker's JSON role or a daemon probe.
    check(!data.native_context?.models || data.native_context.models.every(model => model.host === host) && new Set(data.native_context.models.map(model => model.id)).size === data.native_context.models.length, 'HOST_MODEL_METADATA_MISMATCH');
    native = { host, model: null, effort: null, ...data.native_context, verified: true, contextMatches: true, source: 'coordinator_native_receipt', evidence: [data.native_tool, data.native_agent_id, repo.root, repo.head] };
    if (engine) engine.native = native;
    return { state: 'READY', source: native.source, host, model: native.model, effort: native.effort, perInvocationModel: native.perInvocationModel ?? false, perInvocationEffort: native.perInvocationEffort ?? false, evidence: native.evidence };
  });
  register('orch_host_refresh', { ...auth,
    native_context: nativeModelContextSchema.omit({ host: true, verified: true, contextMatches: true, evidence: true }),
    probe: z.strictObject({ cwd: z.string(), origin_root: z.string(), branch: z.string(), head: sha }),
  }, async data => {
    authenticate(data.coordinator_token); check(origin && native, 'NEEDS_HOST_HANDSHAKE');
    const repo = await inspectRepository(origin);
    check(data.probe.cwd === repo.root && data.probe.origin_root === repo.root && data.probe.branch === repo.branch && data.probe.head === repo.head, 'HOST_CONTEXT_MISMATCH');
    check(!data.native_context.models || data.native_context.models.every(model => model.host === host) && new Set(data.native_context.models.map(model => model.id)).size === data.native_context.models.length, 'HOST_MODEL_METADATA_MISMATCH');
    native = { ...native, ...data.native_context, evidence: [...native.evidence.slice(0, 2), repo.root, repo.head] };
    if (engine) engine.native = native;
    return { state: 'READY', source: native.source, model: native.model, effort: native.effort };
  });
  const currentCatalog = async () => {
    const catalog = await getCatalogForHost(origin, host);
    const models = new Map(catalog.models.map(model => [model.id, model]));
    for (const model of native?.models ?? []) {
      const current = models.get(model.id);
      if (!current || Date.parse(model.fetchedAt) > Date.parse(current.fetchedAt)) models.set(model.id, model);
    }
    return [...models.values()];
  };
  register('orch_models', { refresh: z.boolean().default(false) }, async data => ({ ...await getCatalogForHost(origin, host, { refresh: data.refresh }),
    authenticatedNative: native ? { source: native.source, model: native.model, effort: native.effort, models: native.models ?? [], evidence: native.evidence } : null }));
  register('orch_project_init', auth, async data => {
    authenticate(data.coordinator_token); check(origin, 'PROJECT_REQUIRED');
    const root = await git(origin, 'rev-parse', '--show-toplevel');
    const initialized = await initializeProjectConfig(root);
    return { ...initialized, configuration: await configuration() };
  });
  register('orch_config', { action: z.enum(['effective', 'patch', 'unset']), ...auth,
    scope: z.enum(['project', 'global', 'session']).default('project'), dry_run: z.boolean().default(false), expected_hash: z.string().optional(),
    patches: z.array(z.strictObject({ path: z.array(z.string()).min(1), value: z.unknown().optional(), remove: z.boolean().optional() })).default([]),
  }, async data => {
    if (data.action === 'effective') return configuration();
    authenticate(data.coordinator_token); check(data.expected_hash, 'CONFIG_HASH_REQUIRED');
    if (data.scope === 'project') check(origin, 'PROJECT_REQUIRED');
    const loaded = await configuration();
    const catalog = await currentCatalog();
    const patches = data.patches.map(patch => ({ ...patch, remove: data.action === 'unset' || patch.remove }));
    if (data.scope === 'session') return session.patch(data.expected_hash, patches, catalog, { layers: loaded.layers, dryRun: data.dry_run });
    return patchConfig(data.scope === 'global' ? globalConfigPath() : join(origin!, '.orch', 'config.yaml'), data.expected_hash,
      patches, catalog, { scope: data.scope, layers: loaded.layers, dryRun: data.dry_run });
  });
  register('orch_model_recommend', { ...auth, action: z.enum(['preview', 'apply']).default('preview'),
    scope: z.enum(['project', 'global', 'session']).default('project'), profile: z.enum(['balanced', 'quality', 'economy', 'fast']).optional(),
    assessments: z.array(z.strictObject({ modelId: z.string().trim().min(1).max(256), quality: z.number().finite().nonnegative().optional(),
      latencyMs: z.number().finite().nonnegative().optional(), usage: z.number().finite().nonnegative().optional(),
      evidenceRefs: z.array(z.string().trim().min(1).max(4096)).min(1).max(32) })).max(256).optional(),
    expected_hash: z.string().optional(), recommendation_hash: z.string().optional(), approved: z.literal(true).optional(),
  }, async data => {
    if (data.assessments !== undefined) authenticate(data.coordinator_token);
    if (data.action === 'apply') { authenticate(data.coordinator_token); check(data.approved, 'APPROVAL_REQUIRED'); check(data.expected_hash, 'CONFIG_HASH_REQUIRED'); }
    const loaded = await configuration(), nativeModel = native?.model ?? null;
    const catalog = native?.verified && native.contextMatches && native.perInvocationModel
      ? (native.models ?? []).filter(model => model.defaultEffort === null || native?.perInvocationEffort) : [];
    const policy = resolveConfig({ global: loaded.layers.global, project: data.scope === 'global' ? undefined : loaded.layers.project,
      session: data.scope === 'session' ? loaded.layers.session : undefined }).config;
    const recommendation = recommendModels(policy, host, catalog, { scope: data.scope, profile: data.profile,
      configRevision: loaded.sessionRevision, defaultModelId: nativeModel, assessments: data.assessments });
    const blockedRoles = recommendation.selections.filter(selection => !native?.perInvocationEffort &&
      !['auto', 'inherit'].includes(policy.hosts[host].roles[selection.role].effort)).map(selection => selection.role);
    recommendation.selections = recommendation.selections.filter(selection => !blockedRoles.includes(selection.role));
    recommendation.proposedPatch = recommendation.proposedPatch.filter(patch => !blockedRoles.some(role => patch.path.startsWith(`/hosts/${host}/roles/${role}/`)));
    if (blockedRoles.length) recommendation.warnings.push(`Skipped roles whose explicit effort requires unavailable native invocation capability: ${blockedRoles.join(', ')}`);
    const recommendationHash = hash({ recommendation, assessments: data.assessments ?? [] });
    if (data.action === 'preview') return { recommendation, expected_hash: loaded.hashes[data.scope], recommendation_hash: recommendationHash };
    check(data.expected_hash === loaded.hashes[data.scope], 'CONFIG_CONFLICT');
    check(data.recommendation_hash === recommendationHash, 'RECOMMENDATION_CONFLICT');
    const patches = recommendation.proposedPatch.map(patch => ({ path: patch.path.split('/').slice(1),
      ...('value' in patch ? { value: patch.value } : {}), remove: patch.op === 'remove' }));
    if (data.scope === 'session') return { recommendation, result: session.patch(data.expected_hash!, patches, catalog, { layers: loaded.layers }) };
    if (data.scope === 'project') check(origin, 'PROJECT_REQUIRED');
    return { recommendation, result: await patchConfig(data.scope === 'global' ? globalConfigPath() : join(origin!, '.orch', 'config.yaml'),
      data.expected_hash!, patches, catalog, { scope: data.scope, layers: loaded.layers }) };
  });
  register('orch_run_create', { ...auth, trusted_commands_hash: z.string(), missing_tests_waiver: z.strictObject({ approved: z.literal(true), reason: z.string().min(1).max(4096) }).optional() }, async data => {
    authenticate(data.coordinator_token); check(origin, 'PROJECT_REQUIRED'); const config = await configuration();
    return runtime().create(origin, config.config, host, managedRoot, data.trusted_commands_hash, { missingTestsWaiver: data.missing_tests_waiver });
  });
  register('orch_run_status', scoped, async data => { const snapshot = runtime(true).status(data.run_id); return { ...snapshot, readyTasks: runtime().ready(snapshot.data), dispatchBlocked: native ? null : 'NEEDS_HOST_HANDSHAKE', pendingOperations: runtime().store.pending(data.run_id).map(item => item.id) }; });
  mutation('orch_requirements_submit', { requirements: requirementsSchema }, (run, data) => runtime().submitRequirements(run, data.requirements));
  mutation('orch_plan_submit', { plan: planSchema, approved: z.boolean() }, (run, data) => runtime().plan(run, data.plan, data.approved));
  mutation('orch_task_prepare', { task_id: id }, (run, data) => runtime().prepare(run, data.task_id));
  const lease = { task_id: id, lease_id: z.string(), fencing_token: z.int().positive() };
  mutation('orch_attempt_port', { ...lease, action: z.enum(['status', 'release_for_claim']) }, (run, data) => runtime().attemptPort(run, data.task_id, data.lease_id, data.fencing_token, data.action));
  mutation('orch_task_bind', { ...lease, native_id: nativeAgentId, observed_model: z.string().nullable(), observed_effort: z.string().nullable(), bootstrap: z.strictObject({ cwd: z.string(), origin_root: z.string(), common_dir: z.string(), branch: z.string(), head: sha }).optional() }, (run, data) => runtime().bind(run, data.task_id, data.lease_id, data.fencing_token, data.native_id, data.observed_model, data.observed_effort, data.bootstrap));
  mutation('orch_heartbeat', { ...lease, native_id: nativeAgentId, receipt: hostHeartbeatSchema }, (run, data) => runtime().heartbeat(run, data.task_id, data.lease_id, data.fencing_token, data.native_id, data.receipt));
  mutation('orch_liveness_reconcile', {}, run => runtime().reconcileLiveness(run));
  mutation('orch_task_checkpoint', { ...lease, summary: z.string().max(4096) }, async (run, data) => {
    const task = runtime().leased(run, data.task_id, data.lease_id, data.fencing_token);
    return { state: task.state, summary: data.summary, leaseRenewed: false };
  });
  mutation('orch_task_retry', { ...lease, native_stopped: z.boolean(), reason: z.string().min(1).max(4096) }, (run, data) => runtime().retry(run, data.task_id, data.lease_id, data.fencing_token, data.native_stopped, data.reason));
  mutation('orch_task_validate', lease, (run, data) => runtime().validate(run, data.task_id, data.lease_id, data.fencing_token));
  mutation('orch_task_commit', { ...lease, unit_id: id }, (run, data) => runtime().commit(run, data.task_id, data.lease_id, data.fencing_token, data.unit_id));
  mutation('orch_task_complete', { ...lease, native_stopped: z.boolean(), result: taskResultSchema }, (run, data) => runtime().complete(run, data.task_id, data.lease_id, data.fencing_token, data.native_stopped, data.result ?? null));
  mutation('orch_integrate', { task_id: id, expected_integration_sha: z.string() }, (run, data) => runtime().integrate(run, data.task_id, data.expected_integration_sha));
  mutation('orch_conflict_resolve', { native_stopped: z.boolean() }, (run, data) => runtime().resolveConflict(run, data.native_stopped));
  register('orch_reconcile', { ...auth, run_id: id, operation_id: id, previous_coordinator_stopped: z.boolean() }, async data => { authenticate(data.coordinator_token); return runtime().reconcile(data.run_id, data.operation_id, data.previous_coordinator_stopped); });
  mutation('orch_verify', {}, run => runtime().verify(run));
  register('orch_review_snapshot', scoped, async data => {
    const snapshot = runtime(true).status(data.run_id); return { reviewedSha: await git(snapshot.data.integrationPath, 'rev-parse', 'HEAD'), version: snapshot.version, plan: snapshot.data.plan, gates: snapshot.data.gates, findings: snapshot.data.findings, integrationPath: snapshot.data.integrationPath };
  });
  mutation('orch_review_prepare', { role: z.enum(['reviewer', 'final_auditor']) }, (run, data) => runtime().prepareReview(run, data.role));
  mutation('orch_review_bind', { dispatch_id: id, native_id: nativeAgentId, observed_model: z.string().nullable(), observed_effort: z.string().nullable(), reviewed_sha: sha }, (run, data) => runtime().bindReview(run, data.dispatch_id, data.native_id, data.observed_model, data.observed_effort, data.reviewed_sha));
  mutation('orch_review_stop', { dispatch_id: id, native_id: nativeAgentId.nullable(), native_stopped: z.literal(true) }, (run, data) => runtime().stopReview(run, data.dispatch_id, data.native_stopped, data.native_id));
  mutation('orch_finding_disposition', findingDispositionSchema.shape, (run, data) => runtime().disposeFinding(run, data.finding_id, data.status, data.reason, data.approved));
  mutation('orch_reintegrate', { expected_target_sha: sha }, (run, data) => runtime().reintegrateTarget(run, data.expected_target_sha));
  mutation('orch_review_submit', { review: reviewSchema, final: z.boolean().default(false), native_stopped: z.boolean().default(false) }, (run, data) => runtime().review(run, data.review, data.final, data.native_stopped));
  mutation('orch_repair_plan_submit', { plan: planSchema, finding_ids: z.array(id), analysis: z.string().min(1).max(8192).optional() }, (run, data) => runtime().repair(run, data.plan, data.finding_ids, data.analysis));
  mutation('orch_run_control', { action: z.enum(['pause', 'cancel', 'resume']), stopped_agents: z.array(nativeAgentId).default([]), never_started_tasks: z.array(id).default([]) }, (run, data) => runtime().control(run, data.action, data.stopped_agents, data.never_started_tasks));
  mutation('orch_gate_waive', { stage: z.enum(['baseline', 'task', 'integration', 'final']), gate_id: id, task_id: id.nullable(), reason: z.string().min(1).max(4096), approved: z.literal(true) }, (run, data) => runtime().waiveGate(run, data.stage, data.gate_id, data.task_id, data.reason, data.approved));
  mutation('orch_finalize_approve', { approved: z.literal(true), target_branch: z.string().min(1) }, (run, data) => runtime().preapproveFinalization(run, data.target_branch, data.approved));
  mutation('orch_finalize', { approved: z.boolean(), expected_target_sha: z.string() }, (run, data) => runtime().finalize(run, data.approved, data.expected_target_sha));
  mutation('orch_cleanup', { dry_run: z.boolean().default(true) }, (run, data) => runtime().cleanup(run, data.dry_run));
  register('orch_export', { ...auth, ...scoped }, async data => { authenticate(data.coordinator_token); const current = runtime(true); return exportRunEvidence(current.store, current.origin, data.run_id); });
  register('orch_report', { ...scoped, ...auth, persist: z.boolean().default(false) }, async data => {
    const { version, data: run } = runtime(true).status(data.run_id);
    const actual = await git(run.origin, 'rev-parse', '--verify', `refs/heads/${run.target}`).catch(() => null);
    const report = buildReport(run, version, actual);
    if (data.persist) { authenticate(data.coordinator_token); return { report, artifacts: await writeReport(run, report) }; }
    return report;
  });
  server.registerResource('run', new ResourceTemplate('orch://runs/{runId}', { list: undefined }), { mimeType: 'application/json' }, async (uri, vars) => {
    const runId = id.parse(vars.runId); return { contents: [{ uri: uri.href, text: JSON.stringify(runtime(true).status(runId)) }] };
  });
  server.server.onclose = async () => {
    try { await engine?.disposePorts(); }
    catch { process.stderr.write('ORCH_PORT_CLEANUP_FAILED\n'); }
    finally { engine?.store.close(); }
  };
  return server;
}
