import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { requirementsSchema, taskResultSchema, gateResultSchema, recommendationSchema, envelopeSchema, sha, relativePath, validatePlan, taskSchema, planSchema, planAmendmentSchema, runAbandonmentSchema, runHandoffSchema, reviewSchema } from '../../packages/protocol/src/runtime.ts';

const hash = 'a'.repeat(40);
const task = { id: 'T1', title: 'work', role: 'coder', depends_on: [], acceptance_ids: ['AC-1'], read_paths: [], write_paths: ['src/**'], exclusive_resources: [], risk: 'low', complexity: 'low', verification_ids: ['unit'], commit_units: [{ id: 'U1', purpose: 'feature' }] };
const requirements = { schema_version: 1, goals: ['feature'], in_scope: ['feature'], out_of_scope: [], acceptance: [{ id: 'AC-1', text: 'works' }], constraints: [], assumptions: [], risks: [], verification_plan: [{ acceptance_id: 'AC-1', method: 'unit test' }] };
test('requirements reject duplicate and unmapped acceptance criteria', () => {
  assert.equal(requirementsSchema.parse(requirements).acceptance.length, 1);
  assert.throws(() => requirementsSchema.parse({ ...requirements, acceptance: [...requirements.acceptance, ...requirements.acceptance] }));
  assert.throws(() => requirementsSchema.parse({ ...requirements, verification_plan: [{ acceptance_id: 'AC-2', method: 'unit' }] }));
});
const result = { schemaVersion: 1, runId: 'R1', taskId: 'T1', attemptId: 'A1', status: 'ready_for_validation', baseSha: hash, worktreePath: '/tmp/work', completedUnits: [{ unitId: 'U1', commitSha: hash }], changedPaths: ['src/main.ts'], acceptanceEvidence: [{ acceptanceId: 'AC-1', evidenceRefs: ['logs/unit.log'] }], gateResultIds: ['G1'], reportedModel: null, remainingIssues: [], summary: 'done' };
test('task results preserve self-report/null and reject invented success or unsafe changed paths', () => {
  assert.equal(taskResultSchema.parse(result).reportedModel, null);
  for (const patch of [{ status: 'passed' }, { reportedModel: 1 }, { changedPaths: ['../outside'] }, { completedUnits: [{ unitId: 'U1', commitSha: 'a'.repeat(41) }] }]) assert.throws(() => taskResultSchema.parse({ ...result, ...patch }));
});
const gate = { id: 'G1', runId: 'R1', taskId: null, gateId: 'unit', stage: 'baseline', commitSha: null, sourceFingerprint: 'source', commandFingerprint: 'command', environmentFingerprint: 'env', status: 'not_run', exitCode: null, startedAt: '2026-10-20T00:00:00Z', finishedAt: '2026-10-20T00:00:01Z', logRef: 'logs/unit.log', waiverReason: null };
test('gate evidence distinguishes not-run, exit failure and waived outcomes', () => {
  assert.equal(gateResultSchema.parse(gate).status, 'not_run');
  assert.equal(gateResultSchema.parse({ ...gate, status: 'passed', exitCode: 0 }).status, 'passed');
  for (const patch of [{ status: 'passed', exitCode: null }, { status: 'passed', exitCode: 1 }, { status: 'waived' }, { exitCode: 0 }, { finishedAt: 'yesterday' }, { taskId: 4 }]) assert.throws(() => gateResultSchema.parse({ ...gate, ...patch }));
});
const recommendation = { scope: 'project', host: 'codex', configRevision: 1, proposedPatch: [{ op: 'replace', path: '/hosts/codex/roles/coder/model', value: 'model' }], selections: [{ role: 'coder', modelId: 'model', effort: null, reasons: ['available'], evidenceRefs: ['catalog'], confidence: 'high' }], preservedOverrides: [], warnings: [], requiresApproval: true };
test('recommendations reject cross-host settings, unsafe pointers and invalid patch operands', () => {
  assert.equal(recommendationSchema.parse(recommendation).host, 'codex');
  for (const patch of [{ proposedPatch: [{ op: 'replace', path: '/hosts/claude/enabled', value: true }] }, { proposedPatch: [{ op: 'replace', path: '/hosts/codex' }] }, { proposedPatch: [{ op: 'remove', path: '/__proto__/x' }] }, { proposedPatch: [{ op: 'replace', path: '/hosts', value: {} }] }, { host: 'other' }, { selections: [{ ...recommendation.selections[0], role: 'invented' }] }]) assert.throws(() => recommendationSchema.parse({ ...recommendation, ...patch }));
});
test('write envelopes require input and paired positive fencing tokens', () => {
  const envelope = { protocol_version: 1, run_id: 'R1', operation_id: 'O1', expected_state_version: 0, input: {} };
  assert.equal(envelopeSchema.parse({ ...envelope, lease_id: 'L1', fencing_token: 1 }).fencing_token, 1);
  for (const patch of [{ lease_id: 'L1' }, { fencing_token: 1 }, { lease_id: 'L1', fencing_token: 0 }, { expected_state_version: -1 }, { protocol_version: 2 }]) assert.throws(() => envelopeSchema.parse({ ...envelope, ...patch }));
  const { input, ...missingInput } = envelope;
  assert.throws(() => envelopeSchema.parse(missingInput));
});
test('SHA and repository paths reject malformed boundary values', () => {
  assert.equal(sha.parse(hash), hash);
  for (const length of [39, 41, 63, 65]) assert.throws(() => sha.parse('a'.repeat(length)));
  for (const path of ['../outside', 'src/../../outside', '/root', 'C:\\root', 'src\\..\\outside', 'src/./secret', 'src\u0001file']) assert.throws(() => relativePath.parse(path));
});
test('plans reject repeated dependency, acceptance and unit references', () => {
  for (const tasks of [[task, { ...task, id: 'T2', depends_on: ['T1', 'T1'] }], [{ ...task, acceptance_ids: ['AC-1', 'AC-1'] }], [{ ...task, commit_units: [task.commit_units[0], task.commit_units[0]] }]]) assert.throws(() => validatePlan({ acceptance: [{ id: 'AC-1', text: 'works' }], tasks }));
});

test('published JSON schemas match the canonical runtime schemas', async () => {
  for (const [name, schema] of [['requirements', requirementsSchema], ['task', taskSchema], ['plan', planSchema], ['plan-amendment', planAmendmentSchema], ['run-abandonment', runAbandonmentSchema], ['run-handoff', runHandoffSchema], ['task-result', taskResultSchema], ['gate-result', gateResultSchema], ['review', reviewSchema], ['recommendation', recommendationSchema], ['write-envelope', envelopeSchema]] as const) {
    const artifact = JSON.parse(await readFile(new URL(`../../packages/protocol/schemas/${name}.schema.json`, import.meta.url), 'utf8'));
    assert.deepEqual(artifact, z.toJSONSchema(schema), name);
  }
});
