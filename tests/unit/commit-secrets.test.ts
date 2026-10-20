import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeFixture } from '../fixtures/runtime.ts';
import { git } from '../../packages/core/src/git/repository.ts';

const credentialLine = (name: string, value: string) => `${name}=${JSON.stringify(value)}\n`;
const privateKey = (kind: string) => ['-----BEGIN ', kind, ' PRIVATE KEY-----\n'].join('');

test('task commit rejects staged secrets without creating a commit or exposing their value', async () => {
  const f = await runtimeFixture();
  try {
    f.plan.tasks = [f.plan.tasks[0]];
    f.plan.tasks[0].write_paths.push('.env', '.env.example', 'asset.bin');
    await f.change({ action: 'plan' }, run => f.engine.plan(run, f.plan, true));
    await f.change({ action: 'prepare' }, run => f.engine.prepare(run, 'T1'));
    const task = f.engine.status(f.created.runId).data.tasks.T1;
    await f.change({ action: 'bind' }, run => f.engine.bind(run, 'T1', task.lease, task.attempt, 'native-T1', 'fixture-model', 'high'));
    const before = await git(task.path, 'rev-parse', 'HEAD');
    await writeFile(join(task.path, 'T1.txt'), credentialLine('API_KEY', 'synthetic-credential-732019864'));
    await f.change({ action: 'validate' }, run => f.engine.validate(run, 'T1', task.lease, task.attempt));
    await assert.rejects(f.change({ action: 'commit' }, run => f.engine.commit(run, 'T1', task.lease, task.attempt, 'U1')), { message: 'STAGED_SECRET_DETECTED' });
    assert.equal(await git(task.path, 'rev-parse', 'HEAD'), before);
    assert.deepEqual(f.engine.status(f.created.runId).data.tasks.T1.units, {});
    const rejected = f.engine.store.operation(f.created.runId, 'op-6');
    assert.equal(rejected?.status, 'rejected');
    assert.deepEqual(JSON.parse(rejected?.result as string), { code: 'STAGED_SECRET_DETECTED' });
    for (const content of [
      ['const password', ': string = ', JSON.stringify('synthetic-credential-732019864'), ';\n'].join(''),
      ['export type Token', ' = ', JSON.stringify('identifier'), '; const ', credentialLine('token', 'synthetic-credential-732019864')].join(''),
      ['export type Token', ' = ', JSON.stringify('ghp_' + '7aB'.repeat(12)), ';\n'].join(''),
      privateKey('OPENSSH'),
      `const credential = "${'ghp_' + '7aB'.repeat(12)}";\n`,
      ['password', ': synthetic_credential_937102\n'].join(''),
      ['AWS_SECRET_ACCESS_KEY', '=synthetic_credential_937102\n'].join(''),
      Buffer.from(credentialLine('API_KEY', 'synthetic-credential-732019864'), 'utf16le'),
      Buffer.concat([Buffer.alloc(65530), Buffer.from(privateKey('RSA'))]),
    ]) {
      await writeFile(join(task.path, 'T1.txt'), content);
      await f.change({ action: 'validate-secret' }, run => f.engine.validate(run, 'T1', task.lease, task.attempt));
      await assert.rejects(f.change({ action: 'commit-secret' }, run => f.engine.commit(run, 'T1', task.lease, task.attempt, 'U1')), { message: 'STAGED_SECRET_DETECTED' });
      assert.equal(await git(task.path, 'rev-parse', 'HEAD'), before);
    }
    // A restored working file must not conceal the secret blob left in the index.
    await writeFile(join(task.path, 'base'), credentialLine('API_KEY', 'synthetic-index-credential-619283'));
    await git(task.path, 'add', 'base');
    await writeFile(join(task.path, 'base'), 'base');
    await writeFile(join(task.path, 'T1.txt'), 'feature complete\n');
    await f.change({ action: 'validate-index' }, run => f.engine.validate(run, 'T1', task.lease, task.attempt));
    await assert.rejects(f.change({ action: 'commit-index' }, run => f.engine.commit(run, 'T1', task.lease, task.attempt, 'U1')), { message: 'STAGED_SECRET_DETECTED' });
    assert.equal(await git(task.path, 'rev-parse', 'HEAD'), before);
    await git(task.path, 'reset', 'HEAD', '--', 'base');
    await writeFile(join(task.path, '.env'), 'configuration without a detectable token\n');
    await f.change({ action: 'validate-path' }, run => f.engine.validate(run, 'T1', task.lease, task.attempt));
    await assert.rejects(f.change({ action: 'commit-path' }, run => f.engine.commit(run, 'T1', task.lease, task.attempt, 'U1')), { message: 'STAGED_SECRET_DETECTED' });
    assert.equal(await git(task.path, 'rev-parse', 'HEAD'), before);
    await git(task.path, 'reset', 'HEAD', '--', '.env');
    await rm(join(task.path, '.env'));
    const logDir = join(f.root, '.orch/state/runs', f.created.runId, 'logs');
    for (const name of await readdir(logDir)) assert.equal((await readFile(join(logDir, name), 'utf8')).includes('synthetic-credential'), false);
    const aliases = ['export type Token', 'type Password', 'declare type Secret'].map(declaration => `${declaration} = 'identifier';`).join('\n');
    await writeFile(join(task.path, 'T1.txt'), `API_KEY="your-api-key"\nconst token = process.env.TOKEN;\n${aliases}\nfeature complete\n`);
    await writeFile(join(task.path, '.env.example'), 'API_KEY=your-api-key\n');
    await writeFile(join(task.path, 'asset.bin'), Buffer.alloc(5 * 1024 * 1024));
    await f.change({ action: 'validate-clean' }, run => f.engine.validate(run, 'T1', task.lease, task.attempt));
    const committed = await f.change({ action: 'commit-clean' }, run => f.engine.commit(run, 'T1', task.lease, task.attempt, 'U1'));
    assert.equal(await git(task.path, 'rev-parse', 'HEAD'), committed.result.sha);
    assert.notEqual(committed.result.sha, before);
  } finally { await f.close(); }
});
