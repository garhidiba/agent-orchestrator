import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { configSchema } from '../../packages/protocol/src/config.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const names = ['agent-orch', 'agent-orch-configure'];
const links = (text: string) => [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
  .map(match => match[1]).filter(path => !/^[a-z]+:/i.test(path)).map(path => path.split('#')[0]).filter(Boolean);

test('shared skill sources form self-contained installed skills for both hosts', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'orch-skills-'));
  try {
    for (const host of ['codex', 'claude']) {
      for (const name of names) {
        const source = join(root, 'skills', name), installed = join(temp, host, 'skills', name);
        await cp(source, installed, { recursive: true });
        await cp(join(root, 'references'), join(installed, 'references'), { recursive: true });
        const entry = await readFile(join(installed, 'SKILL.md'), 'utf8');
        const frontmatter = parse(entry.split('---')[1]);
        assert.equal(frontmatter.name, name);
        assert.equal(typeof frontmatter.description, 'string');
        assert.equal(frontmatter.context, undefined, 'main coordinator must remain in parent session');
        const referenceFiles = (await readdir(join(installed, 'references'))).map(file => join(installed, 'references', file));
        for (const file of [join(installed, 'SKILL.md'), ...referenceFiles]) {
          for (const target of links(await readFile(file, 'utf8'))) {
            const resolved = resolve(dirname(file), target);
            assert.ok(resolved.startsWith(`${installed}${sep}`), `reference escapes installed skill: ${target}`);
            assert.ok((await stat(resolved)).isFile(), `missing installed reference: ${target}`);
          }
        }
        for (const file of referenceFiles) {
          assert.equal(await readFile(file, 'utf8'), await readFile(join(root, 'references', basename(file)), 'utf8'));
        }
      }
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('user documentation local links resolve to shipped files', async () => {
  const docs = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md',
    'docs/installation.md', 'docs/architecture.md', 'docs/compatibility.md', 'docs/acceptance.md',
    'docs/implementation-status.md', 'docs/prd-completion.md'];
  for (const relative of docs) {
    const file = join(root, relative);
    for (const target of links(await readFile(file, 'utf8'))) {
      assert.ok((await stat(resolve(dirname(file), target))).isFile(), `${relative}: ${target}`);
    }
  }
});

test('shipped role guidance covers the configured role contract', async () => {
  const config = configSchema.parse(parse(await readFile(join(root, 'templates/defaults/config.yaml'), 'utf8')));
  const roles = await readFile(join(root, 'references/agent-roles.md'), 'utf8');
  const documented = [...roles.matchAll(/^\| ([a-z_]+) \|/gm)].map(match => match[1]);
  assert.deepEqual(documented.sort(), Object.keys(config.hosts.codex.roles).sort());
  assert.deepEqual(Object.keys(config.hosts.codex.roles).sort(), Object.keys(config.hosts.claude.roles).sort());
});

test('bilingual evaluation set covers write, read-only, unrelated and blocked requests', async () => {
  const cases = JSON.parse(await readFile(join(root, 'skills/evaluations.json'), 'utf8')) as {
    id: string; prompt: string; expectedSkill: string | null; scope: string | null; effect: string; shouldTrigger: boolean;
  }[];
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  for (const language of ['ko', 'en']) {
    const set = cases.filter(item => item.id.startsWith(`${language}-`));
    for (const branch of ['auto', 'pin', 'global', 'project', 'explain', 'other', 'status', 'unsafe']) {
      assert.ok(set.find(item => item.id === `${language}-${branch}`));
    }
    assert.ok(set.some(item => !item.shouldTrigger && item.expectedSkill === null));
    assert.ok(set.some(item => item.effect === 'blocked'));
    assert.ok(set.some(item => item.effect === 'read' && item.scope === null));
    assert.ok(set.some(item => item.effect === 'write' && item.scope === 'global'));
    for (const item of set) {
      assert.ok(item.prompt.length > 0);
      assert.ok(item.expectedSkill === null || names.includes(item.expectedSkill));
    }
  }
});
