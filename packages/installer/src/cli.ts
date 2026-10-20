import { parseArgs } from 'node:util';
import { detectHost } from './detection/host.ts';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { host: { type: 'string' }, help: { type: 'boolean' } },
  });
  if (values.help || positionals.length === 0) {
    console.log('ORCH development diagnostics\nUsage: npm run orch -- doctor --host <codex|claude>');
  } else if (positionals.length === 1 && positionals[0] === 'doctor' &&
      (values.host === 'codex' || values.host === 'claude')) {
    const result = await detectHost(values.host);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'detected') process.exitCode = 1;
  } else {
    throw new Error('Usage: npm run orch -- doctor --host <codex|claude>');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'ORCH command failed');
  process.exitCode = 1;
}
