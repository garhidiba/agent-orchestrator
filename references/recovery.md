# Recovery and diagnosis

Start with environment, run status and report. Record run ID, state/version, operation ID, source/integration/target SHAs and the exact error; keep credentials and raw prompts out of the report.

Pause/cancel through `orch_run_control`. A host disconnect does not prove a worker stopped. Confirm native lifecycle using the host; otherwise preserve the orphan state/worktree. Resume only after coordinator/worker ownership and pending operations have been reconciled. Status returns `pendingOperations` and `readyTasks`; neither is permission to dispatch.

For duplicate requests, reuse the original operation ID and inputs. After a commit/merge crash, `orch_reconcile` examines durable intent and Git ancestry; confirm the previous coordinator stopped before requesting reconciliation. Do not delete locks, reset, stash or recommit by guesswork. A conflict requires reading current state and establishing a safe next action.

| Condition | Action |
|---|---|
| BLOCKED_CAPABILITY / NEEDS_RELOAD | Keep state; report missing adapter proof or reload requirement; no silent fallback |
| RUNTIME_VERSION_PINNED | Reopen with the run’s original immutable runtimeRoot; a new installed version may read status but cannot mutate that run |
| STATE_CONFLICT / CONFIG_CONFLICT | Reread state/config, retain concurrent changes, re-evaluate |
| BASE_SHA_MISMATCH / ownership violation | Stop writes; preserve changes and repair assignment/base deliberately |
| ORPHANED_UNKNOWN / stop unconfirmed | Preserve worktree and determine real native lifecycle |
| Target drift / stale review | Call `orch_reintegrate` with exact `expected_target_sha`; rerun gates and independent reviews on the resulting SHA |
| Review/attempt limit | Preserve blocker and evidence; maximum rounds remain bounded. BLOCKED_REPEATED_FINDING requires explicit analysis in the next repair-plan submission |

Begin `orch_cleanup` with `dry_run=true`; inspect every proposed removal. Unknown ownership, dirty/unmerged content, live worker or failed deletion remains explicit. Retain reports and unresolved data. Uninstall preserves run data by default and does not replace recovery.

`orch_task_retry` requires task/lease/fencing identity, confirmed `native_stopped` and a reason. It preserves failed dirty work and committed units, fences the old attempt, and enforces the attempt limit. Pause/resume uses `stopped_agents`; a never-started leased task requires explicit `never_started_tasks` evidence instead of a fabricated stopped agent. Checkpoints do not renew leases. `orch_heartbeat` uses the normal authenticated CAS envelope and task/lease/fencing identity plus `native_id` and `receipt:{source:"host_status"|"host_event",status:"running",observedAt:epochMs,evidenceRef}` from an actual host observation. A model self-report, stale/future receipt or expired lease cannot establish fresh liveness. Confirmation reports actual `leaseRenewed` and preserves the fixed attempt deadline; it does not create an extra timeout window. `orch_liveness_reconcile` preserves uncertain expired workers as `ORPHANED_UNKNOWN`; it is not a native stop command. Persist a report with `orch_report persist=true` only when authorized; that action requires coordinator authentication.

Session configuration is process-local: restarting the MCP server removes it. Reread effective config and reapply only authorized overrides using the new `hashes.session`; never claim the previous ephemeral session survived. Explicit paused time is tracked outside the active run budget. Waivers and run-scoped finalization consent are persisted separately from ordinary settings and do not authorize a native capability bypass.

## Gate failures, target movement and findings

- From `BLOCKED_TESTS`, call `orch_verify` again for a retryable command failure, or submit a bounded repair plan through `orch_repair_plan_submit`. Keep the original failure evidence. A retry is distinct from a waiver, and repair/review attempt limits still apply.
- `orch_reintegrate` merges the exact expected target into a separate candidate before updating the run. Success discards stale reviews and prior finalization approval and returns to `VERIFYING`; obtain fresh checks/reviews and target approval. A `TARGET_CONFLICT` preserves the candidate and original source; inspect both fixed SHAs and resolve deliberately rather than choosing a blanket side.
- `orch_finding_disposition` requires `finding_id`, `status=ACCEPTED_RISK|NOT_A_BUG|DEFERRED`, nonempty `reason` and `approved=true`. Relay a real user decision, retain the disposition history and rerun review. `DEFERRED` remains blocking. A disposition does not replace independent verification of a proposed fix.
- Cleanup checks both worktree and owned branch. If worktree removal succeeded but branch deletion failed, inspect the dry run and retry the remaining safe branch operation; an absent path alone does not establish complete cleanup.

Completion and `orch_report` share the same conservative evidence rule: TaskResult acceptance evidence, current-SHA gates, independent reviewer/final-auditor evidence and acceptance limitations must agree. A waiver remains waived and does not become fully verified completion. Preserve reports, unresolved findings and unknown resources when evidence is insufficient.

For context recovery, reread current state plus immutable config/catalog/model/attempt snapshots. `orch_export` produces replaceable event/snapshot/config/plan/request views from the database; it does not infer absent observations or collect raw prompts. A snapshot hash identifies the original input while stored snapshot content is redacted, so do not recompute that identity hash from redacted export bytes.

Read-only reviewers also own live resources. Submit a production review only after actual native termination, with `native_stopped=true`. For an abandoned review call `orch_review_stop` with exact `dispatch_id`, matching `native_id` (null for an unbound dispatch only) and `native_stopped=true` after confirming no worker remains. A duplicate active role dispatch is blocked, and cleanup preserves the integration worktree while a read-only dispatch remains active or uncertain.

Attempt port addresses survive restart as metadata, while live socket ownership does not. Query `orch_attempt_port action=status` with the exact task/lease/fencing identity; `unknown`/null cannot authorize probing, rebinding or killing a process at that address. `release_for_claim` only releases an existing owned reservation and still requires separate actual service bind evidence. Disposal releases owned reservation sockets, never the claimed service process.
