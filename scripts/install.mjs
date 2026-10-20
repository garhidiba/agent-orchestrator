import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('ORCH requires Node.js 24 or newer.');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (Object.keys(pkg.dependencies ?? {}).some(name => !existsSync(join(source, 'node_modules', name, 'package.json')))) {
    console.error('Installing ORCH dependencies...');
    const { resolveExecutable, safeProcessEnvironment } = await import('../packages/core/src/process/executable.ts');
    const npm = process.platform === 'win32'
      ? { command: process.execPath, args: [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')], env: await safeProcessEnvironment(process.env, source) }
      : await resolveExecutable('npm', { cwd: source });
    execFileSync(npm.command, [...npm.args, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: source, env: npm.env, stdio: ['inherit', 2, 2],
    });
  }
  execFileSync(process.execPath, [join(source, 'packages/installer/src/manage.ts'), 'install', ...process.argv.slice(2)], { stdio: 'inherit' });
} catch (error) {
  if (typeof error.status !== 'number') console.error(error.message);
  process.exitCode = error.status || 1;
}
