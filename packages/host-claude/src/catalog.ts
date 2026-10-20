// CLI installation alone does not expose a catalog in the current native session.
export function discoverClaudeModels() {
  return { status: 'partial', models: [], contextMatches: false, reason: 'NATIVE_MODEL_METADATA_UNAVAILABLE' } as const;
}
