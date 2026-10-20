# ORCH

ORCH is a local coordination runtime for work started inside an existing Codex or Claude Code conversation. The current session stays in charge; MCP manages configuration, task state, Git worktrees, checks, reviews and recovery.

**Development implementation, not a completed v1 release.** Installation readies the MCP; the current conversation connects its native Agent tool automatically before running workers. Defaults inherit host model/effort; unverified concrete pins remain blocked. Deterministic tests alone do not prove native host execution. See [compatibility](docs/compatibility.md) and [acceptance evidence](docs/acceptance.md).

## Install

Requires **Node.js 24+** (with npm), Git, and Codex CLI or Claude Code. From this checkout, run one command:

```sh
./scripts/install.sh
```

The installer handles missing npm dependencies, local packaging, checksums and installation for all detected hosts. It preserves unrelated settings and refuses user-owned skill/MCP conflicts. Run the same command again to update; unchanged sources reuse the installed version. No manual bundle or checksum is needed.

For a fresh checkout:

```sh
git clone https://github.com/garhidiba/agent-orchestrator.git
cd agent-orchestrator
./scripts/install.sh
```

On Windows PowerShell, run `./scripts/install.ps1` instead. Installation registers the `orch` MCP server and copies `orch` / `orch-configure` into each host's skills directory. Restart/reload the host afterward.

Optional: `./scripts/install.sh --target codex` selects just Codex (`claude` selects Claude Code); `--dry-run` previews host changes. Project-only installation uses `--scope project --project /absolute/path/to/git-root`. Dependency setup can still write local `node_modules` during a preview. See [installation](docs/installation.md) for paths, advanced verified-bundle options and removal.

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

### Copyable prompts

Use these in the host conversation, not in a terminal. In Claude Code, replace `$orch` / `$orch-configure` with `/orch` / `/orch-configure`.

First inspect the project and current settings:

```text
$orch 현재 프로젝트의 환경, MCP 연결과 실행 가능 상태를 확인해줘. 파일은 변경하지 마.
$orch-configure 현재 프로필과 역할별 모델·추론 설정을 설명해줘. 설정은 바꾸지 마.
```

To change configuration, request a preview first and approve the concrete proposal in the next message:

```text
$orch-configure 이 프로젝트를 quality 프로필로 바꾸는 변경안을 보여줘. 기존에 고정한 모델은 유지하고 아직 적용하지 마.
```

```text
$orch-configure 방금 확인한 변경안을 이 프로젝트에만 적용해줘. 전역 설정과 기존 모델 고정값은 유지해줘.
```

For an existing run, substitute its actual ID:

```text
$orch run-<ID>의 진행 상태, 차단 이유와 보고서를 보여줘.
```

A work request should include a concrete result and verification command. For example:

```text
$orch 이 저장소의 설정 조회 CLI에 --help 예제를 추가해줘. 기존 출력은 유지하고 npm run check로 검증해줘. 먼저 실행 가능 상태를 확인하고 지원되지 않으면 중단해.
```

On an execution request, `$orch` first connects this conversation’s native Agent tool with a read-only probe, then prepares worktrees and binds workers before edits. You do not need to start a separate app-server daemon or run a manual connection command.

**Readiness:** `installation=READY` means MCP is ready; `NEEDS_HOST_HANDSHAKE` asks the skill to connect the current native Agent tool, then `nativeDispatch=READY` permits dispatch. Missing tools, wrong Git identity, expired challenges or unsupported concrete model/effort pins still block execution. Actual model/access observations remain separate from parent-relayed native receipts; see [compatibility](docs/compatibility.md).

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
  ├─ host-native Agents (parent relay + checked worktree bootstrap)
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
