import { basename } from 'node:path';
import { git, gitBlobMatches } from '../git/repository.ts';

// shortcut: detects known plaintext credential forms, extend when a new provider format is supported.
const credential = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{20,255}\b|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,255}\b|\bxox[baprs]-[A-Za-z0-9-]{20,255}\b/;
const assignment = /["']?\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|client[_-]?secret|private[_-]?key|secret[_-]?access[_-]?key)["']?(?:\s*:\s*string)?\s*[:=]\s*(?:(["'])([^"'\r\n]{8,1024})\1|([^\s,;"']{8,1024}))/gi;
const placeholder = /^(?:your[-_ ].*|replace[-_ ]?me|example|placeholder|changeme|test[-_]?(?:token|key|secret|password)|dummy|fake|\*+|x+|\[REDACTED\]|\$\{[^}]+\}|process\.env\.[A-Z_]+|os\.environ.*)$/i;

function containsSecret(text: string) {
  if (credential.test(text)) return true;
  for (const match of text.matchAll(assignment)) {
    const value = match[2] ?? match[3];
    // Unquoted source expressions are not credential literals; config assignments still are.
    const prefix = text.slice(text.lastIndexOf('\n', match.index) + 1, match.index);
    if (/^\s*(?:export\s+)?(?:declare\s+)?type\s+$/.test(prefix)) continue;
    if (!placeholder.test(value) && (match[1] || /^(?:[ \t]*|[ \t]*export )$/.test(prefix) && /^[A-Za-z0-9_+/=-]+$/.test(value))) return true;
  }
  return false;
}

export async function assertNoStagedSecrets(cwd: string) {
  try {
    const paths = new Set((await git(cwd, 'diff', '--cached', '--name-only', '--no-renames', '--diff-filter=ACMRT', '-z')).split('\0').filter(Boolean));
    for (const record of (await git(cwd, 'ls-files', '--stage', '-z')).split('\0').filter(Boolean)) {
      const entry = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(record);
      if (!entry || entry[3] !== '0') throw new Error('STAGED_SECRET_SCAN_FAILED');
      const path = entry[4];
      if (!paths.has(path)) continue;
      const name = basename(path);
      if ((/^\.env(?:\..+)?$/i.test(name) && !/^\.env\.(?:example|sample|template)$/i.test(name)) || /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|.*\.(?:p12|pfx))$/i.test(name)
        || await gitBlobMatches(cwd, entry[2], containsSecret)) throw new Error('STAGED_SECRET_DETECTED');
    }
  } catch (error) {
    // Git failures can carry blob data; callers receive only a stable, content-free code.
    throw new Error(error instanceof Error && error.message === 'STAGED_SECRET_DETECTED' ? error.message : 'STAGED_SECRET_SCAN_FAILED');
  }
}
