import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../../packages/core/src/runtime/engine.ts';
import { resolveConfig } from '../../packages/core/src/config/index.ts';
import { hash } from '../../packages/core/src/state/store.ts';
import type { Plan } from '../../packages/protocol/src/runtime.ts';
import { git } from '../../packages/core/src/git/repository.ts';

export async function runtimeFixture(native = true, overrides: unknown = {}, parent = tmpdir(), createOptions: Parameters<Engine['create']>[5] = {}) {
  const dir = await mkdtemp(join(parent, 'orch-engine-')), root = join(dir, 'repo');
  let engine: Engine | undefined;
  try {
  await mkdir(root); await git(root, 'init'); await git(root, 'config', 'user.name', 'ORCH Test'); await git(root, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(root, '.gitignore'), '.orch/state/\n'); await writeFile(join(root, 'base'), 'base');
  await git(root, 'add', '.gitignore', 'base'); await git(root, 'commit', '-m', 'base');
  const config = resolveConfig({ project: { quality: { commands: [{ id: 'unit', executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', stages: ['baseline', 'task', 'integration', 'final'], required: true, timeout_seconds: 5 }] } }, session: overrides }).config;
  await mkdir(join(root, '.orch'));
  await writeFile(join(root, '.orch/config.yaml'), JSON.stringify(config));
  await git(root, 'add', '.orch/config.yaml'); await git(root, 'commit', '-m', 'fixture configuration');
  engine = new Engine(join(root, '.orch/state/state.db'), native ? { host: 'codex', model: 'fixture-model', effort: 'high', evidence: ['test-fixture'], verified: true, contextMatches: true } : null);
  const created = await engine.create(root, config, 'codex', join(dir, 'managed'), hash(config.quality.commands), createOptions);
  const active = engine;
  let op = 0;
  const change = (input: object, fn: Parameters<Engine['change']>[4]) => active.change(created.runId, `op-${++op}`, active.status(created.runId).version, input, fn);
  const plan: Plan = { acceptance: [{ id: 'AC-1', text: 'feature works' }], tasks: ['T1', 'T2'].map(task => ({ id: task, title: task, role: 'coder', depends_on: [], acceptance_ids: ['AC-1'], read_paths: [], write_paths: [`${task}.txt`], exclusive_resources: [], risk: 'low', complexity: 'low', verification_ids: ['unit'], commit_units: [{ id: 'U1', purpose: `implement ${task}` }] })) };
  await change({ action: 'requirements' }, run => active.submitRequirements(run, { schema_version: 1, goals: ['feature works'], in_scope: ['fixture feature'], out_of_scope: [], acceptance: plan.acceptance, constraints: [], assumptions: [], risks: [], verification_plan: [{ acceptance_id: 'AC-1', method: 'unit gate and independent review' }] }));
  return { dir, root, engine: active, created, change, plan, backend: native ? 'fixture_native' : 'unverified', async close() { active.store.close(); await rm(dir, { recursive: true, force: true }); } };
  } catch (error) { engine?.store.close(); await rm(dir, { recursive: true, force: true }); throw error; }
}
