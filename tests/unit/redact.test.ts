import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../../packages/core/src/quality/redact.ts';

test('bounded gate logs redact environment secrets and common credential formats', () => {
  const output = redact('normal output\nenv-secret\nAuthorization: Bearer abc.def\ntoken=inline-value\n-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----', { TEST_TOKEN: 'env-secret' });
  assert.match(output, /normal output/);
  for (const secret of ['env-secret', 'abc.def', 'inline-value', '\nprivate\n']) assert.equal(output.includes(secret), false);
});
