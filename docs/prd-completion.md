# PRD completion audit tracking

Baseline: `4a9219290f770bb99988c7f68f928a82cbe03fc6` (2026-10-20). The [source PRD](orch-agent-orchestrator-prd.md) is frozen. This file tracks the completion run; it does not declare PRD completion, a passed release gate, or actual provider availability. Finding numbers follow the coordinator's confirmed source audit; M/R/L/D codes identify implementation ownership only. The source audit is static evidence, not an executed failing test.

## Reopened runtime failures — 2026-10-20

PRD completion is **not established**. Earlier conversational claims that testing was complete are withdrawn: the 166-test local pass and configuration readback did not establish the real Claude workflow. Use the [verification status glossary](project-glossary.md) for every new result. Preserve the failures below until their exact scenarios are rerun; a synthetic regression pass alone does not close host acceptance.

| Failure | PRD requirement | Direct evidence | Current acceptance state |
|---|---|---|---|
| Claude full version/effort cannot reach a worker | 17.2 generated definitions; AT-004, AT-014–015, AT-045; POC-02/05 | User's Claude `task-a` preparation stopped with `MODEL_NOT_SUPPORTED` for `claude-sonnet-5-5` / `claude-opus-5-5`, with Opus `high`. The relay had alias-only invocation metadata; saving documented configuration values did not supply the missing definition transport. | OPEN_RUNTIME_FAILURE; code correction in progress; exact real-Claude rerun NOT RUN. |
| Managed worktree lacks ignored dependencies | 11.4 trusted bootstrap/cache sharing; 13.1 baseline/task/integration gates | Original checkout's skills test passed; the managed task worktree could not import `yaml` because `node_modules` was absent. An original-checkout baseline does not prove task-worktree readiness. | OPEN_RUNTIME_FAILURE; code correction in progress; original caller scenario rerun pending. |

The earlier Codex marker smoke verified its scoped workflow only: a marker with a dependency-free assertion cannot establish dependency readiness for this repository's actual test command. Native invocation arguments and actual provider model/effort observations remain separate; unexposed observations are null.

**CODE_AND_LOCAL_CHECKS_PASSED** means the implementation passed the recorded full baseline and subsequent scoped local checks, with independent findings closed. It does not establish actual native model/effort application, Claude/other-OS acceptance, performance/provider results or v1 release completion. References to earlier results in [acceptance](acceptance.md) and [implementation status](implementation-status.md) remain dated historical evidence.

| Finding / slice | Owner | Acceptance condition | Evidence state |
|---|---|---|---|
| 1 / M1 Catalog-to-store provider identity | Models | Use real provider/config evidence without name-prefix inference; a supported advertised candidate can pass catalog-to-store validation. | CODE_AND_LOCAL_CHECKS_PASSED — E2 + model checkpoint |
| 2 / M2 Role model/effort dispatch | Models + coordinator | Resolve concrete per-role settings through authenticated native capabilities or verified generated definitions; next attempts receive changes while active attempts retain their revision. | REOPENED — real Claude full-version/effort failure above; E1/E2 remain historical contract evidence. |
| 3 / M2 Read-only review dispatch | Models + coordinator | Reviewer/final_auditor have independent read-only prepare/bind receipts containing revision and requested/resolved/observed values. | CODE_AND_LOCAL_CHECKS_PASSED — E1/E2 |
| 4 / M2 Actual observations | Models + coordinator | Record nonnull observations against unknown resolution and report clamp/mismatch separately from actual policy violations. | CODE_AND_LOCAL_CHECKS_PASSED — E1 + model checkpoint |
| 5 / M3 Advisor/profile application | Models + coordinator + docs | Close evidence-based recommendation → validated authorized apply → next-worker dispatch while preserving explicit pins; invent no ranking or pricing. | CODE_AND_LOCAL_CHECKS_PASSED — E2 + Advisor `1e70035` scope-pin fix (19 public tests PASS) |
| 6 / M4 Claude metadata and definitions | Models + delivery | Replace the empty metadata stub with a supported current-context path without paid inference; preserve separate invocation/definition/reload/access evidence and real-Claude E2E limits. | REOPENED — missing usable generated-definition path was not closed by the adapter/packaging fixtures; actual Claude workflow failed. |
| 7 / R1 Failed gate recovery | Recovery + coordinator | Bounded retry/repair can return from BLOCKED_TESTS through review/finalization without a waiver while preserving the first failure. | CODE_AND_LOCAL_CHECKS_PASSED — Recovery checkpoint; E2 schema |
| 8 / R2 Canonical completion oracle | Recovery | Engine finalization and report share conservative acceptance/gate/review rules; an acceptance limitation blocks target mutation while irrelevant notes remain distinct. | CODE_AND_LOCAL_CHECKS_PASSED — E1 + recovery checkpoint |
| 9 / R3 Target drift reintegration | Recovery + coordinator | Verify exact moved target SHA, reintegrate in the same run, invalidate stale gates/reviews and return to VERIFYING. | CODE_AND_LOCAL_CHECKS_PASSED — Recovery checkpoint; E2 schema |
| 10 / R4 Cleanup retry | Recovery | Retry owned branch deletion after prior worktree removal; inspect both resources and preserve unknown branches. | CODE_AND_LOCAL_CHECKS_PASSED — Recovery checkpoint |
| 11 / L1 Budget and liveness | Lifecycle + coordinator | Enforce active budget across mutation/gate phases; parent-confirmed fresh native liveness governs heartbeat/lease renewal; reconcile expiry to ORPHANED_UNKNOWN and preserve unknown resources. | CODE_AND_LOCAL_CHECKS_PASSED — E1/E2 + lifecycle checkpoint |
| 12 / R5 Finding disposition | Recovery + coordinator | ACCEPTED_RISK, NOT_A_BUG and DEFERRED record explicit approval and reason without silently removing blocking findings. | CODE_AND_LOCAL_CHECKS_PASSED — Recovery checkpoint; E2 schema |
| 13 / L2 Attempt resources | Lifecycle + coordinator | Allocate attempt-owned tmp/database/build/port resources without touching real .env/database; prepare trusted dependency reuse separately from mutable outputs. | PARTIAL — existing port/resource evidence retained; managed-worktree dependency readiness failed as recorded above. |
| 14 / L3 Snapshots and events | Lifecycle + coordinator | Preserve immutable resolved-config/catalog/host/selection and prior-attempt observations; export bounded semantic events and request/plan/artifacts without raw prompts/transcripts. | CODE_AND_LOCAL_CHECKS_PASSED — E1/E2 + lifecycle checkpoint |
| 15 / D1–D2 Distribution and diagnostics | Delivery | Ship Claude plugin/agents and namespaced/standalone entries sharing one state, composite read-only doctor, staged MCP/metadata install verification and reproducible source-independent local packaging. | CODE_AND_LOCAL_CHECKS_PASSED — Delivery + doctor `94d55bf` trust fix (9 dedicated tests + AT-047 PASS) |

## Evidence boundaries

- Deterministic tests, disposable installation/MCP checks, real native execution and provider/account availability are separate evidence classes.
- A previous inherited single-marker Codex smoke does not establish concrete per-role model/effort, Claude native execution, or this run's new behavior.
- Real Claude lifecycle, Linux, Windows native/PowerShell, WSL, actual account/provider access, published release and release signing remain **NOT VERIFIED** unless this run records direct evidence for that exact surface.
- `qa-verification` is disabled; its gate and exhaustive Matrix workflow are not invoked or claimed passed. Existing project checks and enabled independent verification remain required.
- Local code/check evidence and actual runtime acceptance remain separate. Documentation checkpoints through `34b10ce` passed `node --test tests/unit/skills.test.ts` (4/4) and `git diff --check`; both entry skills passed skill-creator `quick_validate.py` using an isolated temporary validator environment. These checks validate document links/packaging/frontmatter, not runtime behavior. Record exact source SHA, test command/result and evidence class when the owning implementation has been integrated and tested.

## Focused evidence and remaining verification

Evidence below was reported by the owning coordinator/workers; the docs worker inspected source contracts read-only and did not rerun production/host workflows. Synthetic parent receipts do not prove that different actual native models/efforts were invoked.

| Evidence | Source | Command/result | Scope |
|---|---|---|---|
| E1 | Engine `5a52636` | `node --test tests/unit/dispatch-policy.test.ts tests/unit/reporting.test.ts`: 12/12 PASS; `tsc --noEmit`: PASS | Synthetic native dispatch, review/lifecycle and report contracts |
| E2 | MCP `4ee67ce` | `node --test tests/unit/mcp.test.ts tests/unit/mcp-boundaries.test.ts tests/unit/protocol.test.ts`: 17/17 PASS; `tsc --noEmit`: PASS | Public MCP/schema paths, synthetic parent metadata and authenticated controls |
| Measured Advisor public checkpoint | `67f0fd7` | Worker reported 4/4 focused public tests PASS (including masked-pin subtests); typecheck/diff PASS | Synthetic evidence-backed quality/fast differences, native-only capability checks, exact measurement approval hash and apply-to-prepare; actual host comparison NOT RUN |
| Model checkpoint | `053a64b` | Worker reported 18 focused tests PASS | Model/provider/observation/recommendation helpers; actual differing-model invocation NOT RUN |
| Lifecycle checkpoint | `e7ad95d` | Worker reported 17 focused + 24 compatibility tests PASS | Budget/liveness/resources/snapshots/events; actual host stop/resume NOT RUN |
| Port checkpoint | `ee1c344` after `264aa4a` | `node --test tests/unit/attempt-port.test.ts tests/unit/resources.test.ts`: 7/7 PASS; typecheck/diff PASS | Real OS reservation socket, attempt env, restart unknown, foreign service preservation, stopped-clean resume/retry/cleanup; application service bind/stop still separately evidenced |
| Recovery checkpoint | `a9a11fb` | Worker reported 28 tests plus focused guard PASS | Retry/completion/reintegration/disposition/cleanup fixtures |
| Delivery checkpoint | `ed6be2e` | Worker reported focused checks and original one-command packaging test PASS (104.8s; existing 60s child timeout unchanged) | Disposable installation/plugin/source-independent local packaging; actual plugin load/other OS NOT RUN |

Independent-review remediations are implemented with focused evidence: Advisor `1e70035` preserves scope pins (19 public tests PASS), and doctor `94d55bf` requires trusted current executable/package identity before probing (9 dedicated tests plus AT-047 PASS). Doctor integrity-only results remain distinct from execution trust. The coordinator recorded the full check and independent remediation closure below; these local results are not actual-host or release acceptance.

Final schema comparison used integration `0892239` plus Engine `5a52636` and MCP review-stop follow-up `4ee67ce` / integrated `0a3cf17`. Source inspection confirmed `orch_doctor`, exact preview/recommendation hashes, review stop receipts, fixed heartbeat deadlines, immutable snapshots and review/attempt history reporting. Documentation checkpoints describe these contracts; the real host/OS/provider evidence boundary above remains unchanged.

Port follow-up `264aa4a` / integration `07a9210`: task preparation now calls the real loopback reservation path, exposes attempt `service` address and `ORCH_SERVICE_HOST` / `ORCH_SERVICE_PORT`, and authenticates status/release through `orch_attempt_port`. `release_for_claim` is unreserved and still requires actual service bind evidence; restart returns unknown ownership and disposal only releases owned reservation sockets. Real application service/native lifecycle evidence remains NOT RUN.

Advisor public follow-up `67f0fd7` accepts authenticated bounded assessments and binds raw measurements with the recommendation approval hash. It selects only authenticated same-context native candidates that support actual invocation arguments. These are parent-attested measured inputs with synthetic public-path tests, not built-in performance evaluations, actual host comparisons or price evidence. Port resume follow-up `ee1c344` releases old owned reservations only after confirmed stopped/never-started and clean resume; dirty or unconfirmed resume preserves them.

## Final compatibility follow-up

Store fix `0657022` retains additive snapshot storage under metadata v2. Only the known introduced v3 structure may normalize after exact validation; unknown/future structures fail before writes. A disposable proof using archived actual baseline `4a92192` Engine source passed old create → new read/snapshot with v2 retained → new-runtime pin rejection → old reopen/pause/resume → snapshot retained. State-focused tests passed 11/11 plus typecheck/diff checks. This is local compatibility evidence; the proof artifacts are run-owned evidence rather than shipped documents.

Advisor guard `27d078e` closes the explicit-model-pin / unsupported effort-invocation case; the coordinator reported 19 public tests PASS and independent review closure. An earlier full project pass reported 157/157 tests PASS in 330.95 seconds. Full `npm run check` on frozen source `6524ec5` then passed typecheck and 160/160 tests, with 0 failures/skips, in 331692.01275 ms. This full-suite result belongs to that source, not a later HEAD.

## Final source check boundary

Canonical-DDL guard `2f7d110` (root `9715b06`) was added after the `6524ec5` full pass. The independent reviewer closed the finding; the worker reported 13 state tests PASS and the archived-old-Engine compatibility proof retained the same evidence hash. Final source `03571b3` passed typecheck and the impact command below: 49/49 tests PASS, 0 failures/skips, 41333.549959 ms. Independent source review closed all findings and verified the archived-baseline proof against the current Store hash. No final-HEAD full-suite equivalence is claimed.

```sh
node --test tests/unit/state*.test.ts tests/unit/snapshots.test.ts tests/unit/mcp.test.ts tests/unit/mcp-boundaries.test.ts tests/unit/protocol.test.ts tests/unit/attempt-port.test.ts tests/unit/dispatch-policy.test.ts tests/unit/skills.test.ts
```

Actual differing native model/effort invocation, Claude native lifecycle, other operating systems, comparative performance and provider/account execution remain NOT RUN in this phase. Promotion, publishing, installation and cleanup are separate operational outcomes and are not asserted by these code/local-check statuses.
