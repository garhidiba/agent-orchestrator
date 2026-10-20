import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRequirements } from '../../packages/core/src/requirements/index.ts';

const input = { schema_version: 1, goals: ['Ship a feature'], in_scope: ['CLI'], out_of_scope: ['Deployment'], acceptance: [{ id: 'AC-1', text: 'CLI produces the required output' }], constraints: ['No provider calls'], assumptions: [], risks: ['Compatibility'], verification_plan: [{ acceptance_id: 'AC-1', method: 'Run unit test' }] };
test('requirements persist the validated contract and stable readable artifacts', async () => {
  const origin = await realpath(await mkdtemp(join(tmpdir(), 'orch-requirements-')));
  try {
    const result = await writeRequirements(origin, 'run-1', input);
    assert.deepEqual(result.requirements, input);
    assert.equal(result.refs.json, join(origin, '.orch/state/runs/run-1/requirements.json'));
    assert.equal(result.refs.markdown, join(origin, '.orch/state/runs/run-1/requirements.md'));
    assert.deepEqual(JSON.parse(await readFile(result.refs.json, 'utf8')), input);
    const markdown = await readFile(result.refs.markdown, 'utf8');
    assert.match(markdown, /## Goals\n\n- Ship a feature/);
    assert.match(markdown, /AC\\-1: CLI produces the required output/);
    assert.match(markdown, /AC\\-1: Run unit test/);
    await writeRequirements(origin, 'run-1', input);
    assert.equal(await readFile(result.refs.markdown, 'utf8'), markdown);
    assert.deepEqual((await readdir(join(origin, '.orch/state/runs/run-1'))).sort(), ['requirements.json', 'requirements.md']);
  } finally { await rm(origin, { recursive: true, force: true }); }
});
test('requirements reject unmapped criteria before creating artifacts', async () => {
  const origin = await realpath(await mkdtemp(join(tmpdir(), 'orch-requirements-')));
  try {
    await assert.rejects(writeRequirements(origin, 'run-1', { ...input, verification_plan: [{ acceptance_id: 'AC-2', method: 'unit' }] }));
    await assert.rejects(writeRequirements(origin, 'run-1', { ...input, transcript: 'raw conversation' }));
    assert.deepEqual(await readdir(origin), []);
  } finally { await rm(origin, { recursive: true, force: true }); }
});
test('project text remains inert in the readable requirements artifact', async () => {
  const origin = await realpath(await mkdtemp(join(tmpdir(), 'orch-requirements-')));
  try {
    const result = await writeRequirements(origin, 'run-1', { ...input, goals: ['<script>alert(1)</script>\n# fake heading\n[run](command:evil)'] });
    const markdown = await readFile(result.refs.markdown, 'utf8');
    assert.ok(!markdown.includes('<script>'));
    assert.ok(!markdown.includes('\n# fake'));
    assert.ok(!markdown.includes('[run](command:evil)'));
    assert.equal(result.requirements.goals[0], '<script>alert(1)</script>\n# fake heading\n[run](command:evil)');
  } finally { await rm(origin, { recursive: true, force: true }); }
});
