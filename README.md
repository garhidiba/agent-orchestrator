# ORCH

ORCH is a local coordination runtime for work started inside an existing Codex or Claude Code conversation. The current session stays in charge; MCP manages configuration, task state, Git worktrees, checks, reviews and recovery.

**Development implementation, not a completed v1 release.** Production native dispatch currently stops at `BLOCKED_CAPABILITY`. Deterministic engine tests do not prove native host execution. See [compatibility](docs/compatibility.md) and [acceptance evidence](docs/acceptance.md).

## Install

Requires **Node.js 24+**, Git, and an installed Codex CLI or Claude Code. This development version is installed from a trusted local source bundle; no published npm package or remote release installer is available.

The following commands use a POSIX shell (macOS/Linux). Build a bundle outside the checkout, preview installation, then install for the current user:

```sh
git clone https://github.com/garhidiba/agent-orchestrator.git
cd agent-orchestrator
npm ci

ORCH_BUILD_DIR="$(mktemp -d)"
ORCH_VERSION="0.1.0-local.$(git rev-parse --short HEAD)"
node packages/installer/src/manage.ts pack \
  --source . --bundle "$ORCH_BUILD_DIR/bundle" --version "$ORCH_VERSION" \
  > "$ORCH_BUILD_DIR/pack.json"
ORCH_CHECKSUM="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).checksum)' "$ORCH_BUILD_DIR/pack.json")"

node packages/installer/src/manage.ts install \
  --bundle "$ORCH_BUILD_DIR/bundle" --checksum "$ORCH_CHECKSUM" \
  --target auto --scope user --dry-run
node packages/installer/src/manage.ts install \
  --bundle "$ORCH_BUILD_DIR/bundle" --checksum "$ORCH_CHECKSUM" \
  --target auto --scope user
```

`auto` installs for the detected hosts. Use `--target codex`, `--target claude`, or `--target both` to select explicitly. Existing unrelated settings are preserved; conflicting user-owned skills or MCP entries are rejected. The checksum verifies this trusted local build; it does not authenticate a downloaded bundle.

User installation copies the runtime to `${XDG_DATA_HOME:-~/.local/share}/orch/versions/` on macOS/Linux and registers:

| Host | Skills | MCP configuration |
|---|---|---|
| Codex | `~/.agents/skills/orch`, `~/.agents/skills/orch-configure` | `~/.codex/config.toml` |
| Claude Code | `~/.claude/skills/orch`, `~/.claude/skills/orch-configure` | `~/.claude.json` |

For a project-only installation, replace `--scope user` with `--scope project --project /absolute/path/to/git-root` in both install commands. Other platform paths, update/rollback and ownership details are in [installation](docs/installation.md). Each version directory is immutable: rebuild changed sources under a new version, then use `update` with the same bundle/checksum/scope options. The temporary build directory can be removed after installation; the installed runtime is a separate copy.

## Use in a conversation

1. Restart/reload the host after installation, then open the Git project you want ORCH to manage.
2. Check that the `orch` MCP server and both skills are discovered. In Codex, `codex mcp get orch` checks registration; `/mcp` inside the TUI shows active servers ([official MCP guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)). Registration alone does not prove a successful connection.
3. Invoke the appropriate entry point in the conversation:

| Goal | Codex prompt | Claude Code prompt |
|---|---|---|
| Inspect environment and capabilities | `$orch 현재 환경과 실행 가능 상태를 확인해줘` | `/orch 현재 환경과 실행 가능 상태를 확인해줘` |
| Explain current settings without changing them | `$orch-configure 현재 모델과 설정을 설명해줘. 변경하지 마` | `/orch-configure 현재 모델과 설정을 설명해줘. 변경하지 마` |
| Preview a project profile change | `$orch-configure 이 프로젝트를 quality 프로필로 바꾸는 변경안을 보여줘` | `/orch-configure 이 프로젝트를 quality 프로필로 바꾸는 변경안을 보여줘` |
| Read an existing run | `$orch run-<ID> 상태와 보고서를 보여줘` | `/orch run-<ID> 상태와 보고서를 보여줘` |

**Current execution limit:** the production native worker adapter is not implemented. Environment checks report `BLOCKED_CAPABILITY`; a start request must stop there. Settings inspection, supported configuration changes and MCP reads can be tested now, but a complete native multi-agent run cannot. Model availability/access and actual applied model/effort remain separate checks; see [compatibility](docs/compatibility.md).

## CLI and development checks

From the source checkout, these commands inspect settings and hosts. The role listing shows requested policy; metadata does not prove same-session model access.

```sh
npm run orch -- --help
npm run orch -- config --effective
npm run orch -- doctor --host codex
npm run orch -- doctor --host claude
npm run orch -- models --host codex
npm run orch -- models available --host codex
npm run orch -- configure --profile quality --dry-run
npm run check
```

Remove `--dry-run` only when you intend to apply that project configuration change. Explicit `--global` selects user settings; role pins are preserved by profile configuration. [Configuration](references/configuration.md) covers set/unset, field precedence, session overrides and model validation. No `orch run` command or global `orch` shell executable is installed; use the conversation skills or the source commands above.

To preview removal and then uninstall both host integrations from this source checkout:

```sh
npm run orch:manage -- uninstall --target both --scope user --dry-run
npm run orch:manage -- uninstall --target both --scope user --keep-data
```

Only owned, unmodified assets are removed. Run data, old runtime versions and unrelated settings are retained. Use the same project scope/path if installed for a project.

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
