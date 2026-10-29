# Hermes integration

ORCH runs inside the current NousResearch Hermes Agent conversation. Install with `./scripts/install.sh --target hermes`, restart Hermes in the client Git project, and use `/agent-orch init` or `/agent-orch-configure`. The installer supports the default user profile only (`~/.hermes/config.yaml`, `~/.hermes/skills/`). Project-only installations and custom `HERMES_HOME` profiles are rejected explicitly; user-scope `auto` skips a custom Hermes profile and project-scope `auto` detects only Codex/Claude.

Hermes expands `${workspaceFolder}` in the installed MCP `--origin` argument. Its stdio server can start from HOME, so `--origin .` is insufficient. Check `orch_environment.originRoot` against the physical client Git root before writes. A workspace change requires reconnecting the MCP and checking origin again. Hermes gateway startup can resolve that variable before a chat workspace exists; use the connection below when origin is null. This integration requires a Hermes version supporting that expansion; v0.22.5 was exercised.

## Project connection after gateway startup

If `orch_environment.originRoot` is null, obtain the user's physical Git top level with the parent terminal. Read `coordinatorTokenRef` privately and call `orch_project_connect` with `coordinator_token` and that exact absolute `origin_root`. Reread `orch_environment` and require an exact root match before initialization/configuration or execution. This authorizes only a process-local root connection: it creates no project files, state database, run or worker, and does not edit Hermes configuration. No additional approval is needed for this connection within an authorized init/configuration/execution request.

The server permits this only for Hermes, once, while its origin is null and no engine or native connection exists. It rejects a nonphysical/non-Git root and rotates the native challenge. A non-null mismatched origin must be reconnected from the intended workspace; it cannot be overwritten by this tool. A late connection retains the startup's per-user worktree location. Independent projects need independent MCP connections. Older ORCH bundles reject the new `hosts.hermes` configuration key; finish runs pinned to those bundles before materializing Hermes settings in the same project.

## Native connection and delegation

Follow [native connection](workflow.md#native-connection), using the actual `delegate_task` tool and `native_tool: delegate_task`. Pass the read-only probe as `tasks: [{goal, context}]`; each child has fresh context, so include the challenge and absolute project path. Obtain the child's real host identity from the native receipt, never from its prose. Keep coordinator tokens in the parent.

Before creating a write run, inspect the actual current-session `delegate_task` schema. Writing needs background delegation with `action: list`, `steer` and `stop`, a real child ID, and observable bootstrap output while the same child is alive. Hermes one-shot/synchronous delegation omits live controls: it can perform initialization and read-only probes, but cannot satisfy ORCH's two-phase write bootstrap. Keep writing blocked in that mode; a finished probe cannot become a new writing agent under the old identity.

For an interactive writing task:

1. Prepare through `orch_task_prepare`. Send its complete dispatch, absolute worktree, ownership and resource environment in the child's `context`. Require a read-only first phase: change its terminal to that exact worktree, report physical cwd, Git root, absolute common dir, branch and HEAD, then stay alive with bounded foreground waits until the parent explicitly confirms bind. The child must make no project edits or commits before that confirmation.
2. Read the live child's bootstrap from the native transcript identified by `delegate_task(action="list")`; use the returned `subagent_id` for ORCH's `native_id`. Relay the actual bootstrap with `orch_task_bind`. If the child exits, its identity changes, the receipt is unavailable or binding fails, stop and preserve the attempt.
3. Only after bind succeeds, send `delegate_task(action="steer", subagent_id=<same ID>, message=<bind confirmation and handoff>)`. Recheck Git identity in subsequent write commands. Relay fresh `list` receipts for heartbeats; fixed attempt deadlines still apply. Stop through `action="stop"`, then confirm actual completion before retry, submission or cleanup. A stop request alone is not stop evidence.
4. Follow the normal task/validation/commit/integration flow. Reviewers and final auditors are separate read-only child identities bound to the exact review SHA. Hermes inherits tool access: role wording is not an OS or tool-permission sandbox. Check source changes as required by ORCH.

Hermes's optional automatic worktree isolation creates a different worktree. ORCH owns the assigned worktree; verify the observed bootstrap exactly and stop on a mismatch. Use local terminal execution against the same filesystem as MCP. Remote/container paths are not interchangeable with the host paths.

## Models and effort

Hermes supports multiple providers. Descriptors must identify `host: hermes`; Codex/Claude catalogs cannot supply Hermes access evidence. Metadata unavailable from a read-only CLI query remains `NATIVE_MODEL_METADATA_UNAVAILABLE`, with an empty catalog. Obtain evidenced metadata from the active session for explicit pins through the authenticated relay.

All shipped Hermes roles inherit the native delegation policy. Hermes's `delegation.model`/provider/reasoning settings can override its parent chat model; report the child's effective policy only when evidenced, otherwise keep model/effort null. The parent chat model is not proof of the child model. The default `delegate_task` task schema has no per-child model/effort override. Preserve `perInvocationModel=false` and `perInvocationEffort=false` unless the actual active schema exposes those parameters; unsupported pins remain blocked. When supported, pass the prepared `nativeArguments` into the individual task entry, alongside `goal` and `context`. Do not edit global Hermes settings to implement an ORCH role pin.

Official contracts: [MCP configuration](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference), [delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation), [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills).
