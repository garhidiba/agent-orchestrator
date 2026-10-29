# Changelog

## 0.1.0 — development

- Added Hermes Agent host settings, provider-neutral role policy, authenticated native delegation relay, user-profile MCP/skill installation, update/rollback/removal and diagnostics. Hermes uses workspace-aware MCP origin expansion; write dispatch requires interactive live controls and actual bootstrap receipts.

- Added deterministic protocol/config/state/Git/MCP foundations and fixture coverage.
- Added common ORCH entry skills, configuration advisor guidance and operational documentation.
- Native host capability adapters and both-host E2E release gates remain unverified; this is not a v1 completion announcement.
- Run creation now adds `/.orch/state/` to the local `.git/info/exclude` instead of failing, and checks cleanliness afterwards.
- Write-path overlap now proves disjointness for `dir/**` scopes and files, so such tasks run in parallel; other wildcards still serialize.
- Documented write-path, commit-unit, verification-id, trusted-hash and worker-bootstrap rules in the workflow reference.
- Bare directory `write_paths` now own everything beneath them, and `orch_task_commit` accepts optional `paths` to commit a subset of changed files per unit.
- Linked worktrees now default to `<project>/.orch/worktrees` (auto-added to the local `.git/info/exclude`); `ORCH_WORKTREE_ROOT` overrides, and outside a Git repository the per-user location is kept. In-repository roots other than `.orch/worktrees` are still rejected.
- Run creation sweeps worktrees and local `orch/*` branches of earlier runs once they are clean and fully merged into the target (unmerged or dirty work is preserved, `ORCH_WORKTREE_SWEEP=0` disables) and records a `worktree_sweep` event.
