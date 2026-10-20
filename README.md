# ORCH

ORCH is a local coordination runtime for work started inside an existing Codex or Claude Code conversation. The current session stays in charge; MCP manages configuration, task state, Git worktrees, checks, reviews and recovery.

**Development implementation, not a completed v1 release.** Production native dispatch currently stops at `BLOCKED_CAPABILITY`. Deterministic engine tests do not prove native host execution. See [compatibility](docs/compatibility.md) and [acceptance evidence](docs/acceptance.md).

## Start from source

Requires Node.js 24+ and Git. From this checkout:

```sh
npm ci
npm run orch -- --help
npm run orch -- config --effective
npm run orch:manage -- --help
npm run orch -- doctor --host codex
npm run check
```

Doctor checks the selected installed host; it does not authorize login, billing or worker execution. Use `--host claude` for Claude Code. [Installation and removal](docs/installation.md) describe local bundles and preservation rules.

Installed entry points are `$orch` / `$orch-configure` in Codex and `/orch` / `/orch-configure` in Claude Code when discovery is available. Ask for “ORCH status”, “resume this ORCH run”, or “optimize ORCH for this project”. Settings explanations are read-only; execution still requires verified host capability.

The developer CLI also exposes config set/unset, model metadata refresh, role pins and profile configuration. Use `--dry-run` on supported writes. [Configuration](references/configuration.md) explains limits; CLI `configure` currently preserves role pins and changes the profile, rather than claiming measured optimal model selection.

## How it fits

```text
Current Codex or Claude conversation (coordinator)
  ├─ host-native Agents (requires verified adapter; currently blocked)
  └─ local ORCH MCP
       ├─ configuration + model metadata
       ├─ SQLite state + operation journal
       └─ Git worktrees + gates + review ledger + cleanup
```

The core is deterministic; it does not launch an alternative AI controller. It preserves unknown model/access/usage information and user-owned changes. Worktrees isolate file changes, not OS permissions.

## Guides

- [Configuration](references/configuration.md), [model selection](references/model-selection.md), [effort](references/reasoning-effort.md)
- [Roles](references/agent-roles.md), [project analysis](references/project-analysis.md), [workflow](references/workflow.md)
- [Recovery](references/recovery.md), [security](SECURITY.md), [contributing](CONTRIBUTING.md), [changelog](CHANGELOG.md)
- [Architecture](docs/architecture.md), [compatibility](docs/compatibility.md), [PRD](docs/orch-agent-orchestrator-prd.md), [implementation log](docs/implementation-status.md)

The README's compact introduction and command-first layout adapt the structure of [Size Limit](https://github.com/ai/size-limit#readme); ORCH's behavior and limits are specific to this repository.
