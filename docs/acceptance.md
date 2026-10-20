# PRD acceptance traceability

For the current PRD completion run, use the [audit tracker](prd-completion.md). The results below retain their original baseline and do not prove later changes or the v1 release gate.

**Current runtime failures:** real Claude full-version/effort dispatch and dependency readiness in managed worktrees are reopened in the tracker. Configuration saving, deterministic test passes and a dependency-free Codex marker smoke did not verify these scenarios. [Status terms](project-glossary.md) define the evidence required for each claim; no overall PRD completion is asserted.

## Current requirement map

Source-audit baseline: `79d3ab5`. This map supersedes the older acceptance index below for current evidence classification. `Contract` means source and named deterministic fixtures exist, not that this audit ran them. `Historical host` applies only to its recorded Codex smoke; the current Claude failures remain open. Source gaps have not been promoted to dynamically reproduced failures.

| PRD acceptance IDs | Current evidence and remaining requirement |
|---|---|
| AT-001 | Entry/relay contract and historical Codex single-task smoke; complete current entry-to-finalize rerun remains separate. |
| AT-002 | Shared entry/plugin packaging contract; actual Claude entry-to-completion and namespace deduplication NOT RUN. |
| AT-003–004 | Active-host guards tested locally; historical Codex-only smoke. Claude native workflow failed and remains open. |
| AT-005–006 | Advisor/scope/read-only contracts and bilingual routing fixtures; actual installed-host natural-language evaluation NOT RUN. |
| AT-007–009 | Field merge, unset and explicit-pin preservation contracts. |
| AT-010 | Missing/invalid selection guards exist; valid Claude full-version/effort rejection is reopened. |
| AT-011–012 | Cache/timeout/pagination/deduplication contracts; subprocess account/policy scope remains unknown. |
| AT-013–014 | Requested/resolved/observed and next-attempt revision contracts. Actual host clamp and changing role settings are not proved by fixture metadata. |
| AT-015 | Generated-definition reload/observation is incomplete at the audit baseline; actual reload proof NOT RUN. |
| AT-016–017 | Isolated worktree/ownership/ready-wave contracts; two prepared tasks are not two concurrent actual workers. |
| AT-018 | Unintegrated-dependency blocking is tested. A dependent task completing from the predecessor's integrated SHA needs its full scenario. |
| AT-019–020 | Bootstrap/base and dirty-checkout preservation contracts; historical successful Codex bootstrap is not an actual wrong-base rejection test. |
| AT-021 | Unit/trailer and partial-unit recovery contracts; one task completing two independent successful commits lacks its full fixture. |
| AT-022–023 | Ownership and serialized integration contracts; actual concurrent native result arrival NOT RUN. |
| AT-024 | Conflict candidate/fixed-parent resolution code exists. Target-conflict fixtures do not complete the two-task conflict acceptance scenario. |
| AT-025 | Failed/timeout gate contracts; actual native host stop remains separate. |
| AT-026 | Missing-test waiver can finalize as an approved exception; `waiver-finalization.test.ts` covers the local contract, without claiming tests passed or host acceptance. |
| AT-027 | SHA/source review freshness contracts plus a historical independent native review; actual host re-review after drift NOT RUN. |
| AT-028–029 | Repair DAG/grouping contracts; multiple parallel repairs and related-finding grouping need their full scenarios. |
| AT-030–032 | Proposed/verified finding lifecycle, stable IDs and bounded review/reanalysis contracts; actual model-driven relocation/repeated defects NOT RUN. |
| AT-033 | Shared completion/report guard and historical scoped Codex completion; not both-host PRD completion. |
| AT-034–036 | Target drift, exact approval and run-scoped preapproval contracts. |
| AT-037–039 | Owned cleanup and dirty/unknown preservation contracts; historical Codex cleanup only. |
| AT-040 | Pause/resume/reconciliation contracts; real host shutdown/recovery NOT RUN. |
| AT-041 | Operation fingerprint/replay contracts. |
| AT-042 | Lease/fencing/retry and heartbeat contracts. `orch_heartbeat` exists; checkpoint alone does not renew a lease. Actual host liveness event path NOT RUN. |
| AT-043–044 | Git crash intent/reconciliation fixtures; actual killed-host recovery NOT RUN. |
| AT-045 | Project config separation contract; actual simultaneous differing project role definitions NOT RUN. |
| AT-046 | Common-dir lock contract; actual simultaneous host start NOT RUN. |
| AT-047–050 | Isolated installation/update/conflict/rollback/removal contracts and dated installation records; no general OS/release certification. |
| AT-051 | Authenticated coordinator/strict-schema/command-trust contracts; staged secret scanning has a dedicated commit regression (known pattern/path detection, not exhaustive secret discovery). Model-driven injection evaluation NOT RUN. |
| AT-052 | Unknown actual model/usage/cost stays null. |
| AT-053 | Copy/space/Korean-path fixtures; actual Windows/PowerShell/no-symlink-privilege run NOT RUN. |
| AT-054 | Bounded metadata subprocess fixtures; actual cleanup on every supported OS NOT RUN. |
| AT-055 | Snapshot-bound approved waived finalization/recovery and distinct report outcome have dedicated regressions; waived remains waived and completionVerified stays false. |
| AT-056 | Non-inference/non-login installation fixtures; actual logged-out two-host installation NOT RUN. |
| AT-057 | Orphan/unknown-stop preservation contracts; actual native disappearance/cancel/resume NOT RUN. |
| AT-058 | Owned partial cleanup retry fixture exists (`cleanup retries a remaining owned branch after its worktree was already removed`); real filesystem failure and host lifecycle remain separate. |

| PRD proof of concept | Current evidence |
|---|---|
| POC-01 | Codex invocation arguments and scoped native workflow recorded; actual provider identity/effort observations remain null. |
| POC-02 | Claude relay contract; user's full-version/effort workflow failed. |
| POC-03 | Unknown-scope metadata plus authenticated parent receipts; not an automatic proof of identical account/workspace/policy. |
| POC-04 | Historical Codex managed-worktree bootstrap; Claude and wrong-native-base host scenarios NOT RUN. |
| POC-05 | Actual definition change/reload/observation NOT RUN. |
| POC-06 | Lifecycle receipt/orphan/retry contracts; actual stop/cancel/resume/event workflow NOT RUN. |
| POC-07 | Windows native and WSL full integration NOT RUN. |
| POC-08 | Parent-relay/MCP contracts and historical Codex relay; not a sandbox certification or actual Claude boundary proof. |

The PRD's M0 and both-host M2 gates, NFR measurements and minimum E2E fixture set remain incomplete. The source PRD is unchanged. The historical sections below retain their dated context; descriptions superseded by the current map must not be read as current absence or success claims.

Baseline: integrated source `d6f73631e6eb875a87e282871cf5a536a5b93638`, 2026-10-20. This is a scoped evidence index, not an exhaustive QA Matrix or a passing v1 release gate. The disabled `qa-verification` workflow was not invoked. A local rule implemented and exercised by fixtures is distinct from an absent production native adapter, an unrun host/OS experiment, and an uncovered local scenario. The coordinator recorded `npm run check`: typecheck PASS and 100 tests PASS, 0 failures/skips (26.756 seconds), plus a clean diff check. Independent final review confirmed every raised finding fixed, with 15 focused tests and six masked model/effort checks passing. A source-built macOS arm64 bundle passed isolated both-host configuration installation, installed CLI and MCP handshake/27-tool listing, selective removal and preservation checks. Actual native host execution and other operating systems remain unverified.

## Remaining local implementation surfaces

- Implemented and exercised locally: snapshot-scoped gate/missing-test waiver, run-scoped finalization preapproval, pause-excluding active timeout, repeated-finding reanalysis, mandatory requirements submission/persistence and process-local session overrides. These fixtures do not establish actual host execution.
- Checkpoint is summary-only (`leaseRenewed=false`); no heartbeat renewal API.
- Session overrides intentionally last only for the MCP server process; restart does not persist them. Requirements submission is now an authenticated engine operation and must precede a plan with exactly matching acceptance criteria.
- Dedicated conflict-resolution and partial-delete/retry acceptance scenarios are not demonstrated by the current named tests. These are local evidence gaps, independent of host availability.
- Current-host native relay is implemented and a real inherited Codex task passed worker bootstrap, validation, independent review/audit, finalization and cleanup. See the native smoke record in implementation-status.md. Concrete role model/effort and actual Claude native lifecycle remain unverified; coordinator receipts are not signed host/account proof.

## Acceptance index

Named tests below are stable test titles or owning suites under `tests/unit/`; run them with `node --test tests/unit/<suite>.test.ts`. An implementation description is not a PASS claim for the complete PRD acceptance case.

| PRD IDs | Local implementation | Deterministic evidence | Remaining gap/proof |
|---|---|---|---|
| AT-001 | Entry source implemented; parent session retained | skills.test.ts: shared skill sources | Installed Codex discovery + real native completion missing |
| AT-002 | Shared Claude entry source implemented | skills.test.ts: shared skill sources | Installed Claude discovery/namespace deduplication + native completion missing |
| AT-003–004 | Active host enforced in config/catalog; cross-host flag is false | config.test.ts; protocol.test.ts: recommendations reject cross-host settings | Production native dispatch adapter absent for both hosts |
| AT-005 | Advisor instructions/schema and profile CLI implemented; no measured automatic role ranking | skills/evaluations.json; config-cli.test.ts | Natural-language host execution not evaluated |
| AT-006 | Read-only explanation procedure and fixture implemented | skills/evaluations.json: ko-explain/en-explain | Actual host explanation route/write audit not run |
| AT-007 | Field-wise merge and per-field sources implemented | config.test.ts: AT-007 | No external proof needed for this merge rule; current suite result is local evidence |
| AT-008 | Scoped unset and inherited pins implemented | config-write.test.ts; config-cli.test.ts | No installed-host trigger proof; direct API/CLI rule tested |
| AT-009 | Profile configure preserves model pins | config-cli.test.ts: developer CLI config mutation | Actual Advisor host behavior not evaluated |
| AT-010 | Model/effort validation fails closed against catalog evidence | model-cache.test.ts; config-write.test.ts; engine.test.ts | Same-context catalog access remains unknown; execution path blocked |
| AT-011 | Errors, cache expiry and failed-refresh provenance implemented | catalog-service.test.ts: disk catalog uses exact partial scope | Real account/policy identity unproven |
| AT-012 | Codex handshake, paging and deduplication implemented | catalog.test.ts: Codex metadata uses handshake | Claude full native catalog unavailable |
| AT-013 | Requested/resolved/observed contract distinguishes unknown | protocol.test.ts; reporting.test.ts | Actual host clamping/model observation unverified |
| AT-014 | New attempts pin config revisions and model policy; prepared attempts retained | engine.test.ts: new worker config revisions | Native model application missing |
| AT-015 | Native probe returns reload unknown/NEEDS_RELOAD policy | host-capabilities.test.ts | No production definition reload/apply adapter |
| AT-016 | Ready wave + separate Git worktrees implemented | engine.test.ts: two tasks use isolated worktrees; ready wave prioritizes | Actual simultaneous native execution unrun |
| AT-017 | Write/resource collisions serialize | engine.test.ts: ready wave prioritizes critical path | Native host isolation not proved |
| AT-018 | Dependency requires integrated prerequisite and dispatch uses current integration SHA | engine.test.ts: two tasks use isolated worktrees | Native dependent dispatch unrun |
| AT-019 | Bind checks common dir, branch and exact base before accepting worker | engine.test.ts: resuming a partial unit; git.test.ts | Native worktree-binding adapter absent |
| AT-020 | Dirty origin/unknown changes preserved and blocked | engine.test.ts: dirty original | Native external writes remain host responsibility |
| AT-021 | Unit commits/trailers and canonical gate IDs implemented | engine.test.ts: two tasks use isolated worktrees | Native worker unit discipline unverified |
| AT-022 | Ownership checked at validation/commit/completion | engine.test.ts: dirty original | OS permission enforcement not provided by Git worktrees |
| AT-023 | Operation lock + expected integration SHA serialize merge | engine.test.ts: two tasks; each mutation verifies common-dir lock | Concurrent native result arrival not run |
| AT-024 | Fixed-parent conflict candidate and guarded resolution implemented | engine.test.ts: commit/merge fixture; core runtime resolveConflict | Dedicated conflict-resolution acceptance fixture not demonstrated |
| AT-025 | Required gate failure/timeout cannot pass; bounded log evidence | protocol.test.ts: gate evidence; engine gate implementation | Actual host task timeout/stop adapter absent |
| AT-026 | Missing commands require configured allowance plus separate explicit user waiver; evidence remains waived | engine.test.ts: missing tests remain blocked | Native test authoring/approval interaction unverified |
| AT-027 | Review SHA/source/gate freshness enforced | engine.test.ts; reporting.test.ts: complete evidence is SHA bound | Real independent native reviewer not bound |
| AT-028–029 | Repair plan DAG/ownership validation implemented | plan.test.ts; engine.test.ts: finding severity cannot be lowered | Actual parallel repair workers missing |
| AT-030 | Repair marks FIX_PROPOSED; independent re-review confirms absence | engine.test.ts: finding severity cannot be lowered | Independent host lifecycle not demonstrated |
| AT-031 | Finding identity/fingerprint excludes line number; stable ID reused | engine.test.ts: finding severity cannot be lowered | Cross-file relocation still requires reviewer stable identity; no semantic matcher |
| AT-032 | Maximum review rounds and repeated-finding reanalysis enforced | engine.test.ts: repeated findings stop repairs | Actual model defect detection/reanalysis unverified |
| AT-033 | Finalize/report demand current gates, independent review, all acceptance evidence | reporting.test.ts: complete evidence; engine.test.ts | Both-host native end-to-end acceptance absent |
| AT-034 | Target drift blocks finalize | engine.test.ts: two tasks; runtime finalize | Automatic target rebase/replan is coordinator work, not implemented native path |
| AT-035 | Explicit finalize approval enforced | engine.test.ts: two tasks require finalize approval | Host user-approval identity remains a trust boundary |
| AT-036 | Explicit run/target-scoped preapproval permits finalize after all gates; config alone is insufficient | engine.test.ts: run-scoped explicit preapproval | Actual user consent/native workflow unverified |
| AT-037 | Owned clean merged stopped resource cleanup implemented | engine.test.ts: two tasks; git.test.ts | Actual native stop proof unavailable |
| AT-038–039 | Dirty/unmerged/unknown/orphan resources retained; manifests determine ownership | engine.test.ts: dirty original | Actual hostile/unknown host lifecycle unverified |
| AT-040 | Operation reconciliation, paused/orphan recovery and pause-excluding active budget implemented | engine.test.ts: explicit pause time; resuming partial unit | Actual host shutdown/resume missing |
| AT-041 | Idempotency operation fingerprint and prior result replay implemented | state.test.ts; engine.test.ts: crash after Git commit or merge | No additional host proof for deterministic replay rule |
| AT-042 | Lease/fencing rejects old attempts; retry preserves old work | engine.test.ts: retry preserves dirty failed work | Checkpoint does not renew lease; actual host heartbeat absent |
| AT-043–044 | Git intent reconciliation prevents duplicate commit/merge history | engine.test.ts: crash after Git commit or merge | Actual killed host process recovery not run |
| AT-045 | Project config paths isolated; no global native role rewrite | config-files.test.ts; installer.test.ts: project installs | Concurrent actual two-project native sessions missing |
| AT-046 | Common-Git-dir write lock and operation ownership enforced | engine.test.ts: each mutation verifies common-dir run lock | Actual simultaneous host starts unrun |
| AT-047 | Immutable local install idempotent; unrelated config retained | installer.test.ts: AT-047 | Installed-host discovery/reload smoke missing |
| AT-048 | User skill/MCP conflicts block overwrite | installer.test.ts: AT-048 | Actual host config reload not proved |
| AT-049 | Injected migration failure restores prior active config/version | installer.test.ts: AT-049/050 | No actual published migration/release rollback run |
| AT-050 | One-host uninstall preserves other host + run data | installer.test.ts: AT-049/050 | Actual both-host installed-session smoke missing |
| AT-051 | Coordinator token/strict schema/command trust boundaries implemented; safety instructions explicit | mcp.test.ts; protocol.test.ts; state-safety.test.ts | No model-driven injection or host sandbox security certification |
| AT-052 | Absent actual model/usage/cost remains null | reporting.test.ts: task completion alone cannot claim | Real usage/price collector absent by design; not invented |
| AT-053 | Copy-based installation + Korean/space path fixture; platform manifest validation | installer.test.ts: AT-053/056 | Windows native/PowerShell and no-symlink-privilege run absent |
| AT-054 | Metadata timeout/exit handling implemented | doctor.test.ts: bounds a stalled metadata process | Cross-platform process cleanup proof unrun |
| AT-055 | Authenticated waiver records user reason and snapshot; gate/report retain waived status | engine.test.ts: a failing gate requires explicit scoped approval | Actual user approval interaction unverified |
| AT-056 | Shell launcher fixture performs no login/inference and reports auth NOT_CHECKED | installer.test.ts: AT-053/056 | Actual unauthenticated Codex/Claude smoke missing |
| AT-057 | Stop-unconfirmed marks/preserves orphan and requires evidence to resume | engine.test.ts: dirty original; resuming partial unit | Production native lifecycle event/stop adapter absent |
| AT-058 | Cleanup records resources and preserves failed/unsafe paths | engine.test.ts; runtime cleanup | Dedicated injected partial-delete/retry acceptance fixture not demonstrated |

## Requirements and session contract evidence

`requirements.test.ts` and engine test “requirements persist before planning” cover canonical artifacts and exact acceptance matching. `config-session.test.ts` covers isolated process-local highest precedence, unset, dry-run and conflict behavior; MCP tests cover the public session surface. Session server restart intentionally resets the layer.

## Reproducible verification

`npm run check` runs the project typecheck and deterministic suite; use the current output for the exact result/count. `node --test tests/unit/skills.test.ts` checks generated installed reference paths, frontmatter, configured roles and bilingual fixture integrity. Installer tests use temporary user/project paths; native metadata processes are fixtures unless explicitly recorded otherwise.

For M0–M6, deterministic config/runtime/installer foundations are implemented in part. The current Codex inherited-worker smoke passed; M0 concrete role selection, M2 both-host E2E and M6 OS/release acceptance remain incomplete. No injected fixture capability may make the production gate green.

## Skill evaluation

`skills/evaluations.json` supplies Korean and English positive/negative prompts for automatic settings, pinned models, global/project scope, explanation-only, unrelated tools, status and unsafe approval bypass. Expected route/effect are oracles, not actual host outcomes. Evaluate each in a disposable installed host context and record route, writes, preserved overrides and capability decisions. Structural tests validate packaging only.

## Native readiness follow-up

The dated baseline table above precedes `365e727`. The current-conversation native relay now has a real Codex single-task smoke: challenge → read-only Git bootstrap → native edit → MCP validation/unit commit/integration → independent native review/audit → approved finalization → owned cleanup. Report: COMPLETED, completionVerified=true, no blockers. Full details and exact SHAs are in [implementation status](implementation-status.md#실제-네이티브-준비-상태-수정과-테스트). This supersedes baseline statements that production dispatch is always absent/blocked, but does not establish untested model pins, Claude execution or other operating systems.
