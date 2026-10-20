import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run } from '../../packages/core/src/runtime/engine.ts';
import { resolveConfig } from '../../packages/core/src/config/index.ts';
import { buildReport, writeReport } from '../../packages/core/src/reporting/index.ts';

const sha = 'a'.repeat(40);
function fixture(origin = '/repo'): Run {
  const spec: NonNullable<Run['plan']>['tasks'][number] = { id: 'T1', title: '<script>alert(1)</script>', role: 'coder', depends_on: [], acceptance_ids: ['AC-1'], read_paths: [], write_paths: ['feature.ts'], exclusive_resources: [], risk: 'low', complexity: 'low', verification_ids: ['unit'], commit_units: [{ id: 'U1', purpose: 'implement feature' }] };
  return { id: 'run-fixture', host: 'codex', origin, commonDir: '/repo/.git', target: 'main', targetBase: 'b'.repeat(40), integration: 'orch/run-fixture/integration', integrationPath: '/managed/integration', managedRoot: '/managed', state: 'COMPLETED', config: resolveConfig({}).config, plan: { acceptance: [{ id: 'AC-1', text: 'feature works' }], tasks: [spec] }, tasks: { T1: { spec, state: 'INTEGRATED', base: sha, path: '/managed/T1', branch: 'task/T1', attempt: 2, lease: 'lease', expires: 0, nativeId: 'agent1', units: { U1: sha }, validated: 'fingerprint' } }, gates: [], findings: [], reviews: [], reviewRound: 1, integrationSha: sha, createdAt: '2026-10-20T00:00:00Z', cleanup: [] };
}

test('task completion alone cannot claim verified acceptance or known model and usage', () => {
  const report = buildReport(fixture(), 7, sha);
  assert.equal(report.state, 'COMPLETED');
  assert.equal(report.completionVerified, false);
  assert.equal(report.acceptance[0].status, 'unknown');
  assert.equal(report.tasks[0].observedModel, null);
  assert.equal(report.tasks[0].usage, null);
  assert.equal(report.cost, null);
  assert.equal(report.cleanup.status, 'not_requested');
  assert.ok(report.blockers.includes('FINAL_GATE_UNVERIFIED'));
  assert.ok(!report.summary.includes('<script>'));
  assert.ok(report.summary.includes('&lt;script&gt;'));
});

test('complete evidence is SHA bound, independently reviewed, and cleanup stays separate', async () => {
  const run = fixture();
  run.config.quality.commands = [{ id: 'unit', executable: 'node', args: ['--test'], cwd: '.', stages: ['integration', 'final'], required: true, timeout_seconds: 5 }];
  const { hash } = await import('../../packages/core/src/state/store.ts');
  run.gates = ['integration', 'final'].map(stage => ({ stage, task: null, sha, source: 'source', commands: hash(run.config.quality.commands), status: 'passed', results: [{ id: 'unit', status: 'passed', exitCode: 0 }] }));
  run.reviews = [{ sha, reviewer: 'reviewer', final: false }, { sha, reviewer: 'auditor', final: true }].map(review => Object.assign(review, { decision: 'approved', acceptanceIds: ['AC-1'], limitations: [] }));
  Object.assign(run.tasks.T1, { acceptanceEvidence: [{ acceptanceId: 'AC-1', evidenceRefs: ['gate:unit', 'review:auditor'] }], observedModel: 'fixture-model', observedEffort: 'high' });
  run.cleanup = [{ path: '/managed/T1', status: 'preserved', reason: 'dirty' }];
  const report = buildReport(run, 8, sha);
  assert.equal(report.completionVerified, true);
  assert.equal(report.acceptance[0].status, 'verified');
  assert.equal(report.cleanup.status, 'partial');
  assert.equal(report.tasks[0].observedModel, 'fixture-model');
  assert.equal(buildReport(run, 8, 'c'.repeat(40)).completionVerified, false);
  run.reviews[1].reviewer = 'agent1';
  assert.equal(buildReport(run, 8, sha).completionVerified, false);
});

test('artifacts use fixed run paths and reject traversal and linked storage', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'orch-report-')));
  try {
    const run = fixture(directory), report = buildReport(run, 9, null);
    const artifacts = await writeReport(run, report);
    assert.equal(artifacts.summary, join(directory, '.orch/state/runs/run-fixture/reports/summary.md'));
    assert.match(await readFile(artifacts.summary, 'utf8'), /ORCH run report/);
    assert.equal(JSON.parse(await readFile(artifacts.acceptance, 'utf8')).acceptance[0].status, 'unknown');
    assert.equal(JSON.parse(await readFile(artifacts.cleanup, 'utf8')).status, 'not_requested');
    assert.deepEqual(JSON.parse(await readFile(artifacts.findings, 'utf8')).findings, []);
    await writeReport(run, buildReport(run, 10, null));
    assert.equal(JSON.parse(await readFile(artifacts.acceptance, 'utf8')).version, 10);
    await assert.rejects(writeReport({ ...run, id: '../escape' }, report));
    await assert.rejects(writeReport({ ...run, id: 'run-other' }, report), /REPORT_RUN_MISMATCH/);
    await rm(artifacts.summary);
    const victim = join(directory, 'victim');
    await mkdir(victim);
    await symlink(victim, artifacts.summary);
    await assert.rejects(writeReport(run, report), /REPORT_PATH_UNSAFE/);
    await rm(join(directory, '.orch'), { recursive: true });
    await symlink(victim, join(directory, '.orch'));
    await assert.rejects(writeReport(run, report), /REPORT_PATH_UNSAFE/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
