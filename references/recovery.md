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
| Target drift / stale review | Reintegrate and repeat checks/review for new SHA |
| Review/attempt limit | Preserve blocker and evidence; maximum rounds remain bounded. BLOCKED_REPEATED_FINDING requires explicit analysis in the next repair-plan submission |

Begin `orch_cleanup` with `dry_run=true`; inspect every proposed removal. Unknown ownership, dirty/unmerged content, live worker or failed deletion remains explicit. Retain reports and unresolved data. Uninstall preserves run data by default and does not replace recovery.

`orch_task_retry` requires task/lease/fencing identity, confirmed `native_stopped` and a reason. It preserves failed dirty work and committed units, fences the old attempt, and enforces the attempt limit. Pause/resume uses `stopped_agents`; a never-started leased task requires explicit `never_started_tasks` evidence instead of a fabricated stopped agent. Checkpoints do not renew leases. Persist a report with `orch_report persist=true` only when authorized; that action requires coordinator authentication.

Session configuration is process-local: restarting the MCP server removes it. Reread effective config and reapply only authorized overrides using the new `hashes.session`; never claim the previous ephemeral session survived. Explicit paused time is tracked outside the active run budget. Waivers and run-scoped finalization consent are persisted separately from ordinary settings and do not authorize a native capability bypass.
