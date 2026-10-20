import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { redact } from '../quality/redact.ts';
import { assertNoStagedSecrets } from '../quality/secrets.ts';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { writeRequirements } from '../requirements/index.ts';
import { writeStateArtifact } from '../state/artifacts.ts';
import { Store, hash } from '../state/store.ts';
import { git, inspectRepository, preflightRepository, within, owns, overlaps, changedPaths, sourceFingerprint } from '../git/repository.ts';
import { configSchema } from '../../../protocol/src/config.ts';
import type { Config } from '../../../protocol/src/config.ts';
import { id, nativeAgentId, requirementsSchema, requireCondition as check, validatePlan, planAmendmentSchema, runAbandonmentSchema, reviewSchema, taskResultSchema, gateResultSchema } from '../../../protocol/src/runtime.ts';
import type { Task, Plan, Review, GateResult, Requirements } from '../../../protocol/src/runtime.ts';

import { completionEvidence, findingBlocks } from './completion.ts';
import { verifyPreparedClaudeDefinition } from './host-claude.ts';
import { resolveRoleModel, observeRoleModel, type NativeModelContext } from './models.ts';
import { enforceRunBudget, activeElapsedMs, reconcileExpiredTasks, confirmHostHeartbeat, type HostHeartbeat } from './lifecycle.ts';
import { allocateAttemptResources, reservePort, type AttemptResources } from './resources.ts';
import { prepareNodeDependencies, dependencyFingerprint, environmentFingerprint, type DependencySetup } from './dependencies.ts';

const exec = promisify(execFile);
type Gate = { dependencies?: string; environment?: string; environmentOverrides?: Record<string, string>; id?: string; details?: GateResult[]; stage: string; task: string | null; sha: string; source: string; commands: string; status: string; results: { id: string; status: string; exitCode: number | null }[] };
type Work = { dependencySetup?: DependencySetup | null; nativeContext?: NativeCapability; resources?: AttemptResources; deadline?: number; heartbeat?: { observedAt: number; evidenceRef: string }; modelObservation?: ReturnType<typeof observeRoleModel>; spec: Task; state: string; base: string; path: string; branch: string; attempt: number; lease: string; expires: number; nativeId: string | null; nativeBootstrap?: { cwd: string; origin_root: string; common_dir: string; branch: string; head: string }; units: Record<string, string>; validated: string | null; pausedState?: string; dispatchBase?: string; configRevision?: number; observedModel?: string | null; observedEffort?: string | null; modelResolution?: { requestedModel: string; requestedEffort: string; resolvedModel: string | null; resolvedEffort: string | null; nativeArguments?: ReturnType<typeof resolveRoleModel>['nativeArguments'] }; acceptanceEvidence?: { acceptanceId: string; evidenceRefs: string[] }[]; changedPaths?: string[]; reportedModel?: string | null; recoveryHead?: string; lastCommitSha?: string; attempts?: { number: number; path: string; branch: string; nativeId: string | null; stopped: boolean; reason: string; configRevision?: number; modelResolution?: Work['modelResolution']; observedModel?: string | null; observedEffort?: string | null; modelObservation?: Work['modelObservation']; resources?: AttemptResources }[] };
type Finding = Review['findings'][number] & { fingerprint: string; lifecycle: string; seenRounds?: number[]; dispositions?: { status: 'ACCEPTED_RISK' | 'NOT_A_BUG' | 'DEFERRED'; reason: string; actor: 'user'; approvedAt: string; sha: string | null }[] };
const attemptKey = (taskId: string, attempt: number) => { const key = `${taskId}-${attempt}`; return key.length <= 80 ? key : `attempt-${hash([taskId, attempt])}`; };
const acceptedGate = (gate: { status: string }) => ['passed', 'waived'].includes(gate.status);
const activeWriterStates = new Set(['LEASED', 'RUNNING', 'VALIDATING', 'ORPHANED_UNKNOWN']);
const activePhases = new Set(['ANALYZING', 'EXECUTING', 'INTEGRATING', 'VERIFYING', 'REVIEWING', 'REPAIR_PLANNING', 'FINAL_AUDIT', 'FINALIZING', 'CLEANING']);
export type Run = {
  id: string; host: 'codex' | 'claude'; origin: string; commonDir: string; target: string; targetBase: string;
  integration: string; integrationPath: string; managedRoot: string; state: string; config: Config;
  reviewDispatches?: Record<string, ReviewDispatch>;
  requirements?: Requirements; requirementRefs?: { json: string; markdown: string };
  hostEvidence?: NativeCapability;
  planRevision?: number;
  plan: Plan | null; tasks: Record<string, Work>; gates: Gate[]; findings: Finding[];
  reviews: { sha: string; reviewer: string; final: boolean; acceptanceIds?: string[]; decision?: string; limitations?: string[] }[]; reviewRound: number; implementers?: string[]; integrationSha?: string;
  conflict?: { path: string; branch: string; taskId: string; expected: string; taskHead: string };
  candidates?: { path: string; branch: string }[];
  targetConflict?: { path: string; branch: string; expected: string; target: string };
  runtimeRoot?: string; configRevision?: number; configRevisions?: { revision: number; hash: string; roles: Config['hosts']; timestamp: string }[];
  abandonment?: { forced: boolean; operationId: string; unresolvedOperations: string[]; actor: 'user'; reason: string; approvedAt: string; previousCoordinatorStopped: true; stoppedAgents: string[]; neverStartedTasks: string[]; neverStartedReviews: string[] };
  finalizationApproval?: { actor: 'user'; target: string; runId: string; approvedAt: string };
  activeTimeMs?: number; activeSince?: number | null; pauseTimeMs?: number; pauseStartedAt?: number; finalizedAt?: string;
  repairAnalyses?: { round: number; analysis: string }[];
  missingTestsWaiver?: { actor: 'user'; reason: string; approvedAt: string };
  waivers?: { stage: string; taskId: string | null; gateId: string; sha: string; source: string; command: string; reason: string; actor: 'user'; approvedAt: string }[];
  createdAt: string; pausedFrom?: string; cleanup: { path: string; status: string; reason: string | null }[];
};
export type NativeCapability = NativeModelContext & { source?: 'coordinator_native_receipt' };
type ReviewDispatch = { role: 'reviewer' | 'final_auditor'; sha: string; source: string; expires: number; nativeId: string | null; state: string; configRevision: number; resolution: ReturnType<typeof resolveRoleModel>; nativeContext: NativeCapability; observation?: ReturnType<typeof observeRoleModel> };

export class Engine {
  private portReservations = new Map<string, { runId: string; taskId: string; generation: number; reservation: Awaited<ReturnType<typeof reservePort>> }>();
  store: Store;
  native: NativeCapability | null;
  activeOperation: string | null = null;
  effectPrepared = false;
  runtimeRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  readConfig: (() => Promise<Config>) | null;
  origin: string;
  constructor(statePath: string, native: NativeCapability | null = null, readConfig: (() => Promise<Config>) | null = null) {
    const path = resolve(statePath);
    check(basename(path) === 'state.db' && basename(dirname(path)) === 'state' && basename(dirname(dirname(path))) === '.orch', 'STATE_PATH_UNSAFE');
    this.origin = realpathSync(dirname(dirname(dirname(path))));
    let directory = this.origin;
    for (const part of ['.orch', 'state']) {
      directory = join(directory, part);
      if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
      check(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink() && realpathSync(directory) === directory, 'STATE_PATH_UNSAFE');
    }
    this.store = new Store(join(directory, 'state.db')); this.native = native; this.readConfig = readConfig;
  }
  status(run: string) { return this.store.get<Run>(id.parse(run)); }
  async create(origin: string, configInput: unknown, host: 'codex' | 'claude', managedRoot: string, trustedCommandsHash: string, options: { missingTestsWaiver?: { approved: boolean; reason: string } } = {}) {
    const repo = await inspectRepository(origin), config = configSchema.parse(configInput);
    check(repo.root === this.origin, 'STATE_ORIGIN_MISMATCH');
    check(!repo.dirty, 'DIRTY_CHECKOUT');
    const missingWaiver = options.missingTestsWaiver;
    check(!missingWaiver || missingWaiver.approved && missingWaiver.reason.trim(), 'APPROVAL_REQUIRED');
    check((config.quality.commands.length > 0 || missingWaiver) && hash(config.quality.commands) === trustedCommandsHash, 'TRUST_APPROVAL_REQUIRED');
    check(missingWaiver && config.quality.commands.length === 0 || config.quality.commands.some(command => command.required && command.stages.includes('baseline')) &&
      config.quality.commands.some(command => command.required && command.stages.includes('final')), 'REQUIRED_GATES_MISSING');
    check(!config.git.target_branch || config.git.target_branch === repo.branch, 'TARGET_BRANCH_MISMATCH');
    await git(repo.root, 'check-ignore', '.orch/state/probe').catch(() => { throw new Error('STATE_IGNORE_REQUIRED'); });
    await mkdir(managedRoot, { recursive: true });
    const managed = await realpath(managedRoot);
    check(!within(repo.root, managed) && managed !== repo.root, 'WORKTREE_ROOT_UNSAFE');
    await preflightRepository(repo.root, [repo.root, repo.commonDir, managed]);
    const runId = `run-${randomUUID()}`;
    const lock = join(repo.commonDir, 'orch', 'locks'); await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'write.json'), JSON.stringify({ runId, origin: repo.root }), { flag: 'wx', mode: 0o600 }).catch(() => { throw new Error('REPOSITORY_RUN_LOCKED'); });
    const integration = `orch/${runId}/integration`, integrationPath = join(managed, runId, 'integration');
    const run: Run = { id: runId, host, origin: repo.root, commonDir: repo.commonDir, target: repo.branch, targetBase: repo.head,
      integration, integrationPath, managedRoot: managed, hostEvidence: this.native ? structuredClone(this.native) : undefined, state: 'PREFLIGHT', config, plan: null, tasks: {}, gates: [], findings: [], reviews: [], reviewRound: 0,
      activeTimeMs: 0, activeSince: null, pauseTimeMs: 0, missingTestsWaiver: missingWaiver && config.quality.commands.length === 0 ? { actor: 'user', reason: missingWaiver.reason, approvedAt: new Date().toISOString() } : undefined, runtimeRoot: this.runtimeRoot, configRevision: 1, configRevisions: [{ revision: 1, hash: hash(config), roles: structuredClone(config.hosts), timestamp: new Date().toISOString() }], integrationSha: repo.head, createdAt: new Date().toISOString(), cleanup: [] };
    this.store.create(runId, run);
    this.store.snapshot(runId, 'config', 'revision-1', config);
    if (this.native) this.store.snapshot(runId, 'catalog', `host-${hash(this.native)}`, this.native);
    return { runId, version: 0 };
  }
  async change<T>(runId: string, operation: string, expected: number, input: unknown, fn: (run: Run) => Promise<T>, administrativeAbandon = false) {
    id.parse(operation);
    const snapshot = this.status(runId);
    const mutex = await this.acquireOperationMutex(snapshot.data, operation);
    try {
      const current = this.status(runId);
      // Disposal is administrative; it never executes or upgrades a pinned runtime.
      check(current.data.runtimeRoot === this.runtimeRoot || administrativeAbandon, 'RUNTIME_VERSION_PINNED');
      const completedOperation = this.canReleaseWriteLock(current.data) && this.store.operation(runId, operation)?.status === 'complete';
      if (completedOperation) {
        const previous = this.store.intent(runId, operation, input, current)!;
        await this.releaseRunLock(current.data);
        return previous.result as { version: number; result: T };
      }
      const lockText = await readFile(join(current.data.commonDir, 'orch', 'locks', 'write.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const owner = lockText ? JSON.parse(lockText) as { runId: string } : null;
      const oldCleanup = current.data.state === 'COMPLETED' && (input as { tool?: string }).tool === 'orch_cleanup';
      check(owner ? owner.runId === runId || oldCleanup : current.data.state === 'COMPLETED', 'RUN_LOCK_OWNERSHIP_MISMATCH');
      const prior = this.store.operation(runId, operation);
      if (!prior) check(current.version === expected, 'STATE_CONFLICT');
      const previous = this.store.intent(runId, operation, input, current);
      if (previous) {
        if (previous.status === 'rejected') throw new Error((previous.result as { code: string }).code);
        check(previous.status === 'complete', 'RECONCILIATION_REQUIRED');
        return previous.result as { version: number; result: T };
      }
      const started = Date.now();
      current.data.activeTimeMs = (current.data.activeTimeMs ?? 0) + (current.data.activeSince == null ? 0 : Math.max(0, started - current.data.activeSince));
      current.data.activeSince = started;
      this.activeOperation = operation; this.effectPrepared = false;
      let result: T;
      try { result = await fn(current.data); }
      catch (error) {
        if (!this.effectPrepared) this.store.reject(runId, operation, error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'ORCH_OPERATION_FAILED');
        throw error;
      }
      const finished = Date.now();
      current.data.activeTimeMs += Math.max(0, finished - started);
      current.data.activeSince = activePhases.has(current.data.state) ? finished : null;
      const response = { version: current.version + 1, result };
      const saved = this.store.save(runId, current.version, current.data, 'run.changed', operation, response);
      if (this.canReleaseWriteLock(current.data)) await this.releaseRunLock(current.data);
      return saved;
    } finally { this.activeOperation = null; await this.releaseOperationMutex(mutex); }
  }
  private async withOperationMutexGuard<T>(path: string, fn: () => Promise<T>, waitForBusy = false) {
    const guard = join(dirname(path), 'operation-guard.db'), deadline = Date.now() + 5000;
    for (;;) {
      const info = await lstat(guard).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      check(!info || info.isFile() && !info.isSymbolicLink(), 'OPERATION_LOCK_UNSAFE');
      const database = new DatabaseSync(guard);
      try {
        database.exec('PRAGMA busy_timeout=0');
        if (info?.size) check(database.prepare('PRAGMA application_id').get()?.application_id === 0x4f52434d, 'OPERATION_LOCK_UNSAFE');
        else database.exec('PRAGMA application_id=0x4f52434d');
        // Keep the checked directory generation stable until its filesystem maintenance finishes.
        database.exec('BEGIN IMMEDIATE');
        try { return await fn(); }
        finally { database.exec('ROLLBACK'); }
      } catch (error) {
        if (![5, 6].includes((error as { errcode?: number }).errcode ?? -1)) throw error;
        if (!waitForBusy || Date.now() >= deadline) throw new Error('OPERATION_LOCKED', { cause: error });
      } finally { database.close(); }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  private async acquireOperationMutex(run: Run, operationId: string) {
    const path = join(run.commonDir, 'orch', 'locks', 'operation');
    return this.withOperationMutexGuard(path, async () => {
      await mkdir(path).catch(() => { throw new Error('OPERATION_LOCKED'); });
      const owner = `owner-${hash(run.id)}-${hash(operationId)}-${randomUUID()}`;
      try { await mkdir(join(path, owner)); }
      catch (error) { await rmdir(path); throw error; }
      return { path, owner };
    });
  }
  private async releaseOperationMutex(mutex: { path: string; owner: string }) {
    return this.withOperationMutexGuard(mutex.path, () => this.retireOperationMutex(mutex), true);
  }
  private async retireOperationMutex(mutex: { path: string; owner: string }) {
    const entries = await readdir(mutex.path), info = await lstat(join(mutex.path, mutex.owner));
    check(entries.length === 1 && entries[0] === mutex.owner && info.isDirectory() && !info.isSymbolicLink(), 'OPERATION_LOCKED');
    // Retire the global mutex atomically; an exit during cleanup must not leave it ownerless.
    const released = `${mutex.path}-released-${randomUUID()}`;
    await rename(mutex.path, released);
    await rmdir(join(released, mutex.owner));
    await rmdir(released);
  }
  private async recoverOperationMutex(run: Run, operationId: string | null, ownsWriteLock: boolean) {
    const path = join(run.commonDir, 'orch', 'locks', 'operation');
    return this.withOperationMutexGuard(path, async () => {
      const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) return;
      check(info.isDirectory() && !info.isSymbolicLink(), 'OPERATION_LOCKED');
      const entries = await readdir(path);
      if (entries.length) {
        const owner = entries[0], prefix = `owner-${hash(run.id)}-`;
        check(entries.length === 1 && /^owner-[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9-]{36}$/.test(owner) && owner.startsWith(prefix) &&
          (operationId === null || owner.startsWith(`${prefix}${hash(operationId)}-`)), 'OPERATION_LOCKED');
        await this.retireOperationMutex({ path, owner });
      } else {
        // Legacy empty mutexes carry no identity; only the current write owner can recover them.
        check(ownsWriteLock, 'OPERATION_LOCKED');
        await rmdir(path);
      }
    });
  }
  private canReleaseWriteLock(run: Run) {
    if (run.state === 'CANCELLED' && run.abandonment?.forced && this.store.operation(run.id, run.abandonment.operationId)?.status === 'complete') return true;
    return ['COMPLETED', 'CANCELLED'].includes(run.state) &&
      Object.values(run.tasks).every(task => !activeWriterStates.has(task.state)) &&
      Object.values(run.reviewDispatches ?? {}).every(dispatch => ['COMPLETED', 'STOPPED'].includes(dispatch.state)) && this.store.pending(run.id).length === 0;
  }
  private async releaseRunLock(run: Run) {
    check(this.canReleaseWriteLock(run), 'WORKER_STOP_UNCONFIRMED');
    const path = join(run.commonDir, 'orch', 'locks', 'operation');
    return this.withOperationMutexGuard(path, async () => {
      const lock = join(run.commonDir, 'orch', 'locks', 'write.json');
      const info = await lstat(lock).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) return;
      check(info.isFile() && !info.isSymbolicLink() && info.size <= 4096, 'RUN_LOCK_UNSAFE');
      const owner = JSON.parse(await readFile(lock, 'utf8')) as { runId: string; origin: string };
      if (owner.runId !== run.id) return;
      check(owner.origin === run.origin, 'RUN_LOCK_OWNERSHIP_MISMATCH');
      await rm(lock);
    }, true);
  }
  async abandon(runId: string, operation: string, expected: number, input: unknown) {
    const approval = runAbandonmentSchema.parse(input);
    id.parse(operation);
    const prior = this.store.operation(runId, operation);
    check(!prior || prior.fingerprint === hash({ tool: 'orch_run_abandon', input: approval }), 'IDEMPOTENCY_CONFLICT');
    if (approval.force && this.store.operation(runId, operation)?.status !== 'complete') {
      const snapshot = this.status(runId);
      check(snapshot.version === expected, 'STATE_CONFLICT');
      check(snapshot.data.state !== 'COMPLETED' && !snapshot.data.abandonment, 'INVALID_RUN_STATE');
      check(snapshot.data.origin === this.origin && (await inspectRepository(this.origin)).commonDir === snapshot.data.commonDir, 'STATE_ORIGIN_MISMATCH');
      const lock = join(snapshot.data.commonDir, 'orch', 'locks', 'write.json');
      const info = await lstat(lock);
      check(info.isFile() && !info.isSymbolicLink() && info.size <= 4096, 'RUN_LOCK_UNSAFE');
      const owner = JSON.parse(await readFile(lock, 'utf8')) as { runId: string; origin: string };
      check(owner.runId === runId && owner.origin === this.origin && snapshot.data.origin === this.origin, 'RUN_LOCK_OWNERSHIP_MISMATCH');
      await this.recoverOperationMutex(snapshot.data, null, true);
    }
    return this.change(runId, operation, expected, { tool: 'orch_run_abandon', input: approval }, run => this.markAbandoned(run, operation, approval), true);
  }
  private async markAbandoned(run: Run, operation: string, approval: ReturnType<typeof runAbandonmentSchema.parse>) {
    check(run.origin === this.origin && (await inspectRepository(this.origin)).commonDir === run.commonDir, 'STATE_ORIGIN_MISMATCH');
    check(run.state !== 'COMPLETED' && !run.abandonment, 'INVALID_RUN_STATE');
    const unresolvedOperations = this.store.pending(run.id).filter(item => item.id !== operation).map(item => item.id);
    check(approval.force || unresolvedOperations.length === 0, 'RECONCILIATION_REQUIRED');
    for (const [key, task] of Object.entries(run.tasks)) {
      if (!activeWriterStates.has(task.state)) continue;
      const neverStarted = !task.nativeId && (task.state === 'LEASED' || task.pausedState === 'LEASED') && approval.never_started_tasks.includes(key);
      check(approval.force || (task.nativeId ? approval.stopped_agents.includes(task.nativeId) : neverStarted), 'WORKER_STOP_UNCONFIRMED');
    }
    for (const [key, dispatch] of Object.entries(run.reviewDispatches ?? {})) {
      if (['COMPLETED', 'STOPPED'].includes(dispatch.state)) continue;
      check(approval.force || (dispatch.nativeId ? approval.stopped_agents.includes(dispatch.nativeId) : approval.never_started_reviews.includes(key)), 'REVIEW_STOP_UNCONFIRMED');
    }
    run.abandonment = { forced: approval.force, operationId: operation, unresolvedOperations, actor: 'user', reason: approval.reason, approvedAt: new Date().toISOString(), previousCoordinatorStopped: true, stoppedAgents: approval.stopped_agents, neverStartedTasks: approval.never_started_tasks, neverStartedReviews: approval.never_started_reviews };
    for (const task of Object.values(run.tasks)) if (activeWriterStates.has(task.state)) { task.pausedState = task.state; task.state = approval.force ? 'ORPHANED_UNKNOWN' : 'STOPPED'; }
    for (const dispatch of Object.values(run.reviewDispatches ?? {})) if (!['COMPLETED', 'STOPPED'].includes(dispatch.state)) dispatch.state = approval.force ? 'ORPHANED_UNKNOWN' : 'STOPPED';
    run.state = 'CANCELLED'; run.finalizationApproval = undefined;
    return { state: run.state, abandoned: true, preserved: true };
  }

  checkpointIntent(run: Run) {
    check(this.activeOperation, 'OPERATION_REQUIRED'); this.effectPrepared = true;
    const version = this.status(run.id).version;
    this.store.db.prepare('UPDATE operations SET snapshot=? WHERE run_id=? AND id=?').run(JSON.stringify({ version, data: run }), run.id, this.activeOperation);
  }
  async reconcile(runId: string, operationId: string, previousCoordinatorStopped: boolean) {
    check(previousCoordinatorStopped, 'COORDINATOR_STOP_UNCONFIRMED');
    const current = this.status(runId);
    const pendingRecord = this.store.pending(runId).find(item => item.id === operationId);
    const completed = this.store.operation(runId, operationId);
    const completedOperation = completed?.status === 'complete';
    const completedTerminal = completedOperation && this.canReleaseWriteLock(current.data);
    check(pendingRecord || completedOperation, 'OPERATION_NOT_PENDING');
    const pendingTool = (pendingRecord?.input as { tool?: string } | null)?.tool;
    const administrative = pendingTool === 'orch_run_abandon' || completedOperation;
    check(current.data.runtimeRoot === this.runtimeRoot || administrative, 'RUNTIME_VERSION_PINNED');
    const lockText = await readFile(join(current.data.commonDir, 'orch', 'locks', 'write.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const owner = lockText ? JSON.parse(lockText) as { runId: string } : null;
    check(owner?.runId === runId || completedTerminal || pendingTool === 'orch_cleanup' && current.data.state === 'COMPLETED', 'LOCK_OWNERSHIP_MISMATCH');
    await this.recoverOperationMutex(current.data, operationId, owner?.runId === runId);
    const mutex = await this.acquireOperationMutex(current.data, operationId);
    try {
      if (completedOperation) {
        if (this.canReleaseWriteLock(current.data)) await this.releaseRunLock(current.data);
        return JSON.parse(completed.result as string) as { version: number; result: unknown };
      }
      const pending = this.store.pending(runId).find(item => item.id === operationId); check(pending, 'OPERATION_NOT_PENDING');
      const prior = pending.snapshot as { version: number; data: Run } | null;
      check(prior && prior.version === current.version, 'RECONCILIATION_STATE_DIVERGED');
      const request = pending.input as { tool?: string; input?: { task_id?: string; unit_id?: string; expected_integration_sha?: string; expected_target_sha?: string } };
      const run = prior.data, task = request.input?.task_id ? run.tasks[request.input.task_id] : null;
      let result: unknown;
      if (request.tool === 'orch_run_abandon') {
        result = await this.markAbandoned(run, operationId, runAbandonmentSchema.parse(request.input));
      } else if (request.tool === 'orch_plan_submit') {
        const repo = await inspectRepository(run.integrationPath);
        check(run.state === 'EXECUTING' && run.plan && repo.commonDir === run.commonDir && repo.branch === run.integration && repo.head === run.targetBase && !repo.dirty, 'RECOVERY_PLAN_NOT_PROVEN');
        result = { state: run.state, recovered: true };
      } else if (request.tool === 'orch_plan_amend') {
        result = { ...await this.amendPlan(run, request.input), recovered: true };
      } else if (request.tool === 'orch_cleanup') {
        check(run.state === 'COMPLETED', 'RECOVERY_CLEANUP_NOT_PROVEN');
        result = await this.cleanup(run, false);
      } else if (request.tool === 'orch_task_commit' && task) {
        const unit = request.input?.unit_id; check(unit && task.spec.commit_units.some(item => item.id === unit), 'UNKNOWN_UNIT');
        const head = await git(task.path, 'rev-parse', 'HEAD'), message = await git(task.path, 'show', '-s', '--format=%B', head);
        check(message.includes(`Orch-Run: ${run.id}\n`) && message.includes(`Orch-Task: ${task.spec.id}\n`) && `${message}\n`.includes(`Orch-Unit: ${unit}\n`), 'RECOVERY_COMMIT_NOT_PROVEN');
        check((await changedPaths(task.path, task.base)).every(path => owns(task.spec.write_paths, path)), 'OWNERSHIP_VIOLATION');
        task.units[unit] = head; task.lastCommitSha = head; task.validated = null; result = { sha: head, recovered: true };
      } else if (request.tool === 'orch_integrate' && task) {
        const head = await git(run.integrationPath, 'rev-parse', 'HEAD'), parents = (await git(run.integrationPath, 'show', '-s', '--format=%P', head)).split(' ');
        check(parents.length === 2 && parents[0] === request.input?.expected_integration_sha && parents[1] === await git(task.path, 'rev-parse', 'HEAD'), 'RECOVERY_MERGE_NOT_PROVEN');
        task.state = 'INTEGRATED'; run.integrationSha = await git(run.integrationPath, 'rev-parse', 'HEAD'); run.reviews = [];
        run.state = Object.values(run.tasks).every(item => item.state === 'INTEGRATED') ? 'VERIFYING' : 'EXECUTING'; result = { sha: head, recovered: true };
      } else if (request.tool === 'orch_task_prepare' && task) {
        const repo = await inspectRepository(task.path);
        check(repo.commonDir === run.commonDir && repo.branch === task.branch && repo.head === (task.dispatchBase ?? task.base) && !repo.dirty && task.state === 'LEASED', 'RECOVERY_WORKTREE_NOT_PROVEN');
        task.dependencySetup = await prepareNodeDependencies(run.origin, task.path, task.dependencySetup);
        // The caller never received the lost dispatch; retain its lease, do not start another worker.
        result = { recovered: true, task, requiresNativeStateCheck: true };
      } else if (request.tool === 'orch_reintegrate') {
        const expected = request.input?.expected_target_sha, candidate = run.candidates?.at(-1);
        check(expected && candidate?.branch === `orch/${run.id}/target/${operationId}`, 'RECOVERY_REINTEGRATE_NOT_PROVEN');
        const target = await inspectRepository(run.origin), merged = await inspectRepository(candidate.path);
        check(target.branch === run.target && target.head === expected && !target.dirty && merged.commonDir === run.commonDir && merged.branch === candidate.branch && !merged.dirty, 'RECOVERY_REINTEGRATE_NOT_PROVEN');
        await git(candidate.path, 'merge-base', '--is-ancestor', expected, merged.head);
        await git(candidate.path, 'merge-base', '--is-ancestor', run.integrationSha!, merged.head);
        const integration = await inspectRepository(run.integrationPath);
        check(integration.commonDir === run.commonDir && integration.branch === run.integration && !integration.dirty && [run.integrationSha, merged.head].includes(integration.head), 'RECOVERY_REINTEGRATE_NOT_PROVEN');
        await git(run.integrationPath, 'merge', '--ff-only', candidate.branch);
        run.integrationSha = merged.head; run.targetBase = expected; run.reviews = []; run.finalizationApproval = undefined; run.state = 'VERIFYING';
        result = { state: run.state, sha: merged.head, targetBase: expected, recovered: true };
      } else if (request.tool === 'orch_finalize') {
        const [target, integration] = await Promise.all([inspectRepository(run.origin), inspectRepository(run.integrationPath)]);
        const head = integration.head;
        check(target.commonDir === run.commonDir && integration.commonDir === run.commonDir && target.branch === run.target && integration.branch === run.integration && !target.dirty && !integration.dirty && target.head === head && run.gates.some(gate => gate.stage === 'final' && gate.sha === head && acceptedGate(gate)), 'RECOVERY_FINALIZE_NOT_PROVEN');
        check(completionEvidence(run, head, { allowApprovedWaivers: true }).blockers.length === 0, 'RECOVERY_FINALIZE_NOT_PROVEN');
        const source = await sourceFingerprint(run.integrationPath);
        let inputsFresh = true;
        for (const stage of ['integration', 'final']) {
          const gate = run.gates.filter(gate => gate.stage === stage && gate.task === null).at(-1);
          if (gate?.source !== source || !await this.gateInputsFresh(gate, run.integrationPath)) inputsFresh = false;
        }
        if (!inputsFresh) {
          run.targetBase = head; run.reviews = []; run.finalizationApproval = undefined; run.finalizedAt = undefined; run.state = 'VERIFYING';
          result = { recovered: true, state: run.state, reason: 'VALIDATION_STALE', targetAlreadyUpdated: true };
        } else {
          run.finalizedAt ??= new Date().toISOString(); run.state = 'COMPLETED'; result = { sha: head, recovered: true };
        }
      } else throw new Error('RECOVERY_REQUIRES_MANUAL_RECONCILIATION');
      const saved = this.store.save(runId, current.version, run, 'run.reconciled', operationId, { version: current.version + 1, result });
      if (this.canReleaseWriteLock(run)) await this.releaseRunLock(run);
      return saved;
    } finally { await this.releaseOperationMutex(mutex); }
  }
  async gate(run: Run, stage: string, path: string, task: string | null = null) {
    enforceRunBudget(run);
    await prepareNodeDependencies(run.origin, path, task ? run.tasks[task].dependencySetup : null);
    let commands = run.config.quality.commands.filter(command => command.stages.includes(stage as 'baseline') && (task === null || run.tasks[task].spec.verification_ids.includes(command.id)));
    if (!commands.length && run.missingTestsWaiver) commands = [{ id: 'missing-tests', executable: process.execPath, args: [], cwd: '.', stages: ['baseline', 'task', 'integration', 'final'], required: true, timeout_seconds: 1 }];
    check(commands.some(command => command.required), 'REQUIRED_GATES_MISSING');
    const fingerprint = await sourceFingerprint(path);
    const result: Gate = { id: `gate-${randomUUID()}`, details: [], stage, task, sha: await git(path, 'rev-parse', 'HEAD'), source: fingerprint,
      commands: hash(run.config.quality.commands), status: 'passed', results: [] };
    const resources = task ? run.tasks[task].resources : await allocateAttemptResources(run.origin, run.id, result.id!);
    check(resources, 'ATTEMPT_RESOURCES_REQUIRED');
    const environment = { ...process.env, ...resources.environment };
    // Persist only engine-owned overrides; inherited environment values remain a hash.
    result.environmentOverrides = { ...resources.environment };
    result.environment = environmentFingerprint(result.environmentOverrides);
    result.dependencies = await dependencyFingerprint(path);
    for (const command of commands) {
      const budgetExpired = activeElapsedMs(run) >= run.config.execution.run_timeout_minutes * 60000 || task !== null && Date.now() >= run.tasks[task].deadline!;
      const cwd = await realpath(resolve(path, command.cwd));
      check(cwd === await realpath(path) || within(await realpath(path), cwd), 'GATE_CWD_OUTSIDE_ROOT');
      this.checkpointIntent(run);
      const startedAt = new Date().toISOString();
      let status: GateResult['status'] = 'passed', exitCode: number | null = 0, output = '';
      const waiver = (run.waivers ?? []).find(item => item.stage === stage && item.taskId === task && item.gateId === command.id && item.sha === result.sha && item.source === fingerprint && item.command === hash(command)) ?? (command.id === 'missing-tests' ? run.missingTestsWaiver : undefined);
      if (budgetExpired) { status = 'not_run'; exitCode = null; output = 'Not run: execution budget exhausted'; result.status = 'timed_out'; }
      else if (waiver) { status = 'waived'; exitCode = null; output = `User waiver: ${waiver.reason}`; if (result.status === 'passed') result.status = 'waived'; }
      else try {
        const response = await exec(command.executable, command.args, { cwd, env: environment, timeout: Math.max(1, Math.min(command.timeout_seconds * 1000, run.config.execution.run_timeout_minutes * 60000 - activeElapsedMs(run), task ? run.tasks[task].deadline! - Date.now() : Infinity)), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
        output = `${response.stdout}\n${response.stderr}`;
      } catch (error) {
        const failure = error as { killed?: boolean; code?: number; stdout?: string; stderr?: string };
        status = failure.killed ? 'timed_out' : 'failed'; exitCode = typeof failure.code === 'number' ? failure.code : null;
        output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
        if (command.required) result.status = status;
      }
      if (activeElapsedMs(run) >= run.config.execution.run_timeout_minutes * 60000 || task && Date.now() >= run.tasks[task].deadline!) { if (status !== 'not_run') status = 'timed_out'; result.status = 'timed_out'; }
      const recordId = `quality-${randomUUID()}`;
      const logRef = await writeStateArtifact(run.origin, run.id, `${recordId}.log`, redact(output), 'logs');
      result.details!.push(gateResultSchema.parse({ id: recordId, runId: run.id, taskId: task, gateId: command.id,
        stage, commitSha: result.sha, sourceFingerprint: fingerprint, commandFingerprint: hash(command),
        environmentFingerprint: result.environment,
        status, exitCode, startedAt, finishedAt: new Date().toISOString(), logRef, waiverReason: waiver?.reason ?? null }));
      result.results.push({ id: command.id, status, exitCode });
    }
    if (await sourceFingerprint(path) !== fingerprint || !await this.gateInputsFresh(result, path)) result.status = 'source_changed';
    run.gates.push(result);
    return result;
  }
  private async gateInputsFresh(gate: Gate | undefined, path: string) {
    return !!gate?.dependencies && !!gate.environment && !!gate.environmentOverrides &&
      gate.environment === environmentFingerprint(gate.environmentOverrides) && gate.dependencies === await dependencyFingerprint(path);
  }
  async submitRequirements(run: Run, input: unknown) {
    check(['PREFLIGHT', 'PLAN_READY'].includes(run.state) && Object.keys(run.tasks).length === 0, 'INVALID_RUN_STATE');
    const requirements = requirementsSchema.parse(input);
    this.checkpointIntent(run);
    const saved = await writeRequirements(run.origin, run.id, requirements);
    run.requirements = saved.requirements; run.requirementRefs = saved.refs;
    run.plan = null; run.state = 'PREFLIGHT';
    return { state: run.state, ...saved };
  }
  async plan(run: Run, input: unknown, approved: boolean) {
    enforceRunBudget(run);
    check(run.state === 'PREFLIGHT' || run.state === 'PLAN_READY', 'INVALID_RUN_STATE');
    const plan = validatePlan(input);
    check(run.requirements, 'REQUIREMENTS_REQUIRED');
    check(plan.acceptance.length === run.requirements.acceptance.length && plan.acceptance.every(item => run.requirements!.acceptance.some(required => required.id === item.id && required.text === item.text)), 'REQUIREMENTS_PLAN_MISMATCH');
    const gateIds = new Set(run.config.quality.commands.map(command => command.id));
    if (run.missingTestsWaiver) gateIds.add('missing-tests');
    check(plan.tasks.every(task => task.verification_ids.every(key => gateIds.has(key))), 'UNKNOWN_VERIFICATION');
    run.plan = plan;
    if (!approved) { run.state = 'PLAN_READY'; return { state: run.state }; }
    const baseline = await this.gate(run, 'baseline', run.origin);
    if (!acceptedGate(baseline)) { run.state = 'BLOCKED_BASELINE'; return baseline; }
    run.planRevision = 1;
    this.store.snapshot(run.id, 'plan', 'revision-1', { plan, actor: 'user', reason: 'Initial approved plan' });
    for (const task of plan.tasks) run.tasks[task.id] = { spec: task, state: 'PENDING', base: '', path: '', branch: '', attempt: 0, lease: '', expires: 0, nativeId: null, units: {}, validated: null };
    run.state = 'EXECUTING'; this.checkpointIntent(run);
    await git(run.origin, 'worktree', 'add', '-b', run.integration, run.integrationPath, run.targetBase);
    return { state: run.state };
  }
  async amendPlan(run: Run, input: unknown) {
    const amendment = planAmendmentSchema.parse(input);
    check(run.state === 'PAUSED' && run.plan && Object.keys(run.tasks).length > 0, 'INVALID_RUN_STATE');
    check(Object.values(run.tasks).every(task => ['PENDING', 'RETRYABLE_FAILED', 'BLOCKED_ATTEMPT_LIMIT', 'MERGE_QUEUED', 'INTEGRATED'].includes(task.state)), 'WORKER_STOP_UNCONFIRMED');
    check(Object.values(run.reviewDispatches ?? {}).every(dispatch => ['COMPLETED', 'STOPPED'].includes(dispatch.state)), 'REVIEW_STOP_UNCONFIRMED');
    const plan = validatePlan(amendment.plan);
    check(run.requirements && plan.acceptance.length === run.requirements.acceptance.length && plan.acceptance.every(item => run.requirements!.acceptance.some(required => required.id === item.id && required.text === item.text)), 'REQUIREMENTS_PLAN_MISMATCH');
    const gateIds = new Set(run.config.quality.commands.map(command => command.id));
    if (run.missingTestsWaiver) gateIds.add('missing-tests');
    check(plan.tasks.every(task => task.verification_ids.every(key => gateIds.has(key))), 'UNKNOWN_VERIFICATION');
    const specs = new Map(plan.tasks.map(spec => [spec.id, spec]));
    const dependsOn = (task: Task, dependency: string): boolean => task.depends_on.some(key => key === dependency || dependsOn(specs.get(key)!, dependency));
    for (const [index, task] of plan.tasks.entries()) for (const other of plan.tasks.slice(index + 1)) {
      check(!(overlaps(task.write_paths, other.write_paths) || task.exclusive_resources.some(key => other.exclusive_resources.includes(key))) || dependsOn(task, other.id) || dependsOn(other, task.id), 'OWNERSHIP_CONFLICT');
    }
    for (const task of Object.values(run.tasks)) {
      const next = specs.get(task.spec.id);
      check(next || task.attempt === 0 && task.state === 'PENDING', 'TASK_EVIDENCE_IMMUTABLE');
      const protectedEvidence = Object.keys(task.units).length > 0 || task.validated || task.acceptanceEvidence || task.changedPaths || ['MERGE_QUEUED', 'INTEGRATED'].includes(task.state);
      check(!protectedEvidence || next && hash(next) === hash(task.spec), 'TASK_EVIDENCE_IMMUTABLE');
      if (next && task.path) {
        await this.taskIdentity(run, task);
        check((await changedPaths(task.path, task.base)).every(path => owns(next.write_paths, path)), 'OWNERSHIP_VIOLATION');
      }
    }
    const revision = (run.planRevision ?? 1) + 1;
    if (this.activeOperation) this.checkpointIntent(run);
    if (!run.planRevision) this.store.snapshot(run.id, 'plan', 'revision-1', { plan: run.plan, actor: 'user', reason: 'Initial approved plan' });
    this.store.snapshot(run.id, 'plan', `revision-${revision}`, { plan, actor: 'user', reason: amendment.reason, previousTasks: structuredClone(run.tasks), previousGates: structuredClone(run.gates), previousReviews: structuredClone(run.reviews) });
    for (const key of Object.keys(run.tasks)) if (!specs.has(key)) delete run.tasks[key];
    for (const spec of plan.tasks) {
      if (run.tasks[spec.id]) run.tasks[spec.id].spec = spec;
      else run.tasks[spec.id] = { spec, state: 'PENDING', base: '', path: '', branch: '', attempt: 0, lease: '', expires: 0, nativeId: null, units: {}, validated: null };
    }
    run.plan = plan; run.planRevision = revision; run.reviews = []; run.finalizationApproval = undefined;
    run.pausedFrom = Object.values(run.tasks).every(task => task.state === 'INTEGRATED') ? 'VERIFYING' : 'EXECUTING';
    return { state: run.state, revision };
  }
  async syncConfig(run: Run) {
    if (this.readConfig) {
      const next = configSchema.parse(await this.readConfig());
      const policies = (value: Config) => ({ ...value, hosts: undefined, model_selection: undefined });
      check(hash(policies(next)) === hash(policies(run.config)) && hash(next.hosts[run.host === 'codex' ? 'claude' : 'codex']) === hash(run.config.hosts[run.host === 'codex' ? 'claude' : 'codex']), 'RUN_POLICY_CHANGE_REQUIRES_NEW_RUN');
      if (hash(next) !== hash(run.config)) {
        run.config = next; run.configRevision = (run.configRevision ?? 1) + 1; run.configRevisions ??= [];
        run.configRevisions.push({ revision: run.configRevision, hash: hash(next), roles: structuredClone(next.hosts), timestamp: new Date().toISOString() });
      }
    }
    this.store.snapshot(run.id, 'config', `revision-${run.configRevision ?? 1}`, run.config);
    if (this.native) this.store.snapshot(run.id, 'catalog', `host-${hash(this.native)}`, this.native);
  }
  async prepare(run: Run, taskId: string) {
    check(run.state === 'EXECUTING', 'INVALID_RUN_STATE');
    check(this.native?.verified && this.native.contextMatches && this.native.host === run.host && this.native.evidence.length, 'BLOCKED_CAPABILITY');
    run.hostEvidence ??= structuredClone(this.native);
    enforceRunBudget(run);
    const task = run.tasks[taskId]; check(task, 'TASK_NOT_FOUND');
    check(['PENDING', 'RETRYABLE_FAILED'].includes(task.state), 'TASK_NOT_READY');
    check(task.attempt < run.config.execution.max_task_attempts, 'TASK_ATTEMPT_LIMIT');
    check(task.spec.depends_on.every(key => run.tasks[key].state === 'INTEGRATED'), 'DEPENDENCY_NOT_INTEGRATED');
    const active = Object.values(run.tasks).filter(work => ['LEASED', 'RUNNING', 'VALIDATING', 'ORPHANED_UNKNOWN', 'MERGE_QUEUED'].includes(work.state));
    check(active.filter(work => work.state !== 'MERGE_QUEUED').length < run.config.execution.max_parallel_workers, 'WORKER_LIMIT');
    check(!active.some(work => overlaps(work.spec.write_paths, task.spec.write_paths) || work.spec.exclusive_resources.some(resource => task.spec.exclusive_resources.includes(resource))), 'OWNERSHIP_CONFLICT');
    await this.syncConfig(run);
    const resolution = resolveRoleModel({ config: run.config, host: run.host, role: task.spec.role, native: this.native });
    check(await git(run.integrationPath, 'rev-parse', 'HEAD') === (run.integrationSha ?? run.targetBase), 'INTEGRATION_DRIFT');
    await prepareNodeDependencies(run.origin, run.integrationPath);
    const reuse = Object.keys(task.units).length > 0;
    const createRecovered = reuse && !!task.recoveryHead;
    if (reuse && task.recoveryHead) {
      run.candidates ??= []; run.candidates.push({ path: task.path, branch: task.branch });
      task.dispatchBase = task.recoveryHead; task.recoveryHead = undefined;
      task.branch = `orch/${run.id}/task/${taskId}-${task.attempt + 1}`;
      task.path = join(run.managedRoot, run.id, `${taskId}-${task.attempt + 1}`);
    } else if (reuse) {
      const existing = await inspectRepository(task.path);
      check(existing.commonDir === run.commonDir && existing.branch === task.branch && !existing.dirty, 'DIRTY_RECOVERY_PRESERVED');
      task.dispatchBase = existing.head;
    } else {
      if (task.path) { run.candidates ??= []; run.candidates.push({ path: task.path, branch: task.branch }); }
      task.base = await git(run.integrationPath, 'rev-parse', 'HEAD'); task.dispatchBase = task.base;
      task.branch = `orch/${run.id}/task/${taskId}-${task.attempt + 1}`;
      task.path = join(run.managedRoot, run.id, `${taskId}-${task.attempt + 1}`);
    }
    task.attempt++; task.lease = randomUUID(); task.deadline = Date.now() + run.config.execution.task_timeout_minutes * 60000; task.expires = task.deadline; task.heartbeat = undefined;
    check(within(run.managedRoot, task.path), 'WORKTREE_ROOT_UNSAFE');
    task.configRevision = run.configRevision ?? 1; task.modelResolution = resolution; task.nativeContext = structuredClone(this.native);
    task.validated = null; task.observedModel = null; task.observedEffort = null; task.modelObservation = undefined; task.nativeBootstrap = undefined; task.resources = undefined;
    task.state = 'LEASED'; task.nativeId = null; this.checkpointIntent(run);
    if (!reuse || createRecovered) await git(run.origin, 'worktree', 'add', '-b', task.branch, task.path, task.dispatchBase ?? task.base);
    task.dependencySetup = await prepareNodeDependencies(run.origin, task.path, task.dependencySetup);
    const reservation = await reservePort();
    try { task.resources = await allocateAttemptResources(run.origin, run.id, attemptKey(taskId, task.attempt), { host: reservation.host, port: reservation.port }); }
    catch (error) { await reservation.release(); throw error; }
    this.portReservations.set(task.lease, { runId: run.id, taskId, generation: task.attempt, reservation });
    this.checkpointIntent(run);
    this.store.snapshot(run.id, 'model', `${attemptKey(taskId, task.attempt)}-resolved`, { configRevision: task.configRevision, resolution, host: this.native });
    this.store.snapshot(run.id, 'attempt', `${attemptKey(taskId, task.attempt)}-prepared`, task);
    return { runId: run.id, taskId, attemptId: attemptKey(taskId, task.attempt), host: run.host, role: task.spec.role,
      modelId: resolution.resolvedModel, effort: resolution.resolvedEffort, nativeArguments: resolution.nativeArguments, resources: task.resources, configRevision: task.configRevision, baseSha: task.dispatchBase ?? task.base, lineageBaseSha: task.base, worktreePath: task.path,
      isolation: 'core_managed', dependencySetup: task.dependencySetup, leaseId: task.lease, fencingToken: task.attempt, expiresAt: new Date(task.expires).toISOString(), taskBrief: task.spec };
  }
  async attemptPort(run: Run, taskId: string, lease: string, generation: number, action: 'status' | 'release_for_claim') {
    const task = run.tasks[taskId]; check(task, 'TASK_NOT_FOUND');
    check(task.lease === lease && task.attempt === generation, 'STALE_LEASE');
    check(action === 'status' || action === 'release_for_claim', 'INVALID_PORT_ACTION');
    const entry = this.portReservations.get(lease);
    const reservation = entry?.runId === run.id && entry.taskId === taskId && entry.generation === generation ? entry.reservation : null;
    if (action === 'release_for_claim') {
      this.leased(run, taskId, lease, generation);
      check(['LEASED', 'RUNNING', 'VALIDATING'].includes(task.state), 'INVALID_TASK_STATE');
      check(reservation, 'PORT_RESERVATION_UNKNOWN');
      if (reservation.state === 'reserved') await reservation.releaseForClaim();
    }
    return { host: task.resources?.service?.host ?? null, port: task.resources?.service?.port ?? null,
      state: reservation?.state ?? 'unknown', reserved: reservation ? reservation.state === 'reserved' : null,
      claimRequiresBindEvidence: true as const };
  }
  private async releaseTaskPort(run: Run, taskId: string) {
    const task = run.tasks[taskId], entry = this.portReservations.get(task.lease);
    if (entry?.runId === run.id && entry.taskId === taskId && entry.generation === task.attempt) {
      await entry.reservation.release(); this.portReservations.delete(task.lease);
    }
  }
  async disposePorts() {
    for (const entry of this.portReservations.values()) await entry.reservation.release();
    this.portReservations.clear();
  }
  async prepareReview(run: Run, role: 'reviewer' | 'final_auditor') {
    enforceRunBudget(run);
    check(role === 'reviewer' || role === 'final_auditor', 'INVALID_REVIEW_ROLE');
    check(run.state === (role === 'reviewer' ? 'REVIEWING' : 'FINAL_AUDIT'), 'INVALID_RUN_STATE');
    check(this.native, 'BLOCKED_CAPABILITY');
    await this.syncConfig(run);
    const resolution = resolveRoleModel({ config: run.config, host: run.host, role, native: this.native });
    check(!Object.values(run.reviewDispatches ?? {}).some(item => item.role === role && ['LEASED', 'RUNNING', 'BLOCKED_MODEL_POLICY'].includes(item.state)), 'REVIEW_ALREADY_ACTIVE');
    const repo = await inspectRepository(run.integrationPath);
    check(repo.commonDir === run.commonDir && repo.branch === run.integration && repo.head === run.integrationSha && !repo.dirty, 'INTEGRATION_DRIFT');
    const dispatchId = `review-${randomUUID()}`, expires = Date.now() + run.config.execution.task_timeout_minutes * 60000;
    const dispatch: ReviewDispatch = { role, sha: repo.head, source: await sourceFingerprint(repo.root), expires, nativeId: null, state: 'LEASED', configRevision: run.configRevision ?? 1, resolution, nativeContext: structuredClone(this.native) };
    run.reviewDispatches ??= {}; run.reviewDispatches[dispatchId] = dispatch;
    this.store.snapshot(run.id, 'model', `${dispatchId}-resolved`, { ...dispatch, host: this.native });
    return { dispatchId, role, readOnly: true, writePaths: [], reviewedSha: repo.head, worktreePath: repo.root,
      modelId: resolution.resolvedModel, effort: resolution.resolvedEffort, nativeArguments: resolution.nativeArguments,
      configRevision: dispatch.configRevision, expiresAt: new Date(expires).toISOString() };
  }
  async bindReview(run: Run, dispatchId: string, nativeId: string, observedModel: string | null, observedEffort: string | null, reviewedSha: string) {
    enforceRunBudget(run);
    check(this.native?.verified && this.native.contextMatches && this.native.host === run.host, 'BLOCKED_CAPABILITY');
    const dispatch = run.reviewDispatches?.[dispatchId];
    check(dispatch && dispatch.state === 'LEASED' && dispatch.expires > Date.now(), 'REVIEW_DISPATCH_REQUIRED');
    check(run.state === (dispatch.role === 'reviewer' ? 'REVIEWING' : 'FINAL_AUDIT'), 'INVALID_RUN_STATE');
    check(dispatch.sha === reviewedSha && await git(run.integrationPath, 'rev-parse', 'HEAD') === reviewedSha && dispatch.source === await sourceFingerprint(run.integrationPath), 'REVIEW_STALE');
    nativeAgentId.parse(nativeId);
    check(!run.implementers?.includes(nativeId) && !Object.values(run.tasks).some(task => task.nativeId === nativeId) && !run.reviews.some(review => review.reviewer === nativeId), 'REVIEW_NOT_INDEPENDENT');
    verifyPreparedClaudeDefinition(dispatch.nativeContext, dispatch.resolution);
    const observation = observeRoleModel(dispatch.resolution, { model: observedModel, effort: observedEffort }, dispatch.nativeContext.models);
    dispatch.nativeId = nativeId; dispatch.observation = observation; dispatch.state = observation.policyViolation ? 'BLOCKED_MODEL_POLICY' : 'RUNNING';
    this.store.snapshot(run.id, 'model', `${dispatchId}-observed`, { nativeId, observation });
    return { state: dispatch.state, observation };
  }
  async stopReview(run: Run, dispatchId: string, nativeStopped: boolean, nativeId: string | null) {
    const dispatch = run.reviewDispatches?.[dispatchId]; check(dispatch, 'REVIEW_DISPATCH_REQUIRED');
    check(nativeStopped && dispatch.nativeId === nativeId, 'WORKER_STOP_UNCONFIRMED');
    if (dispatch.state !== 'COMPLETED') dispatch.state = 'STOPPED';
    return { state: dispatch.state };
  }
  async heartbeat(run: Run, taskId: string, lease: string, generation: number, nativeId: string, receipt: HostHeartbeat) {
    enforceRunBudget(run);
    const task = run.tasks[taskId]; check(task, 'TASK_NOT_FOUND');
    const previous = task.expires;
    const confirmed = confirmHostHeartbeat(task, { leaseId: lease, generation, nativeId }, receipt, this.native?.source === 'coordinator_native_receipt',
      run.config.execution.task_timeout_minutes * 60000, Date.now(), task.deadline ?? task.expires);
    return { ...confirmed, leaseRenewed: task.expires > previous, deadlinePreserved: true };
  }
  async reconcileLiveness(run: Run) {
    return { orphanedTasks: reconcileExpiredTasks(run.tasks), preserved: true, hostStopInferred: false };
  }
  ready(run: Run) {
    if (run.state !== 'EXECUTING') return [];
    const tasks = Object.values(run.tasks);
    const active = tasks.filter(task => ['LEASED', 'RUNNING', 'ORPHANED_UNKNOWN', 'MERGE_QUEUED'].includes(task.state));
    const slots = run.config.execution.max_parallel_workers - active.filter(task => task.state !== 'MERGE_QUEUED').length;
    const children = new Map<string, Work[]>(), distances = new Map<string, number>();
    for (const task of tasks) for (const parent of task.spec.depends_on) children.set(parent, [...(children.get(parent) ?? []), task]);
    const distance = (task: Work): number => {
      if (!distances.has(task.spec.id)) distances.set(task.spec.id, 1 + Math.max(0, ...(children.get(task.spec.id) ?? []).map(distance)));
      return distances.get(task.spec.id)!;
    };
    const candidates = tasks.filter(task => ['PENDING', 'RETRYABLE_FAILED'].includes(task.state) && task.attempt < run.config.execution.max_task_attempts && task.spec.depends_on.every(key => run.tasks[key].state === 'INTEGRATED'));
    candidates.sort((a, b) => distance(b) - distance(a));
    const selected: Work[] = [];
    for (const task of candidates) {
      if (selected.length >= slots) break;
      if (![...active, ...selected].some(other => overlaps(other.spec.write_paths, task.spec.write_paths) || other.spec.exclusive_resources.some(key => task.spec.exclusive_resources.includes(key)))) selected.push(task);
    }
    return selected.map(task => task.spec.id);
  }
  async retry(run: Run, taskId: string, lease: string, generation: number, nativeStopped: boolean, reason: string) {
    const task = run.tasks[taskId]; check(task, 'TASK_NOT_FOUND');
    check(task.lease === lease && task.attempt === generation, 'STALE_LEASE');
    check(nativeStopped && reason.trim().length > 0, 'WORKER_STOP_UNCONFIRMED');
    check(['RUNNING', 'LEASED', 'ORPHANED_UNKNOWN'].includes(task.state), 'INVALID_TASK_STATE');
    await this.taskIdentity(run, task);
    await this.releaseTaskPort(run, taskId);
    task.attempts ??= []; task.attempts.push({ number: task.attempt, path: task.path, branch: task.branch, nativeId: task.nativeId, stopped: true, reason, configRevision: task.configRevision, modelResolution: structuredClone(task.modelResolution), observedModel: task.observedModel, observedEffort: task.observedEffort, modelObservation: structuredClone(task.modelObservation), resources: task.resources });
    task.recoveryHead = Object.keys(task.units).length ? await git(task.path, 'rev-parse', 'HEAD') : undefined;
    task.validated = null; task.expires = 0;
    task.state = task.attempt < run.config.execution.max_task_attempts ? 'RETRYABLE_FAILED' : 'BLOCKED_ATTEMPT_LIMIT';
    if (task.state === 'BLOCKED_ATTEMPT_LIMIT') run.state = 'BLOCKED_TASK_ATTEMPT_LIMIT';
    return { state: task.state, preservedWorktree: task.path, attempt: task.attempt };
  }
  leased(run: Run, taskId: string, lease: string, generation: number) {
    const task = run.tasks[taskId]; check(task, 'TASK_NOT_FOUND');
    check(task.lease === lease && task.attempt === generation && Date.now() < task.expires, 'STALE_LEASE');
    return task;
  }
  async bind(run: Run, taskId: string, lease: string, generation: number, nativeId: string, observedModel: string | null, observedEffort: string | null, bootstrap?: { cwd: string; origin_root: string; branch: string; head: string; common_dir: string }) {
    const task = this.leased(run, taskId, lease, generation);
    check(this.native?.verified && this.native.contextMatches && this.native.host === run.host, 'BLOCKED_CAPABILITY');
    check(task.state === 'LEASED', 'INVALID_TASK_STATE');
    const repo = await inspectRepository(task.path);
    check(repo.root === await realpath(task.path) && repo.commonDir === run.commonDir && repo.branch === task.branch && repo.head === (task.dispatchBase ?? task.base) && !repo.dirty, 'BASE_SHA_MISMATCH');
    if (this.native.source === 'coordinator_native_receipt') check(bootstrap && bootstrap.cwd === repo.root && bootstrap.origin_root === repo.root && bootstrap.common_dir === repo.commonDir && bootstrap.branch === repo.branch && bootstrap.head === repo.head, 'WORKER_BOOTSTRAP_MISMATCH');
    check(task.modelResolution, 'MODEL_RESOLUTION_REQUIRED');
    verifyPreparedClaudeDefinition(task.nativeContext, task.modelResolution);
    const observation = observeRoleModel(task.modelResolution, { model: observedModel, effort: observedEffort }, task.nativeContext?.models);
    task.modelObservation = observation;
    if (bootstrap) task.nativeBootstrap = structuredClone(bootstrap);
    task.observedModel = observedModel; task.observedEffort = observedEffort;
    task.nativeId = nativeAgentId.parse(nativeId); run.implementers ??= []; run.implementers.push(task.nativeId); task.state = 'RUNNING';
    this.store.snapshot(run.id, 'model', `${attemptKey(taskId, task.attempt)}-observed`, { nativeId: task.nativeId, observation });
    if (observation.policyViolation) {
      task.pausedState = 'RUNNING'; task.state = 'ORPHANED_UNKNOWN'; run.pausedFrom = run.state; run.state = 'PAUSED'; run.pauseStartedAt = Date.now();
      return { state: task.state, reason: 'MODEL_OBSERVATION_MISMATCH', observation };
    }
    return { state: task.state, observation };
  }
  async taskIdentity(run: Run, task: Work) {
    const repo = await inspectRepository(task.path);
    check(repo.root === await realpath(task.path) && repo.commonDir === run.commonDir && repo.branch === task.branch, 'WORKTREE_IDENTITY_MISMATCH');
    return repo;
  }
  async validate(run: Run, taskId: string, lease: string, generation: number) {
    enforceRunBudget(run);
    check(run.state === 'EXECUTING', 'INVALID_RUN_STATE');
    const task = this.leased(run, taskId, lease, generation);
    check(task.state === 'RUNNING', 'INVALID_TASK_STATE');
    await this.taskIdentity(run, task);
    const paths = await changedPaths(task.path, task.base);
    check(paths.every(path => owns(task.spec.write_paths, path)), 'OWNERSHIP_VIOLATION');
    const gate = await this.gate(run, 'task', task.path, taskId);
    task.validated = acceptedGate(gate) ? gate.source : null;
    return gate;
  }
  async commit(run: Run, taskId: string, lease: string, generation: number, unit: string) {
    enforceRunBudget(run);
    check(run.state === 'EXECUTING', 'INVALID_RUN_STATE');
    const task = this.leased(run, taskId, lease, generation);
    check(task.state === 'RUNNING', 'INVALID_TASK_STATE');
    await this.taskIdentity(run, task);
    const spec = task.spec.commit_units.find(candidate => candidate.id === unit); check(spec, 'UNKNOWN_UNIT');
    if (task.units[unit]) return { sha: task.units[unit] };
    check(task.validated && task.validated === await sourceFingerprint(task.path), 'VALIDATION_STALE');
    const gate = run.gates.filter(gate => gate.stage === 'task' && gate.task === taskId).at(-1);
    check(gate && acceptedGate(gate) && gate.commands === hash(run.config.quality.commands) && gate.source === task.validated && await this.gateInputsFresh(gate, task.path), 'VALIDATION_STALE');
    const expectedHead = task.lastCommitSha ?? task.dispatchBase ?? task.base;
    check(await git(task.path, 'rev-parse', 'HEAD') === expectedHead, 'COMMIT_HEAD_MISMATCH');
    const paths = await changedPaths(task.path);
    check(paths.length && paths.every(path => owns(task.spec.write_paths, path)), 'OWNERSHIP_VIOLATION');
    check((await changedPaths(task.path, task.base)).every(path => owns(task.spec.write_paths, path)), 'OWNERSHIP_VIOLATION');
    await git(task.path, 'add', '--', ...paths);
    await assertNoStagedSecrets(task.path);
    await git(task.path, 'diff', '--cached', '--check');
    this.checkpointIntent(run);
    await git(task.path, 'commit', '-m', `${spec.purpose}\n\nOrch-Run: ${run.id}\nOrch-Task: ${taskId}\nOrch-Unit: ${unit}`);
    const sha = await git(task.path, 'rev-parse', 'HEAD');
    check(await git(task.path, 'show', '-s', '--format=%P', sha) === expectedHead && (await changedPaths(task.path, task.base)).every(path => owns(task.spec.write_paths, path)), 'COMMIT_RESULT_MISMATCH');
    task.units[unit] = sha; task.lastCommitSha = sha; task.validated = null;
    return { sha };
  }
  async verifySubmission(run: Run, task: Work) {
    check(task.spec.commit_units.every(unit => task.units[unit.id]), 'UNITS_INCOMPLETE');
    const repo = await inspectRepository(task.path);
    check(repo.commonDir === run.commonDir && repo.branch === task.branch && !repo.dirty, 'DIRTY_CHECKOUT');
    check((await changedPaths(task.path, task.base)).every(path => owns(task.spec.write_paths, path)), 'OWNERSHIP_VIOLATION');
    await git(task.path, 'merge-base', '--is-ancestor', task.base, 'HEAD');
    const submitted = (await git(task.path, 'rev-list', `${task.base}..HEAD`)).split('\n').filter(Boolean);
    check(submitted.length === Object.keys(task.units).length && submitted.every(sha => Object.values(task.units).includes(sha)), 'UNTRACKED_COMMIT');
    for (const unit of task.spec.commit_units) {
      const sha = task.units[unit.id], message = `${await git(task.path, 'show', '-s', '--format=%B', sha)}\n`;
      const parents = (await git(task.path, 'show', '-s', '--format=%P', sha)).split(' ');
      check(parents.length === 1 && message.includes(`Orch-Run: ${run.id}\n`) && message.includes(`Orch-Task: ${task.spec.id}\n`) && message.includes(`Orch-Unit: ${unit.id}\n`), 'UNTRACKED_COMMIT');
    }
    const gate = run.gates.filter(item => item.task === task.spec.id && item.stage === 'task').at(-1);
    check(gate && acceptedGate(gate) && gate.commands === hash(run.config.quality.commands) && gate.source === await sourceFingerprint(task.path) && await this.gateInputsFresh(gate, task.path), 'VALIDATION_STALE');
  }
  async complete(run: Run, taskId: string, lease: string, generation: number, nativeStopped: boolean, submittedResult: unknown = null) {
    const task = this.leased(run, taskId, lease, generation);
    check(nativeStopped, 'WORKER_STOP_UNCONFIRMED');
    check(task.state === 'RUNNING', 'INVALID_TASK_STATE');
    await this.verifySubmission(run, task);
    if (submittedResult !== null) {
      const result = taskResultSchema.parse(submittedResult);
      check(result.runId === run.id && result.taskId === taskId && result.attemptId === attemptKey(taskId, task.attempt) && result.baseSha === (task.dispatchBase ?? task.base) && await realpath(result.worktreePath) === await realpath(task.path), 'TASK_RESULT_IDENTITY_MISMATCH');
      check(result.status === 'ready_for_validation' && result.completedUnits.length === Object.keys(task.units).length && result.completedUnits.every(unit => task.units[unit.unitId] === unit.commitSha), 'TASK_RESULT_MISMATCH');
      const actual = await changedPaths(task.path, task.dispatchBase ?? task.base);
      check(result.changedPaths.length === actual.length && result.changedPaths.every(path => actual.includes(path)), 'TASK_RESULT_MISMATCH');
      const gateIds = run.gates.filter(gate => gate.task === taskId).flatMap(gate => gate.details?.map(detail => detail.id) ?? []);
      check(task.spec.verification_ids.every(command => run.gates.filter(gate => gate.task === taskId).at(-1)?.details?.some(detail => detail.gateId === command && acceptedGate(detail) && result.gateResultIds.includes(detail.id))), 'TASK_RESULT_EVIDENCE_MISSING');
      check(result.gateResultIds.every(key => gateIds.includes(key)) && task.spec.acceptance_ids.every(key => result.acceptanceEvidence.some(item => item.acceptanceId === key)), 'TASK_RESULT_EVIDENCE_MISSING');
      task.acceptanceEvidence = result.acceptanceEvidence; task.changedPaths = result.changedPaths; task.reportedModel = result.reportedModel;
    }
    task.state = 'MERGE_QUEUED'; return { state: task.state };
  }
  async integrate(run: Run, taskId: string, expectedSha: string) {
    enforceRunBudget(run);
    check(run.state === 'EXECUTING', 'INVALID_RUN_STATE');
    const task = run.tasks[taskId]; check(task?.state === 'MERGE_QUEUED', 'TASK_NOT_READY');
    await this.verifySubmission(run, task);
    check(expectedSha === (run.integrationSha ?? run.targetBase) && await git(run.integrationPath, 'rev-parse', 'HEAD') === expectedSha, 'INTEGRATION_DRIFT');
    check(!(await inspectRepository(run.integrationPath)).dirty, 'DIRTY_CHECKOUT');
    const taskHead = await git(task.path, 'rev-parse', 'HEAD');
    const candidate = { path: join(run.managedRoot, run.id, `conflict-${this.activeOperation}`), branch: `orch/${run.id}/conflict/${this.activeOperation}` };
    run.candidates ??= []; run.candidates.push(candidate);
    this.checkpointIntent(run);
    await git(run.origin, 'worktree', 'add', '-b', candidate.branch, candidate.path, expectedSha);
    try { await git(candidate.path, 'merge', '--no-ff', '--no-edit', task.branch); }
    catch {
      run.conflict = { ...candidate, taskId, expected: expectedSha, taskHead }; run.state = 'BLOCKED_CONFLICT';
      return { state: run.state, preserved: candidate.path, expectedSha, taskHead };
    }
    await git(run.integrationPath, 'merge', '--ff-only', candidate.branch);
    const parents = (await git(run.integrationPath, 'show', '-s', '--format=%P', 'HEAD')).split(' ');
    check(parents.includes(expectedSha) && parents.includes(await git(task.path, 'rev-parse', 'HEAD')), 'MERGE_PARENTS_MISMATCH');
    task.state = 'INTEGRATED'; run.integrationSha = await git(run.integrationPath, 'rev-parse', 'HEAD'); run.reviews = [];
    if (Object.values(run.tasks).every(work => work.state === 'INTEGRATED')) run.state = 'VERIFYING';
    return { sha: await git(run.integrationPath, 'rev-parse', 'HEAD'), state: run.state };
  }
  async resolveConflict(run: Run, nativeStopped: boolean) {
    if (run.targetConflict) {
      check(run.state === 'BLOCKED_CONFLICT' && nativeStopped, 'CONFLICT_RESOLUTION_NOT_READY');
      const conflict = run.targetConflict, repo = await inspectRepository(conflict.path), target = await inspectRepository(run.origin), integration = await inspectRepository(run.integrationPath);
      check(repo.commonDir === run.commonDir && repo.branch === conflict.branch && repo.head === conflict.expected, 'CONFLICT_BASE_MISMATCH');
      check(target.branch === run.target && target.head === conflict.target && !target.dirty && integration.commonDir === run.commonDir && integration.branch === run.integration && integration.head === conflict.expected && !integration.dirty, 'TARGET_DRIFT');
      check(await git(conflict.path, 'rev-parse', '--verify', 'MERGE_HEAD') === conflict.target, 'CONFLICT_PARENT_MISMATCH');
      const paths = await changedPaths(conflict.path), allowed = [...Object.values(run.tasks).flatMap(task => task.spec.write_paths), ...await changedPaths(run.origin, run.targetBase)];
      check(paths.every(path => owns(allowed, path)), 'OWNERSHIP_VIOLATION');
      if (paths.length) await git(conflict.path, 'add', '--', ...paths);
      await git(conflict.path, 'diff', '--cached', '--check');
      check(await git(conflict.path, 'diff', '--name-only', '--diff-filter=U') === '', 'CONFLICT_UNRESOLVED');
      this.checkpointIntent(run);
      await git(conflict.path, 'commit', '--no-edit');
      const parents = (await git(conflict.path, 'show', '-s', '--format=%P', 'HEAD')).split(' ');
      check(parents.length === 2 && parents[0] === conflict.expected && parents[1] === conflict.target, 'MERGE_PARENTS_MISMATCH');
      await git(run.integrationPath, 'merge', '--ff-only', conflict.branch);
      run.integrationSha = await git(run.integrationPath, 'rev-parse', 'HEAD'); run.targetBase = conflict.target;
      run.targetConflict = undefined; run.reviews = []; run.finalizationApproval = undefined; run.state = 'VERIFYING';
      return { state: run.state, sha: run.integrationSha, targetBase: run.targetBase };
    }
    check(run.state === 'BLOCKED_CONFLICT' && run.conflict && nativeStopped, 'CONFLICT_RESOLUTION_NOT_READY');
    const conflict = run.conflict, task = run.tasks[conflict.taskId];
    const repo = await inspectRepository(conflict.path);
    check(repo.commonDir === run.commonDir && repo.branch === conflict.branch && repo.head === conflict.expected, 'CONFLICT_BASE_MISMATCH');
    check(await git(run.integrationPath, 'rev-parse', 'HEAD') === conflict.expected, 'INTEGRATION_DRIFT');
    check(await git(conflict.path, 'rev-parse', '--verify', 'MERGE_HEAD') === conflict.taskHead, 'CONFLICT_PARENT_MISMATCH');
    const paths = await changedPaths(conflict.path);
    const allowed = Object.values(run.tasks).filter(work => work.state === 'INTEGRATED' || work === task).flatMap(work => work.spec.write_paths);
    check(paths.every(path => owns(allowed, path)), 'OWNERSHIP_VIOLATION');
    if (paths.length) await git(conflict.path, 'add', '--', ...paths);
    await git(conflict.path, 'diff', '--cached', '--check');
    check(await git(conflict.path, 'diff', '--name-only', '--diff-filter=U') === '', 'CONFLICT_UNRESOLVED');
    const gate = await this.gate(run, 'integration', conflict.path);
    if (!acceptedGate(gate)) return gate;
    this.checkpointIntent(run);
    await git(conflict.path, 'commit', '--no-edit');
    const parents = (await git(conflict.path, 'show', '-s', '--format=%P', 'HEAD')).split(' ');
    check(parents.length === 2 && parents[0] === conflict.expected && parents[1] === conflict.taskHead, 'MERGE_PARENTS_MISMATCH');
    await git(run.integrationPath, 'merge', '--ff-only', conflict.branch);
    task.state = 'INTEGRATED'; run.integrationSha = await git(run.integrationPath, 'rev-parse', 'HEAD'); run.conflict = undefined; run.reviews = [];
    run.state = Object.values(run.tasks).every(work => work.state === 'INTEGRATED') ? 'VERIFYING' : 'EXECUTING';
    return { state: run.state, sha: await git(run.integrationPath, 'rev-parse', 'HEAD') };
  }
  async verify(run: Run) {
    enforceRunBudget(run);
    check(['VERIFYING', 'REVIEWING', 'BLOCKED_TESTS'].includes(run.state), 'INVALID_RUN_STATE');
    const gate = await this.gate(run, 'integration', run.integrationPath);
    run.reviews = []; run.state = acceptedGate(gate) ? 'REVIEWING' : 'BLOCKED_TESTS'; return gate;
  }
  async review(run: Run, input: unknown, final = false, nativeStopped = false) {
    enforceRunBudget(run);
    check(run.state === (final ? 'FINAL_AUDIT' : 'REVIEWING'), 'INVALID_RUN_STATE');
    const review = reviewSchema.parse(input), current = await git(run.integrationPath, 'rev-parse', 'HEAD');
    if (run.hostEvidence?.source === 'coordinator_native_receipt' || this.native?.source === 'coordinator_native_receipt') {
      check(this.native?.verified && this.native.contextMatches && this.native.host === run.host, 'BLOCKED_CAPABILITY');
      check(nativeStopped, 'WORKER_STOP_UNCONFIRMED');
      const dispatch = Object.values(run.reviewDispatches ?? {}).find(item => item.nativeId === review.reviewer_id && item.role === (final ? 'final_auditor' : 'reviewer') && item.sha === current && item.state === 'RUNNING');
      check(dispatch && dispatch.expires > Date.now(), 'REVIEW_DISPATCH_REQUIRED');
      check(dispatch.source === await sourceFingerprint(run.integrationPath), 'REVIEW_SOURCE_CHANGED');
      dispatch.state = 'COMPLETED';
    }
    check(review.reviewed_sha === current, 'REVIEW_STALE');
    const integrationGate = run.gates.filter(gate => gate.stage === 'integration').at(-1);
    check(integrationGate && integrationGate.sha === current && acceptedGate(integrationGate) && integrationGate.commands === hash(run.config.quality.commands) && integrationGate.source === await sourceFingerprint(run.integrationPath) && await this.gateInputsFresh(integrationGate, run.integrationPath), 'VALIDATION_STALE');
    check(!run.implementers?.includes(review.reviewer_id) && !Object.values(run.tasks).some(task => task.nativeId === review.reviewer_id), 'REVIEW_NOT_INDEPENDENT');
    check(!final || !run.reviews.some(item => item.reviewer === review.reviewer_id), 'AUDIT_NOT_INDEPENDENT');
    check(run.plan?.acceptance.every(item => review.acceptance_ids.includes(item.id)), 'UNMAPPED_ACCEPTANCE');
    check(new Set(review.findings.map(finding => finding.id)).size === review.findings.length, 'DUPLICATE_FINDING');
    check(review.findings.every(finding => finding.line_end >= finding.line_start && finding.acceptance_ids.every(key => run.plan?.acceptance.some(item => item.id === key))), 'UNKNOWN_ACCEPTANCE');
    const incoming = review.findings.map(finding => ({ ...finding, fingerprint: hash([finding.path, finding.symbol, finding.category, finding.acceptance]), lifecycle: 'OPEN', seenRounds: [run.reviewRound] }));
    for (const finding of incoming) {
      const old = run.findings.find(item => item.id === finding.id || item.fingerprint === finding.fingerprint);
      if (old) {
        const rank = { low: 0, medium: 1, high: 2, critical: 3 };
        check(rank[finding.severity] >= rank[old.severity], 'FINDING_SEVERITY_DOWNGRADE');
        const disposition = old.dispositions?.at(-1);
        const keepDisposition = old.fingerprint === finding.fingerprint && old.severity === finding.severity && disposition?.sha === current && disposition.status === old.lifecycle && ['ACCEPTED_RISK', 'NOT_A_BUG', 'DEFERRED'].includes(old.lifecycle) && (['evidence', 'reproduction', 'summary', 'acceptance', 'suggested_test', 'acceptance_ids'] as const).every(key => hash(old[key]) === hash(finding[key]));
        Object.assign(old, finding, { seenRounds: [...new Set([...(old.seenRounds ?? [0]), run.reviewRound])], id: old.id, lifecycle: keepDisposition ? old.lifecycle : old.lifecycle === 'VERIFIED_FIXED' ? 'REOPENED' : 'OPEN' });
      } else run.findings.push(finding);
    }
    // Absence is only accepted after an independent full review of the same verified SHA.
    for (const finding of run.findings) if (finding.lifecycle === 'FIX_PROPOSED' && !incoming.some(item => item.fingerprint === finding.fingerprint || item.id === finding.id)) finding.lifecycle = 'VERIFIED_FIXED';
    const blocking = run.findings.some(finding => findingBlocks(run, finding));
    run.reviews.push({ sha: current, reviewer: review.reviewer_id, final, acceptanceIds: review.acceptance_ids, decision: review.decision, limitations: review.limitations });
    if (blocking || review.decision === 'changes_requested') run.state = run.reviewRound >= run.config.execution.max_review_rounds ? 'BLOCKED_REVIEW_LIMIT' : run.findings.some(finding => finding.lifecycle !== 'VERIFIED_FIXED' && (finding.seenRounds?.length ?? 1) >= run.config.execution.max_repeated_finding_rounds) ? 'BLOCKED_REPEATED_FINDING' : 'REPAIR_PLANNING';
    else run.state = final ? 'READY_TO_FINALIZE' : 'FINAL_AUDIT';
    return { state: run.state, findings: run.findings };
  }
  async repair(run: Run, input: unknown, findingIds: string[], analysis?: string) {
    enforceRunBudget(run);
    check(['REPAIR_PLANNING', 'BLOCKED_REPEATED_FINDING', 'BLOCKED_TESTS'].includes(run.state) && run.reviewRound < run.config.execution.max_review_rounds, 'BLOCKED_REVIEW_LIMIT');
    if (run.state === 'BLOCKED_REPEATED_FINDING') { check(typeof analysis === 'string' && analysis.trim(), 'REANALYSIS_REQUIRED'); run.repairAnalyses ??= []; run.repairAnalyses.push({ round: run.reviewRound, analysis }); }
    const plan = validatePlan(input);
    check(run.requirements && plan.acceptance.every(item => run.requirements!.acceptance.some(required => required.id === item.id && required.text === item.text)), 'REQUIREMENTS_PLAN_MISMATCH');
    check(plan.tasks.every(task => !run.tasks[task.id]), 'DUPLICATE_ID');
    const unresolved = run.findings.filter(finding => findingBlocks(run, finding));
    check(unresolved.every(finding => findingIds.includes(finding.id) && plan.tasks.some(task => owns(task.write_paths, finding.path))), 'FINDING_UNMAPPED');
    for (const finding of unresolved) finding.lifecycle = 'FIX_PROPOSED';
    for (const spec of plan.tasks) run.tasks[spec.id] = { spec, state: 'PENDING', base: '', path: '', branch: '', attempt: 0, lease: '', expires: 0, nativeId: null, units: {}, validated: null };
    run.reviewRound++; run.state = 'EXECUTING'; return { state: run.state, round: run.reviewRound };
  }
  async disposeFinding(run: Run, findingId: string, status: 'ACCEPTED_RISK' | 'NOT_A_BUG' | 'DEFERRED', reason: string, approved: boolean) {
    check(['REPAIR_PLANNING', 'BLOCKED_REPEATED_FINDING', 'BLOCKED_REVIEW_LIMIT', 'REVIEWING', 'FINAL_AUDIT', 'READY_TO_FINALIZE'].includes(run.state), 'INVALID_RUN_STATE');
    check(approved && reason.trim(), 'APPROVAL_REQUIRED');
    check(['ACCEPTED_RISK', 'NOT_A_BUG', 'DEFERRED'].includes(status), 'INVALID_FINDING_DISPOSITION');
    const finding = run.findings.find(item => item.id === findingId); check(finding, 'FINDING_NOT_FOUND');
    finding.dispositions ??= []; finding.dispositions.push({ status, reason, actor: 'user', approvedAt: new Date().toISOString(), sha: run.integrationSha ?? null });
    finding.lifecycle = status; run.reviews = []; run.state = 'REVIEWING';
    return { state: run.state, finding };
  }
  async waiveGate(run: Run, stage: 'baseline' | 'task' | 'integration' | 'final', gateId: string, taskId: string | null, reason: string, approved: boolean) {
    check(approved && reason.trim(), 'APPROVAL_REQUIRED');
    const command = run.config.quality.commands.find(item => item.id === gateId && item.stages.includes(stage)); check(command, 'GATE_NOT_FOUND');
    check(stage === 'task' ? taskId && run.tasks[taskId] : taskId === null, 'GATE_SCOPE_MISMATCH');
    const path = stage === 'baseline' ? run.origin : stage === 'task' ? run.tasks[taskId!].path : run.integrationPath;
    const waiver = { stage, taskId, gateId, sha: await git(path, 'rev-parse', 'HEAD'), source: await sourceFingerprint(path), command: hash(command), reason, actor: 'user' as const, approvedAt: new Date().toISOString() };
    run.waivers ??= []; run.waivers.push(waiver);
    if (run.state === 'BLOCKED_BASELINE') run.state = 'PREFLIGHT';
    if (run.state === 'BLOCKED_TESTS') run.state = stage === 'final' ? 'READY_TO_FINALIZE' : 'VERIFYING';
    return waiver;
  }
  async preapproveFinalization(run: Run, target: string, approved: boolean) {
    check(approved, 'APPROVAL_REQUIRED');
    check(!['COMPLETED', 'CANCELLED', 'FAILED'].includes(run.state) && target === run.target, 'APPROVAL_SCOPE_MISMATCH');
    run.finalizationApproval = { actor: 'user', target, runId: run.id, approvedAt: new Date().toISOString() };
    return { policy: 'auto_on_success', approval: run.finalizationApproval };
  }
  async finalize(run: Run, approved: boolean, expectedTarget: string) {
    enforceRunBudget(run);
    check(run.state === 'READY_TO_FINALIZE', 'INVALID_RUN_STATE');
    check(approved || run.finalizationApproval?.actor === 'user' && run.finalizationApproval.runId === run.id && run.finalizationApproval.target === run.target, 'APPROVAL_REQUIRED');
    const repo = await inspectRepository(run.origin), head = await git(run.integrationPath, 'rev-parse', 'HEAD');
    check(repo.branch === run.target && repo.head === run.targetBase && repo.head === expectedTarget, 'TARGET_DRIFT');
    check(!repo.dirty && !(await inspectRepository(run.integrationPath)).dirty, 'DIRTY_CHECKOUT');
    check(run.integrationSha === head, 'INTEGRATION_DRIFT');
    check(completionEvidence(run, null, { beforeFinalGate: true, beforeTarget: true, allowApprovedWaivers: true }).blockers.length === 0, 'COMPLETION_UNVERIFIED');
    const integrationGate = run.gates.filter(gate => gate.stage === 'integration' && gate.task === null).at(-1);
    check(integrationGate?.source === await sourceFingerprint(run.integrationPath) && await this.gateInputsFresh(integrationGate, run.integrationPath), 'VALIDATION_STALE');
    const gate = await this.gate(run, 'final', run.integrationPath);
    if (!acceptedGate(gate)) { run.state = 'BLOCKED_TESTS'; return gate; }
    const targetNow = await inspectRepository(run.origin), integrationNow = await inspectRepository(run.integrationPath);
    check(targetNow.branch === run.target && targetNow.head === expectedTarget && targetNow.head === run.targetBase && !targetNow.dirty, 'TARGET_DRIFT');
    check(integrationNow.branch === run.integration && integrationNow.head === head && !integrationNow.dirty, 'INTEGRATION_DRIFT');
    check(completionEvidence(run, null, { beforeTarget: true, allowApprovedWaivers: true }).blockers.length === 0, 'COMPLETION_UNVERIFIED');
    check(gate.source === await sourceFingerprint(run.integrationPath) && await this.gateInputsFresh(integrationGate, run.integrationPath) && await this.gateInputsFresh(gate, run.integrationPath), 'VALIDATION_STALE');
    this.checkpointIntent(run);
    enforceRunBudget(run);
    await git(run.origin, 'merge', '--ff-only', run.integration);
    check(await git(run.origin, 'rev-parse', 'HEAD') === head, 'FINALIZE_MISMATCH');
    run.finalizedAt = new Date().toISOString(); run.state = 'COMPLETED'; return { sha: head, cleanupStatus: 'not_requested' };
  }
  async reintegrateTarget(run: Run, expectedTarget: string) {
    enforceRunBudget(run);
    check(['READY_TO_FINALIZE', 'VERIFYING', 'REVIEWING', 'FINAL_AUDIT', 'BLOCKED_TESTS'].includes(run.state), 'INVALID_RUN_STATE');
    check(Object.values(run.tasks).every(task => task.state === 'INTEGRATED'), 'TASKS_UNINTEGRATED');
    const target = await inspectRepository(run.origin), integration = await inspectRepository(run.integrationPath);
    check(target.branch === run.target && target.head === expectedTarget, 'TARGET_DRIFT');
    check(integration.commonDir === run.commonDir && integration.branch === run.integration && integration.head === run.integrationSha, 'INTEGRATION_DRIFT');
    check(!target.dirty && !integration.dirty, 'DIRTY_CHECKOUT');
    const candidate = { path: join(run.managedRoot, run.id, `target-${this.activeOperation}`), branch: `orch/${run.id}/target/${this.activeOperation}` };
    run.candidates ??= []; run.candidates.push(candidate);
    this.checkpointIntent(run);
    await git(run.origin, 'worktree', 'add', '-b', candidate.branch, candidate.path, integration.head);
    try { await git(candidate.path, 'merge', '--no-ff', '--no-edit', expectedTarget); }
    catch { run.targetConflict = { ...candidate, expected: integration.head, target: expectedTarget }; run.state = 'BLOCKED_CONFLICT'; run.reviews = []; run.finalizationApproval = undefined; return { state: run.state, preserved: candidate.path, reason: 'TARGET_CONFLICT' }; }
    check((await inspectRepository(run.origin)).head === expectedTarget, 'TARGET_DRIFT');
    await git(run.integrationPath, 'merge', '--ff-only', candidate.branch);
    run.integrationSha = await git(run.integrationPath, 'rev-parse', 'HEAD'); run.targetBase = expectedTarget;
    run.reviews = []; run.finalizationApproval = undefined; run.state = 'VERIFYING';
    return { state: run.state, sha: run.integrationSha, targetBase: run.targetBase };
  }
  async cleanup(run: Run, dryRun = true) {
    const resources = [...(run.candidates ?? []).map(candidate => ({ ...candidate, active: false })), ...Object.values(run.tasks).filter(task => task.path).map(task => ({ path: task.path, branch: task.branch, active: ['LEASED', 'RUNNING', 'ORPHANED_UNKNOWN'].includes(task.state) })), { path: run.integrationPath, branch: run.integration, active: Object.values(run.reviewDispatches ?? {}).some(item => !['COMPLETED', 'STOPPED'].includes(item.state)) }];
    const results: Run['cleanup'] = [];
    for (const item of resources) {
      let reason: string | null = null;
      if (run.state !== 'COMPLETED') reason = 'run_not_finalized';
      else if (item.active) reason = 'worker_stop_unconfirmed';
      else {
        const path = await realpath(item.path).catch(() => null);
        if (!path) {
          if (!within(run.managedRoot, resolve(item.path)) || !item.branch.startsWith(`orch/${run.id}/`)) { results.push({ path: item.path, status: 'preserved', reason: 'ownership_mismatch' }); continue; }
          const branchHead = await git(run.origin, 'rev-parse', '--verify', `refs/heads/${item.branch}`).catch(() => null);
          if (!branchHead) { results.push({ path: item.path, status: 'absent', reason: null }); continue; }
          try { await git(run.origin, 'merge-base', '--is-ancestor', branchHead, run.target); }
          catch { results.push({ path: item.path, status: 'preserved', reason: 'unmerged' }); continue; }
          if (dryRun) { results.push({ path: item.path, status: 'candidate', reason: null }); continue; }
          this.checkpointIntent(run);
          try { await git(run.origin, 'branch', '-d', item.branch); results.push({ path: item.path, status: 'removed', reason: null }); }
          catch { results.push({ path: item.path, status: 'preserved', reason: 'remove_failed' }); }
          continue;
        }
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
      if (run.state === 'COMPLETED') for (const [taskId, task] of Object.entries(run.tasks)) {
        if (!activeWriterStates.has(task.state)) await this.releaseTaskPort(run, taskId);
      }
      run.cleanup = results;
    }
    return results;
  }
  async control(run: Run, action: 'pause' | 'cancel' | 'resume', stoppedAgents: string[] = [], neverStartedTasks: string[] = []) {
    if (action === 'pause' || action === 'cancel') {
      check(run.state !== 'COMPLETED' && !run.abandonment && (action === 'cancel' || !['CANCELLED', 'PAUSED'].includes(run.state)), 'INVALID_RUN_STATE');
      if (run.state !== 'CANCELLED') { run.pauseStartedAt = Date.now(); run.pausedFrom = run.state; }
      run.state = action === 'pause' ? 'PAUSED' : 'CANCELLED';
      for (const [key, task] of Object.entries(run.tasks)) if (activeWriterStates.has(task.state)) {
        const neverStarted = !task.nativeId && (task.state === 'LEASED' || task.pausedState === 'LEASED') && neverStartedTasks.includes(key);
        const stopped = task.nativeId ? stoppedAgents.includes(task.nativeId) : neverStarted;
        if (task.state !== 'ORPHANED_UNKNOWN') task.pausedState = task.state;
        task.state = action === 'cancel' && stopped ? 'STOPPED' : 'ORPHANED_UNKNOWN';
      }
      if (action === 'cancel') for (const dispatch of Object.values(run.reviewDispatches ?? {})) {
        if (!['COMPLETED', 'STOPPED'].includes(dispatch.state) && dispatch.nativeId && stoppedAgents.includes(dispatch.nativeId)) dispatch.state = 'STOPPED';
      }
    } else {
      check(['PAUSED', 'CANCELLED'].includes(run.state), 'INVALID_RUN_STATE');
      for (const task of Object.values(run.tasks)) if (task.state === 'ORPHANED_UNKNOWN') {
        check(task.nativeId ? stoppedAgents.includes(task.nativeId) : task.pausedState === 'LEASED' && neverStartedTasks.includes(task.spec.id), 'ORPHANED_UNKNOWN');
        check(!(await this.taskIdentity(run, task)).dirty, 'DIRTY_RECOVERY_PRESERVED');
        const complete = task.spec.commit_units.every(unit => task.units[unit.id]);
        if (complete) await this.verifySubmission(run, task);
        await this.releaseTaskPort(run, task.spec.id);
        task.state = complete ? 'MERGE_QUEUED' : 'RETRYABLE_FAILED';
      }
      run.pauseTimeMs = (run.pauseTimeMs ?? 0) + (run.pauseStartedAt === undefined ? 0 : Math.max(0, Date.now() - run.pauseStartedAt));
      run.pauseStartedAt = undefined; run.state = run.pausedFrom || 'EXECUTING';
    }
    return { state: run.state };
  }
}
