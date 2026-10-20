import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { loadConfig } from '../../core/src/config/index.ts';
import { detectHost } from './detection/host.ts';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { host: { type: 'string' }, effective: { type: 'boolean' }, help: { type: 'boolean' } },
  });
  if (values.help || positionals.length === 0) {
    console.log('ORCH development tools\nUsage:\n  npm run orch -- doctor --host <codex|claude>\n  npm run orch -- config --effective');
  } else if (positionals.length === 1 && positionals[0] === 'doctor' && !values.effective &&
      (values.host === 'codex' || values.host === 'claude')) {
    const result = await detectHost(values.host);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'detected') process.exitCode = 1;
  } else if (positionals.length === 1 && positionals[0] === 'config' && values.effective && !values.host) {
    let root: string | null;
    try {
      const result = await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], { timeout: 5000, maxBuffer: 16 * 1024 });
      root = result.stdout.trim();
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      if (failure.code !== 128 || !failure.stderr?.includes('not a git repository')) throw new Error('GIT_INSPECTION_FAILED');
      root = null;
    }
    console.log(JSON.stringify(await loadConfig(root), null, 2));
  } else {
    throw new Error('Invalid command. Run npm run orch -- --help');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'ORCH command failed');
  process.exitCode = 1;
}
