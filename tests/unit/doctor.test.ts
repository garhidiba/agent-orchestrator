import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectHost } from '../../packages/installer/src/detection/host.ts';

test('doctor detects the executable without claiming native capabilities', async () => {
  const result = await detectHost('codex', process.execPath);
  assert.equal(result.status, 'detected');
  assert.match(result.version!, /^v\d+/);
  assert.equal(result.host, 'codex');
  assert.equal(result.capabilities.perAgentModel, 'unknown');
  assert.equal(result.executionReady, false);
});

test('doctor distinguishes missing executable from a working installation', async () => {
  const result = await detectHost('claude', join(tmpdir(), 'orch-nonexistent', 'claude'));
  assert.equal(result.status, 'not_found');
  assert.equal(result.version, null);
  assert.equal(result.executionReady, false);
});

test('doctor bounds a stalled metadata process and omits raw stderr', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-doctor-'));
  try {
    const file = join(dir, 'stalled-host');
    await writeFile(file, '#!/bin/sh\nprintf "private-token" >&2\nwhile :; do :; done\n', { mode: 0o700 });
    const result = await detectHost('codex', file, 100);
    assert.equal(result.status, 'timed_out');
    assert.equal(JSON.stringify(result).includes('private-token'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('doctor does not promote failing or empty metadata to detected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-doctor-'));
  try {
    const file = join(dir, 'failed-host');
    await writeFile(file, '#!/bin/sh\nexit 2\n', { mode: 0o700 });
    assert.equal((await detectHost('claude', file)).status, 'failed');
    await writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    assert.equal((await detectHost('claude', file)).status, 'failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
