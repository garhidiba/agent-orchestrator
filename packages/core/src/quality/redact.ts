// Redaction is auxiliary; collect only bounded gate output, never credentials or transcripts.
export function redact(text: string, env: NodeJS.ProcessEnv = process.env) {
  let result = text;
  for (const [key, value] of Object.entries(env)) {
    if (value && /(token|key|secret|pass|cookie|authorization|credential)/i.test(key)) result = result.split(value).join('[REDACTED]');
  }
  return result.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .replace(/\b(api[_-]?key|token|password|secret)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]');
}
