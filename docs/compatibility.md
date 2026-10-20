# Compatibility and release gates

Status date: 2026-10-20. Package version 0.1.0 is a development implementation. PRD v1 completion requires real native E2E on both hosts; it has not been established.

| Surface | Evidence | Status |
|---|---|---|
| Node + Git deterministic runtime | Repository unit/contract tests with disposable Git repositories | Implemented fixture path; see test results from the current checkout |
| Codex metadata | Development observation: model/list returned 9 entries; contextMatches=false and access unknown | Partial; no same-context execution proof |
| Claude metadata | Host metadata adapter and fixtures | Partial; no complete current-session discovery proof |
| Codex native Agents | Current-conversation native relay, actual worker/bootstrap/content gate/independent review/finalize/cleanup smoke on macOS; inherited model/effort remain unobserved | Single-task native smoke passed; concrete pins require separately verified support |
| Claude native Agents | Same authenticated parent-relay protocol implemented; MCP installation/connection tested, actual Claude Agent run not exercised | Native E2E not verified |
| macOS source tooling | Current development environment | Not a native-host E2E certification |
| Linux | No recorded native/installation release run | Not verified |
| Windows native / PowerShell | Platform paths/wrappers require actual OS run | Not verified |
| WSL | Separate environment; no recorded release run | Not verified |

The current-host relay needs no app-server daemon. Installation reports READY; execution starts after the skill automatically relays an actual native probe through orch_host_connect. This is an authenticated coordinator attestation, not a signed host/account identity. Each worker must report its actual Git bootstrap before binding; concrete unsupported model/effort selections remain blocked.

The metadata observation is a dated development snapshot, not a promise about the user's account or installed host version. No minimum Codex/Claude version is certified. A successful `--version`, advertised model, mocked Agent or parser test does not establish account access, applied effort, worktree binding, stop/reload behavior or installed-host discovery.

Release gate: demonstrate catalog → selection → native worker → observed model/effort (or explicit unknown), verified exact worktree/base, stop/cancel/recovery and full task completion in each supported host. Record OS/runtime/host versions and real installation/update/removal results. Keep contract, deterministic fixtures and actual host evidence separate.
