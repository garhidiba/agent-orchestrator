# Compatibility and release gates

Status date: 2026-10-20. Package version 0.1.0 is a development implementation. PRD v1 completion requires real native E2E on both hosts; it has not been established.

| Surface | Evidence | Status |
|---|---|---|
| Node + Git deterministic runtime | Repository unit/contract tests with disposable Git repositories | Implemented fixture path; see test results from the current checkout |
| Codex metadata | Development observation: model/list returned 9 entries; contextMatches=false and access unknown | Partial; no same-context execution proof |
| Claude metadata | Host metadata adapter and fixtures | Partial; no complete current-session discovery proof |
| Codex native Agents | Read-only native-control probe; control socket unavailable in the development observation and current-session identity unproven; production adapter absent | BLOCKED_CAPABILITY |
| Claude native Agents | No production native execution adapter; current-session lifecycle/model/effort unproven | BLOCKED_CAPABILITY |
| macOS source tooling | Current development environment | Not a native-host E2E certification |
| Linux | No recorded native/installation release run | Not verified |
| Windows native / PowerShell | Platform paths/wrappers require actual OS run | Not verified |
| WSL | Separate environment; no recorded release run | Not verified |

The metadata observation is a dated development snapshot, not a promise about the user's account or installed host version. No minimum Codex/Claude version is certified. A successful `--version`, advertised model, mocked Agent or parser test does not establish account access, applied effort, worktree binding, stop/reload behavior or installed-host discovery.

Release gate: demonstrate catalog → selection → native worker → observed model/effort (or explicit unknown), verified exact worktree/base, stop/cancel/recovery and full task completion in each supported host. Record OS/runtime/host versions and real installation/update/removal results. Keep contract, deterministic fixtures and actual host evidence separate.
