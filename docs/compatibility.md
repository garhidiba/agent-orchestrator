# Compatibility and release gates

The [completion audit tracker](prd-completion.md) records the current run's findings and evidence. Results below describe their stated baseline; implementation checkpoints do not establish actual host or OS acceptance.

Status date: 2026-10-20. Package version 0.1.0 is a development implementation. PRD v1 completion requires real native E2E on both hosts; it has not been established.

The user's real Claude full-version/effort and managed-worktree dependency failures have [scoped correction evidence](prd-completion.md#runtime-readiness-correction-evidence). The corrected Node reuse path completed its original command with two actual Codex workers. Claude generated-definition syntax and deterministic dispatch contracts passed, but actual Claude named invocation/reload acceptance remains open. Installation results do not close that host gate.

| Surface | Evidence | Status |
|---|---|---|
| Node + Git deterministic runtime | Repository unit/contract tests with disposable Git repositories | Implemented fixture path; see test results from the current checkout |
| Codex metadata | Paginated metadata plus authenticated parent native-context path; retain provider/source evidence and unknown access | Actual current role-selection evidence must be recorded separately |
| Claude metadata | Supported current-context metadata adapter and parent relay; metadata lookup performs no inference | Actual current-session discovery/native E2E not established by fixtures |
| Codex native Agents | Dated inherited worker/bootstrap/content/review/finalize/cleanup smoke on macOS; new per-role native arguments and read-only review receipts require current acceptance evidence | Prior single-task smoke passed; new role model/effort execution remains unverified until observed |
| Claude native Agents | Authenticated parent relay plus project/policy-specific generated definitions, loaded receipts and pre-bind hash checks; actual CLI parser accepts exact versions/high | Actual named Agent invocation and reload E2E not verified |
| Node managed-worktree dependencies | Manifest/lock/config-matched existing dependency reuse; original skills command passed in two actual Codex task worktrees and integration | Shared directory is writable, not OS isolation. Workspace/local/external links and non-Node bootstrap need separate trusted setup. |
| macOS source tooling | Current development environment | Not a native-host E2E certification |
| Linux | No recorded native/installation release run | Not verified |
| Windows native / PowerShell | Platform paths/wrappers require actual OS run | Not verified |
| WSL | Separate environment; no recorded release run | Not verified |

The current-host relay needs no app-server daemon. Installation reports READY; execution starts after the skill automatically relays an actual native probe through orch_host_connect. This is an authenticated coordinator attestation, not a signed host/account identity. Each worker must report its actual Git bootstrap before binding; concrete unsupported model/effort selections remain blocked.

The metadata observation is a dated development snapshot, not a promise about the user's account or installed host version. No minimum Codex/Claude version is certified. A successful `--version`, advertised model, mocked Agent or parser test does not establish account access, applied effort, worktree binding, stop/reload behavior or installed-host discovery.

Release gate: demonstrate catalog → selection → native worker → observed model/effort (or explicit unknown), verified exact worktree/base, stop/cancel/recovery and full task completion in each supported host. Record OS/runtime/host versions and real installation/update/removal results. Keep contract, deterministic fixtures and actual host evidence separate.

## Retained runtime state compatibility

Snapshot storage is additive and preserves metadata version 2 so retained v2 runtime bundles can reopen their pinned runs. Compatibility fix `0657022` normalizes only the known introduced version-3 layout after exact structural validation; unknown or future layouts are rejected before writes. This does not migrate an active run to a newer runtime.

A disposable archived-baseline proof used actual Engine source from `4a9219290f770bb99988c7f68f928a82cbe03fc6`: create v2 run → read status and add a snapshot using the new Store while retaining v2 metadata → reject a new-runtime mutation with `RUNTIME_VERSION_PINNED` → reopen with the old Engine → pause/resume → confirm the new snapshot remains. The proof exited successfully; the state-focused checks passed 11/11 with typecheck/diff checks. This establishes the exercised local database/runtime compatibility path, not native-host or OS acceptance.
