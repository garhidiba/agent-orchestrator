import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../../packages/protocol/src/runtime.ts';
const task = (id: string, deps: string[] = []) => ({ id, title: id, role: 'coder', depends_on: deps, acceptance_ids: ['AC-1'], read_paths: [], write_paths: ['src/**'], exclusive_resources: [], risk: 'low', complexity: 'low', verification_ids: ['unit'], commit_units: [{ id: 'U1', purpose: 'feature' }] });
test('DAG rejects cycles, missing dependencies and acceptance gaps', () => {
  assert.equal(validatePlan({ acceptance: [{ id: 'AC-1', text: 'works' }], tasks: [task('T1'), task('T2', ['T1'])] }).tasks.length, 2);
  for (const tasks of [[task('T1', ['T1'])], [task('T1', ['missing'])], [task('T1', ['T2']), task('T2', ['T1'])], [task('T1'), task('T1')]]) {
    assert.throws(() => validatePlan({ acceptance: [{ id: 'AC-1', text: 'works' }], tasks }));
  }
  assert.throws(() => validatePlan({ acceptance: [{ id: 'AC-2', text: 'works' }], tasks: [task('T1')] }), /UNKNOWN_ACCEPTANCE/);
});
