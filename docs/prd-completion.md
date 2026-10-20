# PRD completion audit tracking

Baseline: `4a9219290f770bb99988c7f68f928a82cbe03fc6` (2026-10-20). The [source PRD](orch-agent-orchestrator-prd.md) is frozen. This file tracks the completion run; it does not declare PRD completion, a passed release gate, or actual provider availability. Finding numbers follow the coordinator's confirmed source audit; M/R/L/D codes identify implementation ownership only. The source audit is static evidence, not an executed failing test.

## Reopened runtime failures — 2026-10-20

PRD completion is **not established**. Earlier conversational claims that testing was complete are withdrawn: the 166-test local pass and configuration readback did not establish the real Claude workflow. Use the [verification status glossary](project-glossary.md) for every new result. Preserve the failures below until their exact scenarios are rerun; a synthetic regression pass alone does not close host acceptance.

| Failure | PRD requirement | Direct evidence | Current acceptance state |
|---|---|---|---|
| Claude full version/effort cannot reach a worker | 17.2 generated definitions; AT-004, AT-014–015, AT-045; POC-02/05 | User's Claude `task-a` preparation stopped with `MODEL_NOT_SUPPORTED` for `claude-sonnet-5-5` / `claude-opus-5-5`, with Opus `high`. Saving documented values did not supply the missing definition transport. | Code corrected and contract tested at `c1a0093`; installed Claude CLI accepts generated syntax. Exact real-Claude Agent/reload rerun remains NOT RUN, so host acceptance is OPEN. |
| Managed worktree lacks ignored dependencies | 11.4 trusted bootstrap/cache sharing; 13.1 baseline/task/integration gates | Original checkout's skills test passed; the managed task worktree could not import `yaml` because `node_modules` was absent. | Code corrected; exact dependency-using command passed with two real Codex workers in runtime source `3d07eb6`, followed by review/audit/finalization/cleanup. This does not establish the unrun Claude host workflow or unsupported dependency layouts. |

The earlier Codex marker smoke verified its scoped workflow only: a marker with a dependency-free assertion cannot establish dependency readiness for this repository's actual test command. Native invocation arguments and actual provider model/effort observations remain separate; unexposed observations are null.

## Source-audit corrections — 2026-10-21

The five source gaps identified at `79d3ab5` now have scoped corrections below. Worker-reported RED/GREEN tests use the public Engine/MCP boundaries; they do not establish real Claude acceptance. Integrated full-check and independent-review results are recorded separately after execution. The frozen PRD is unchanged.

| Requirement | Implemented behavior | Focused regression / boundary |
|---|---|---|
| 10.3 / 13.3, AT-026/055 | Approved snapshot-matching waivers permit finalization and crash reconciliation. Reports distinguish `finalizedWithApprovedExceptions=true` from `completionVerified=false`, retain `waived`, and reject stale/unapproved exceptions. Latest used baseline/task waivers also prevent full-verification claims. | `waiver-finalization.test.ts`; independent reviews, acceptance evidence and target checks remain mandatory. |
| 13.4 | Gate inputs are checked before/after execution and again before commit/submission/review/finalize and immediately before target merge. Finalize crash recovery rechecks both gate contexts and returns stale inputs to `VERIFYING`, retaining the already-updated target and old evidence. Root `node_modules` content/link and inherited environment/runtime drift invalidate evidence; nested external dependency links are rejected. | `dependencies.test.ts`, `engine.test.ts` freshness regressions. **Partial generic coverage:** Python/PnP/system dependencies and external executable bytes are not fingerprinted; large-install performance is unmeasured. |
| 9.2 / 11.3 | Authenticated CAS `orch_plan_amend` accepts an explicitly approved replacement plan while paused with stopped workers/reviews. Requirements and committed task evidence remain immutable; plan revisions and previous evidence persist in snapshots with interruption reconciliation. | `plan-amendment.test.ts`; dirty old attempts are preserved, not copied automatically to new attempts. |
| 12.1 | Run creation rejects ongoing Git operations, invalid author/committer identity, unverified enabled commit signing, superproject submodules and active LFS layouts; source/common/managed filesystems must have available space. | `git-preflight.test.ts`; signing/LFS/submodule execution is unsupported, and space availability is not capacity reservation. |
| 12.4 step 7 | Actual staged blobs and sensitive paths are checked before whitespace validation and commit. Detection errors contain no matched content; large ordinary binary assets remain supported. | `commit-secrets.test.ts`; pattern scanning does not detect all formats or compressed/encrypted secrets. |

The [current acceptance map](acceptance.md#current-requirement-map) distinguishes contract coverage, actual-host evidence and missing scenarios. M0, both-host M2 acceptance and v1 release remain incomplete. NFR-01–03 measurements, four actual workers, actual parallel repair/recovery, Python/TypeScript/linked-worktree E2E and non-macOS host acceptance have no sufficient current evidence. No fixed test count substitutes for those requirements.

**CODE_AND_LOCAL_CHECKS_PASSED** means the implementation passed the recorded full baseline and subsequent scoped local checks, with independent findings closed. It does not establish actual native model/effort application, Claude/other-OS acceptance, performance/provider results or v1 release completion. References to earlier results in [acceptance](acceptance.md) and [implementation status](implementation-status.md) remain dated historical evidence.

| Finding / slice | Owner | Acceptance condition | Evidence state |
|---|---|---|---|
| 1 / M1 Catalog-to-store provider identity | Models | Use real provider/config evidence without name-prefix inference; a supported advertised candidate can pass catalog-to-store validation. | CODE_AND_LOCAL_CHECKS_PASSED — E2 + model checkpoint |
| 2 / M2 Role model/effort dispatch | Models + coordinator | Resolve concrete per-role settings through authenticated native capabilities or verified generated definitions; next attempts receive changes while active attempts retain their revision. | Corrected code/contract at `c1a0093`; Claude actual-host acceptance remains OPEN. E1/E2 retain their historical scope. |
| 3 / M2 Read-only review dispatch | Models + coordinator | Reviewer/final_auditor have independent read-only prepare/bind receipts containing revision and requested/resolved/observed values. | CODE_AND_LOCAL_CHECKS_PASSED — E1/E2 |
| 4 / M2 Actual observations | Models + coordinator | Record nonnull observations against unknown resolution and report clamp/mismatch separately from actual policy violations. | CODE_AND_LOCAL_CHECKS_PASSED — E1 + model checkpoint |
| 5 / M3 Advisor/profile application | Models + coordinator + docs | Close evidence-based recommendation → validated authorized apply → next-worker dispatch while preserving explicit pins; invent no ranking or pricing. | CODE_AND_LOCAL_CHECKS_PASSED — E2 + Advisor `1e70035` scope-pin fix (19 public tests PASS) |
| 6 / M4 Claude metadata and definitions | Models + delivery | Replace the empty metadata stub with a supported current-context path without paid inference; preserve separate invocation/definition/reload/access evidence and real-Claude E2E limits. | Usable generated-definition preparation/probe/receipt path added at `c1a0093`; CLI syntax validation passed, but actual Claude named invocation/reload remains NOT RUN. |
| 7 / R1 Failed gate recovery | Recovery + coordinator | Bounded retry/repair can return from BLOCKED_TESTS through review/finalization without a waiver while preserving the first failure. | CODE_AND_LOCAL_CHECKS_PASSED — Recovery checkpoint; E2 schema |
| 8 / R2 Canonical completion oracle | Recovery | Engine finalization and report share conservative acceptance/gate/review rules; an acceptance limitation blocks target mutation while irrelevant notes remain distinct. | CODE_AND_LOCAL_CHECKS_PASSED — E1 + recovery checkpoint |
| 9 / R3 Target drift reintegration | Recovery + coordinator | Verify exact moved target SHA, reintegrate in the same run, invalidate stale gates/reviews and return to VERIFYING. | CODE_AND_LOCAL_CHECKS_PASSED — Recovery checkpoint; E2 schema |
| 10 / R4 Cleanup retry | Recovery | Retry owned branch deletion after prior worktree removal; inspect both resources and preserve unknown branches. | CODE_AND_LOCAL_CHECKS_PASSED — Recovery checkpoint |
| 11 / L1 Budget and liveness | Lifecycle + coordinator | Enforce active budget across mutation/gate phases; parent-confirmed fresh native liveness governs heartbeat/lease renewal; reconcile expiry to ORPHANED_UNKNOWN and preserve unknown resources. | CODE_AND_LOCAL_CHECKS_PASSED — E1/E2 + lifecycle checkpoint |
| 12 / R5 Finding disposition | Recovery + coordinator | ACCEPTED_RISK, NOT_A_BUG and DEFERRED record explicit approval and reason without silently removing blocking findings. | CODE_AND_LOCAL_CHECKS_PASSED — Recovery checkpoint; E2 schema |
| 13 / L2 Attempt resources | Lifecycle + coordinator | Allocate attempt-owned tmp/database/build/port resources without touching real .env/database; prepare trusted dependency reuse separately from mutable outputs. | Node reuse correction has 19 focused regression cases and the scoped two-worker Codex run below. Workspace/local/external-link installs and non-Node setup remain outside automatic reuse. Arbitrary command isolation is NOT VERIFIED. |
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

## Runtime-readiness correction evidence

The code snapshot is `c1a00935ec38990250a6914f7984681eb84b901f`. Later evidence-document edits do not turn this into a full-suite result for a different HEAD. Both original failures have focused RED reproductions retained by their owners before the fixes. An integration cherry-pick type conflict was resolved preserving both dependency provenance and optional prepared native arguments; its initial parser failure is retained separately from the successful full check.

| Evidence class | Actual result | Limits |
|---|---|---|
| Complete local project command | `npm run check`: typecheck PASS, 196 tests PASS, 0 failed/skipped, 341121.107209 ms at `c1a0093`. | Deterministic/local checks; not the entire PRD or actual Claude acceptance. |
| Independent code/security review | 44 focused tests PASS at `c1a0093`; previous ignore-negation finding resolved; no remaining findings in the declared diff scope. | Review and local regressions only. |
| Real installed Claude CLI parser | Claude Code 2.1.304: `claude plugin validate <temporary-project>/.claude/agents` accepted generated Sonnet 5.5 and Opus 5.5/high definitions at `c1a0093`. | No native Agent invocation, host reload or provider access was tested by this command. |
| Actual Codex client workflow | `run-78529562-a0c7-4e46-b9e6-903653664573`: full source client checkout, two separate actual `gpt-6.1-sol`/`medium` coder invocations, runtime-prepared dependency links, unchanged `node --test tests/unit/skills.test.ts` in baseline/tasks/integration/final; independent `gpt-6-astra`/`xhigh` reviewer and auditor, finalization and owned cleanup. `completionVerified=true`, no blockers. Final client SHA `4636cb1be122a6bf378488788bc8f5c4fdfdb3e9`. | The MCP process loaded runtime source `3d07eb6` before the subsequent Claude-only evidence guards were integrated. This is the exact dependency-readiness scenario and a scoped Codex workflow, not a final-HEAD/Claude/full-PRD claim. Actual backend model/effort observations remain null. |

The source-candidate runtime and final installed runtime are distinct operational evidence. The user's already-running `orch-smoke` checkout and `run-7e8a2f7a-d180-4925-8896-021c210f40f0` were not mutated, cancelled or cleaned up. Existing runs retain their pinned runtime; a newly installed bundle does not rewrite them. Runtime-readiness artifacts live in the coordinator-owned Git common directory under `orch/runs/runtime-readiness-20261020/` (summary, original command logs, parser result, archived run state and final Git bundle), without coordinator tokens or raw conversation transcripts.

The five source-audit gaps above and the actual Claude/POC/platform/NFR acceptance remain open. No PRD/v1 completion is asserted.

## Remaining-contract implementation checkpoint

The first integrated source `7a58f0b2f10e9af87262d89e1da6e56b9c35aedb` passed `npm run check`: typecheck and **226/226 tests**, zero failures/skips/cancellations (458.155 seconds). Independent Spec/Standards/security review then reproduced post-final-gate and recovery freshness bypasses, inherited Git-identity test dependence, and a TypeScript type-alias secret false positive. These findings required further correction; the 226-test pass did not establish their absence.

Corrections at `0c2f42e` add merge/recovery freshness and usable revalidation, isolate preflight fixtures, allow ordinary type aliases and reject simple typed runtime credential literals. Final integrated checks and independent re-verification are recorded in the run evidence separately. Actual Claude execution/reload, generic dependency environments and full PRD/v1 release acceptance remain unverified.

Final integrated source `499d740ce1b8316cd3599e8c8c44ffb20e927020` passed `npm run check`: typecheck and **227/227 tests**, zero failures/skips/cancellations (470.503 seconds). Independent Spec, Standards/test-quality and security re-review reported no remaining findings in this diff. Independent public-Engine reproductions confirmed pre-merge environment/dependency rejection, stale crash recovery through revalidation/finalization, preserved approved-waiver reporting and credential/type handling. Evidence is stored in the Git common directory at `orch/runs/prd-remaining-20261021/` (`full-check-499d740.log`, `independent-reviews.json`, slice evidence and freshness RED/GREEN logs). This is code/fixture evidence, not actual Claude/reload or whole-PRD acceptance.

Applied workflows for this checkpoint: `minimal-code`, `diagnose`, `mattpocock-skills:tdd`, `multi-agent-git-orchestration`, `ponytail`, `mattpocock-skills:code-review`, `pr-security-review`, `test-quality-review`, `skill-creator`, and `mattpocock-skills:writing-for-agents`. No dependency versions or frozen PRD requirements changed.
