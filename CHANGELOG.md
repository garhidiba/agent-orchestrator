# Changelog

## 0.1.0 — development

- Added deterministic protocol/config/state/Git/MCP foundations and fixture coverage.
- Added common ORCH entry skills, configuration advisor guidance and operational documentation.
- Native host capability adapters and both-host E2E release gates remain unverified; this is not a v1 completion announcement.
- Run creation now adds `/.orch/state/` to the local `.git/info/exclude` instead of failing, and checks cleanliness afterwards.
- Write-path overlap now proves disjointness for `dir/**` scopes and files, so such tasks run in parallel; other wildcards still serialize.
- Documented write-path, commit-unit, verification-id, trusted-hash and worker-bootstrap rules in the workflow reference.
- Bare directory `write_paths` now own everything beneath them, and `orch_task_commit` accepts optional `paths` to commit a subset of changed files per unit.
