import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Store, hash } from '../state/store.ts';
import { git, inspectRepository, within, owns, overlaps, changedPaths, sourceFingerprint } from '../git/repository.ts';
import { configSchema } from '../../../protocol/src/config.ts';
import type { Config } from '../../../protocol/src/config.ts';
import { id, requireCondition as check, validatePlan, reviewSchema } from '../../../protocol/src/runtime.ts';
import type { Task, Plan, Review } from '../../../protocol/src/runtime.ts';

const exec = promisify(execFile);
type Gate = { stage: string; task: string | null; sha: string; source: string; commands: string; status: string; results: { id: string; status: string; exitCode: number | null }[] };
type Work = { spec: Task; state: string; base: string; path: string; branch: string; attempt: number; lease: string; expires: number; nativeId: string | null; units: Record<string, string>; validated: string | null };
type Finding = Review['findings'][number] & { fingerprint: string; lifecycle: string };
export type Run = {
  id: string; host: 'codex' | 'claude'; origin: string; commonDir: string; target: string; targetBase: string;
  integration: string; integrationPath: string; managedRoot: string; state: string; config: Config;
  plan: Plan | null; tasks: Record<string, Work>; gates: Gate[]; findings: Finding[];
  reviews: { sha: string; reviewer: string; final: boolean }[]; reviewRound: number;
  createdAt: string; pausedFrom?: string; cleanup: { path: string; status: string; reason: string | null }[];
};
export type NativeCapability = {
  host: 'codex' | 'claude'; model: string; effort: string | null; evidence: string[];
  verified: boolean; contextMatches: boolean;
};

export class Engine {
  store: Store;
  readonly native: NativeCapability | null;
  constructor(statePath: string, native: NativeCapability | null = null) { this.store = new Store(statePath); this.native = native; }
  status(run: string) { return this.store.get<Run>(id.parse(run)); }
  async create(origin: string, configInput: unknown, host: 'codex' | 'claude', managedRoot: string, trustedCommandsHash: string) {
    const repo = await inspectRepository(origin), config = configSchema.parse(configInput);
    check(!repo.dirty, 'DIRTY_CHECKOUT');
    check(config.quality.commands.length > 0 && hash(config.quality.commands) === trustedCommandsHash, 'TRUST_APPROVAL_REQUIRED');
    check(config.quality.commands.some(command => command.required && command.stages.includes('baseline')) &&
      config.quality.commands.some(command => command.required && command.stages.includes('final')), 'REQUIRED_GATES_MISSING');
    check(!config.git.target_branch || config.git.target_branch === repo.branch, 'TARGET_BRANCH_MISMATCH');
    await git(repo.root, 'check-ignore', '.orch/state/probe').catch(() => { throw new Error('STATE_IGNORE_REQUIRED'); });
    await mkdir(managedRoot, { recursive: true });
    const managed = await realpath(managedRoot);
    check(!within(repo.root, managed) && managed !== repo.root, 'WORKTREE_ROOT_UNSAFE');
    const runId = `run-${randomUUID()}`;
    const lock = join(repo.commonDir, 'orch', 'locks'); await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'write.json'), JSON.stringify({ runId, origin: repo.root }), { flag: 'wx', mode: 0o600 }).catch(() => { throw new Error('REPOSITORY_RUN_LOCKED'); });
    const integration = `orch/${runId}/integration`, integrationPath = join(managed, runId, 'integration');
    const run: Run = { id: runId, host, origin: repo.root, commonDir: repo.commonDir, target: repo.branch, targetBase: repo.head,
      integration, integrationPath, managedRoot: managed, state: 'PREFLIGHT', config, plan: null, tasks: {}, gates: [], findings: [], reviews: [], reviewRound: 0,
      createdAt: new Date().toISOString(), cleanup: [] };
    this.store.create(runId, run);
    return { runId, version: 0 };
  }
  async change(runId: string, operation: string, expected: number, input: unknown, fn: (run: Run) => Promise<unknown>) {
    id.parse(operation);
    const snapshot = this.status(runId);
    const mutex = join(snapshot.data.commonDir, 'orch', 'locks', 'operation');
    await mkdir(mutex).catch(() => { throw new Error('OPERATION_LOCKED'); });
    try {
      const current = this.status(runId);
      const previous = this.store.intent(runId, operation, input);
      if (previous) {
        check(previous.status === 'complete', 'RECONCILIATION_REQUIRED');
        return previous.result;
      }
      check(current.version === expected, 'STATE_CONFLICT');
      const result = await fn(current.data);
      const response = { version: current.version + 1, result };
      return this.store.save(runId, current.version, current.data, 'run.changed', operation, response);
    } finally { await rmdir(mutex); }
  }
  async gate(run: Run, stage: string, path: string, task: string | null = null) {
    const commands = run.config.quality.commands.filter(command => command.stages.includes(stage as 'baseline'));
    check(commands.some(command => command.required), 'REQUIRED_GATES_MISSING');
    const fingerprint = await sourceFingerprint(path);
    const result: Gate = { stage, task, sha: await git(path, 'rev-parse', 'HEAD'), source: fingerprint,
      commands: hash(run.config.quality.commands), status: 'passed', results: [] };
    for (const command of commands) {
      const cwd = await realpath(resolve(path, command.cwd));
      check(cwd === await realpath(path) || within(await realpath(path), cwd), 'GATE_CWD_OUTSIDE_ROOT');
      let status = 'passed', exitCode: number | null = 0;
      try { await exec(command.executable, command.args, { cwd, timeout: command.timeout_seconds * 1000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }); }
      catch (error) {
        const failure = error as { killed?: boolean; code?: number };
        status = failure.killed ? 'timed_out' : 'failed'; exitCode = typeof failure.code === 'number' ? failure.code : null;
        if (command.required) result.status = status;
      }
      result.results.push({ id: command.id, status, exitCode });
    }
    if (await sourceFingerprint(path) !== fingerprint) result.status = 'source_changed';
    run.gates.push(result);
    return result;
  }
  async plan(run: Run, input: unknown, approved: boolean) {
    check(run.state === 'PREFLIGHT' || run.state === 'PLAN_READY', 'INVALID_RUN_STATE');
    const plan = validatePlan(input);
    const gateIds = new Set(run.config.quality.commands.map(command => command.id));
    check(plan.tasks.every(task => task.verification_ids.every(key => gateIds.has(key))), 'UNKNOWN_VERIFICATION');
    run.plan = plan;
    if (!approved) { run.state = 'PLAN_READY'; return { state: run.state }; }
    const baseline = await this.gate(run, 'baseline', run.origin);
    if (baseline.status !== 'passed') { run.state = 'BLOCKED_BASELINE'; return baseline; }
    await git(run.origin, 'worktree', 'add', '-b', run.integration, run.integrationPath, run.targetBase);
    for (const task of plan.tasks) run.tasks[task.id] = { spec: task, state: 'PENDING', base: '', path: '', branch: '', attempt: 0, lease: '', expires: 0, nativeId: null, units: {}, validated: null };
    run.state = 'EXECUTING'; return { state: run.state };
  }
  async prepare(run: Run, taskId: string) {
    check(run.state === 'EXECUTING', 'INVALID_RUN_STATE');
    check(this.native?.verified && this.native.contextMatches && this.native.host === run.host && this.native.evidence.length, 'BLOCKED_CAPABILITY');
    check(Date.now() - Date.parse(run.createdAt) < run.config.execution.run_timeout_minutes * 60000, 'RUN_TIMEOUT');
    const task = run.tasks[taskId]; check(task, 'TASK_NOT_FOUND');
    check(['PENDING', 'RETRYABLE_FAILED'].includes(task.state), 'TASK_NOT_READY');
    check(task.attempt < run.config.execution.max_task_attempts, 'TASK_ATTEMPT_LIMIT');
    check(task.spec.depends_on.every(key => run.tasks[key].state === 'INTEGRATED'), 'DEPENDENCY_NOT_INTEGRATED');
    const active = Object.values(run.tasks).filter(work => ['LEASED', 'RUNNING', 'VALIDATING', 'ORPHANED_UNKNOWN'].includes(work.state));
    check(active.length < run.config.execution.max_parallel_workers, 'WORKER_LIMIT');
    check(!active.some(work => overlaps(work.spec.write_paths, task.spec.write_paths) || work.spec.exclusive_resources.some(resource => task.spec.exclusive_resources.includes(resource))), 'OWNERSHIP_CONFLICT');
    const requested = run.config.hosts[run.host].roles[task.spec.role];
    check(['auto', 'inherit', this.native.model].includes(requested.model), 'MODEL_NOT_SUPPORTED');
    check(['auto', 'inherit', this.native.effort].includes(requested.effort), 'EFFORT_NOT_SUPPORTED');
    task.attempt++; task.lease = randomUUID(); task.expires = Date.now() + run.config.execution.task_timeout_minutes * 60000;
    task.base = await git(run.integrationPath, 'rev-parse', 'HEAD');
    task.branch = `orch/${run.id}/task/${taskId}-${task.attempt}`;
    task.path = join(run.managedRoot, run.id, `${taskId}-${task.attempt}`);
    check(within(run.managedRoot, task.path), 'WORKTREE_ROOT_UNSAFE');
    await git(run.origin, 'worktree', 'add', '-b', task.branch, task.path, task.base);
    task.state = 'LEASED';
    return { runId: run.id, taskId, attemptId: `${taskId}-${task.attempt}`, host: run.host, role: task.spec.role,
      modelId: this.native.model, effort: this.native.effort, baseSha: task.base, worktreePath: task.path,
      isolation: 'core_managed', leaseId: task.lease, fencingToken: task.attempt, expiresAt: new Date(task.expires).toISOString(), taskBrief: task.spec };
  }
  leased(run: Run, taskId: string, lease: string, generation: number) {
    const task = run.tasks[taskId]; check(task, 'TASK_NOT_FOUND');
    check(task.lease === lease && task.attempt === generation && Date.now() < task.expires, 'STALE_LEASE');
    return task;
  }
  async bind(run: Run, taskId: string, lease: string, generation: number, nativeId: string, observedModel: string | null, observedEffort: string | null) {
    const task = this.leased(run, taskId, lease, generation);
    check(task.state === 'LEASED', 'INVALID_TASK_STATE');
    const repo = await inspectRepository(task.path);
    check(repo.root === await realpath(task.path) && repo.commonDir === run.commonDir && repo.branch === task.branch && repo.head === task.base && !repo.dirty, 'BASE_SHA_MISMATCH');
    check(observedModel === this.native?.model && observedEffort === this.native?.effort, 'MODEL_OBSERVATION_MISMATCH');
    task.nativeId = id.parse(nativeId); task.state = 'RUNNING';
    return { state: task.state };
  }
  async validate(run: Run, taskId: string, lease: string, generation: number) {
    const task = this.leased(run, taskId, lease, generation);
    check(task.state === 'RUNNING', 'INVALID_TASK_STATE');
    const paths = await changedPaths(task.path, task.base);
    check(paths.every(path => owns(task.spec.write_paths, path)), 'OWNERSHIP_VIOLATION');
    const gate = await this.gate(run, 'task', task.path, taskId);
    task.validated = gate.status === 'passed' ? gate.source : null;
    return gate;
  }
  async commit(run: Run, taskId: string, lease: string, generation: number, unit: string) {
    const task = this.leased(run, taskId, lease, generation);
    check(task.state === 'RUNNING', 'INVALID_TASK_STATE');
    const spec = task.spec.commit_units.find(candidate => candidate.id === unit); check(spec, 'UNKNOWN_UNIT');
    if (task.units[unit]) return { sha: task.units[unit] };
    check(task.validated && task.validated === await sourceFingerprint(task.path), 'VALIDATION_STALE');
    const paths = await changedPaths(task.path);
    check(paths.length && paths.every(path => owns(task.spec.write_paths, path)), 'OWNERSHIP_VIOLATION');
    check((await changedPaths(task.path, task.base)).every(path => owns(task.spec.write_paths, path)), 'OWNERSHIP_VIOLATION');
    await git(task.path, 'add', '--', ...paths);
    await git(task.path, 'diff', '--cached', '--check');
    await git(task.path, 'commit', '-m', `${spec.purpose}\n\nOrch-Run: ${run.id}\nOrch-Task: ${taskId}\nOrch-Unit: ${unit}`);
    const sha = await git(task.path, 'rev-parse', 'HEAD'); task.units[unit] = sha; task.validated = null;
    return { sha };
  }
  async complete(run: Run, taskId: string, lease: string, generation: number, nativeStopped: boolean) {
    const task = this.leased(run, taskId, lease, generation);
    check(nativeStopped, 'WORKER_STOP_UNCONFIRMED');
    check(task.state === 'RUNNING' && task.spec.commit_units.every(unit => task.units[unit.id]), 'UNITS_INCOMPLETE');
    check(!(await inspectRepository(task.path)).dirty, 'DIRTY_CHECKOUT');
    await git(task.path, 'merge-base', '--is-ancestor', task.base, 'HEAD');
    const submitted = (await git(task.path, 'rev-list', `${task.base}..HEAD`)).split('\n').filter(Boolean);
    check(submitted.length === Object.keys(task.units).length && submitted.every(sha => Object.values(task.units).includes(sha)), 'UNTRACKED_COMMIT');
    task.state = 'MERGE_QUEUED'; return { state: task.state };
  }
  async integrate(run: Run, taskId: string, expectedSha: string) {
    const task = run.tasks[taskId]; check(task?.state === 'MERGE_QUEUED', 'TASK_NOT_READY');
    check(await git(run.integrationPath, 'rev-parse', 'HEAD') === expectedSha, 'INTEGRATION_DRIFT');
    check(!(await inspectRepository(run.integrationPath)).dirty, 'DIRTY_CHECKOUT');
    try { await git(run.integrationPath, 'merge', '--no-ff', '--no-edit', task.branch); }
    catch { run.state = 'BLOCKED_CONFLICT'; return { state: run.state, preserved: run.integrationPath, expectedSha, taskHead: await git(task.path, 'rev-parse', 'HEAD') }; }
    const parents = (await git(run.integrationPath, 'show', '-s', '--format=%P', 'HEAD')).split(' ');
    check(parents.includes(expectedSha) && parents.includes(await git(task.path, 'rev-parse', 'HEAD')), 'MERGE_PARENTS_MISMATCH');
    task.state = 'INTEGRATED'; run.reviews = [];
    if (Object.values(run.tasks).every(work => work.state === 'INTEGRATED')) run.state = 'VERIFYING';
    return { sha: await git(run.integrationPath, 'rev-parse', 'HEAD'), state: run.state };
  }
  async verify(run: Run) {
    check(run.state === 'VERIFYING' || run.state === 'REVIEWING', 'INVALID_RUN_STATE');
    const gate = await this.gate(run, 'integration', run.integrationPath);
    run.state = gate.status === 'passed' ? 'REVIEWING' : 'BLOCKED_TESTS'; return gate;
  }
  async review(run: Run, input: unknown, final = false) {
    check(run.state === (final ? 'FINAL_AUDIT' : 'REVIEWING'), 'INVALID_RUN_STATE');
    const review = reviewSchema.parse(input), current = await git(run.integrationPath, 'rev-parse', 'HEAD');
    check(review.reviewed_sha === current, 'REVIEW_STALE');
    check(run.gates.some(gate => gate.stage === 'integration' && gate.sha === current && gate.status === 'passed' && gate.commands === hash(run.config.quality.commands)), 'VALIDATION_STALE');
    check(run.gates.filter(gate => gate.stage === 'integration').at(-1)?.source === await sourceFingerprint(run.integrationPath), 'VALIDATION_STALE');
    check(!Object.values(run.tasks).some(task => task.nativeId === review.reviewer_id), 'REVIEW_NOT_INDEPENDENT');
    check(!final || !run.reviews.some(item => item.reviewer === review.reviewer_id), 'AUDIT_NOT_INDEPENDENT');
    check(run.plan?.acceptance.every(item => review.acceptance_ids.includes(item.id)), 'UNMAPPED_ACCEPTANCE');
    check(review.findings.every(finding => run.plan?.acceptance.some(item => finding.acceptance_ids.includes(item.id))), 'UNKNOWN_ACCEPTANCE');
    const incoming = review.findings.map(finding => ({ ...finding, fingerprint: hash([finding.path, finding.symbol, finding.category, finding.acceptance]), lifecycle: 'OPEN' }));
    for (const finding of incoming) {
      const old = run.findings.find(item => item.id === finding.id || item.fingerprint === finding.fingerprint);
      if (old) Object.assign(old, finding, { id: old.id, lifecycle: old.lifecycle === 'VERIFIED_FIXED' ? 'REOPENED' : 'OPEN' });
      else run.findings.push(finding);
    }
    // Absence is only accepted after an independent full review of the same verified SHA.
    for (const finding of run.findings) if (finding.lifecycle === 'FIX_PROPOSED' && !incoming.some(item => item.fingerprint === finding.fingerprint || item.id === finding.id)) finding.lifecycle = 'VERIFIED_FIXED';
    const blocking = run.findings.some(finding => finding.lifecycle !== 'VERIFIED_FIXED' && run.config.review.block_on.includes(finding.severity));
    run.reviews.push({ sha: current, reviewer: review.reviewer_id, final });
    if (blocking || review.decision === 'changes_requested') run.state = run.reviewRound >= run.config.execution.max_review_rounds ? 'BLOCKED_REVIEW_LIMIT' : 'REPAIR_PLANNING';
    else run.state = final ? 'READY_TO_FINALIZE' : 'FINAL_AUDIT';
    return { state: run.state, findings: run.findings };
  }
  async repair(run: Run, input: unknown, findingIds: string[]) {
    check(run.state === 'REPAIR_PLANNING' && run.reviewRound < run.config.execution.max_review_rounds, 'BLOCKED_REVIEW_LIMIT');
    const plan = validatePlan(input);
    check(plan.tasks.every(task => !run.tasks[task.id]), 'DUPLICATE_ID');
    const unresolved = run.findings.filter(finding => finding.lifecycle !== 'VERIFIED_FIXED' && run.config.review.block_on.includes(finding.severity));
    check(unresolved.every(finding => findingIds.includes(finding.id) && plan.tasks.some(task => owns(task.write_paths, finding.path))), 'FINDING_UNMAPPED');
    for (const finding of unresolved) finding.lifecycle = 'FIX_PROPOSED';
    for (const spec of plan.tasks) run.tasks[spec.id] = { spec, state: 'PENDING', base: '', path: '', branch: '', attempt: 0, lease: '', expires: 0, nativeId: null, units: {}, validated: null };
    run.reviewRound++; run.state = 'EXECUTING'; return { state: run.state, round: run.reviewRound };
  }
  async finalize(run: Run, approved: boolean, expectedTarget: string) {
    check(run.state === 'READY_TO_FINALIZE', 'INVALID_RUN_STATE');
    check(approved, 'APPROVAL_REQUIRED');
    const repo = await inspectRepository(run.origin), head = await git(run.integrationPath, 'rev-parse', 'HEAD');
    check(repo.branch === run.target && repo.head === run.targetBase && repo.head === expectedTarget, 'TARGET_DRIFT');
    check(!repo.dirty && !(await inspectRepository(run.integrationPath)).dirty, 'DIRTY_CHECKOUT');
    check(run.reviews.some(review => review.sha === head && review.final), 'REVIEW_STALE');
    const gate = await this.gate(run, 'final', run.integrationPath);
    if (gate.status !== 'passed') { run.state = 'BLOCKED_TESTS'; return gate; }
    await git(run.origin, 'merge', '--ff-only', run.integration);
    check(await git(run.origin, 'rev-parse', 'HEAD') === head, 'FINALIZE_MISMATCH');
    run.state = 'COMPLETED'; return { sha: head, cleanupStatus: 'not_requested' };
  }
  async cleanup(run: Run, dryRun = true) {
    const resources = [...Object.values(run.tasks).filter(task => task.path).map(task => ({ path: task.path, branch: task.branch, active: ['LEASED', 'RUNNING', 'ORPHANED_UNKNOWN'].includes(task.state) })), { path: run.integrationPath, branch: run.integration, active: false }];
    const results: Run['cleanup'] = [];
    for (const item of resources) {
      let reason: string | null = null;
      if (run.state !== 'COMPLETED') reason = 'run_not_finalized';
      else if (item.active) reason = 'worker_stop_unconfirmed';
      else {
        const path = await realpath(item.path).catch(() => null);
        if (!path) { results.push({ path: item.path, status: 'absent', reason: null }); continue; }
        const repo = await inspectRepository(path);
        if (!within(run.managedRoot, path) || path === run.origin || repo.commonDir !== run.commonDir || repo.branch !== item.branch) reason = 'ownership_mismatch';
        else if (repo.dirty) reason = 'dirty';
        else { try { await git(run.origin, 'merge-base', '--is-ancestor', repo.head, run.target); } catch { reason = 'unmerged'; } }
      }
      if (reason || dryRun) { results.push({ path: item.path, status: reason ? 'preserved' : 'candidate', reason }); continue; }
      try { await git(run.origin, 'worktree', 'remove', item.path); await git(run.origin, 'branch', '-d', item.branch); results.push({ path: item.path, status: 'removed', reason: null }); }
      catch { results.push({ path: item.path, status: 'preserved', reason: 'remove_failed' }); }
    }
    if (!dryRun) {
      run.cleanup = results;
      if (results.every(item => ['removed', 'absent'].includes(item.status))) {
        const lock = join(run.commonDir, 'orch', 'locks', 'write.json');
        const owner = JSON.parse(await readFile(lock, 'utf8')) as { runId: string };
        check(owner.runId === run.id, 'LOCK_OWNERSHIP_MISMATCH'); await rm(lock);
      }
    }
    return results;
  }
  async control(run: Run, action: 'pause' | 'cancel' | 'resume', stoppedAgents: string[] = []) {
    if (action === 'pause' || action === 'cancel') {
      check(!['COMPLETED', 'CANCELLED', 'PAUSED'].includes(run.state), 'INVALID_RUN_STATE');
      run.pausedFrom = run.state;
      run.state = action === 'pause' ? 'PAUSED' : 'CANCELLED';
      for (const task of Object.values(run.tasks)) if (['LEASED', 'RUNNING'].includes(task.state)) task.state = 'ORPHANED_UNKNOWN';
    } else {
      check(['PAUSED', 'CANCELLED'].includes(run.state), 'INVALID_RUN_STATE');
      for (const task of Object.values(run.tasks)) if (task.state === 'ORPHANED_UNKNOWN') {
        check(task.nativeId && stoppedAgents.includes(task.nativeId), 'ORPHANED_UNKNOWN');
        check(!(await inspectRepository(task.path)).dirty, 'DIRTY_RECOVERY_PRESERVED');
        task.state = Object.keys(task.units).length ? 'MERGE_QUEUED' : 'RETRYABLE_FAILED';
      }
      run.state = run.pausedFrom || 'EXECUTING';
    }
    return { state: run.state };
  }
}
