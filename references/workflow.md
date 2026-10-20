# Workflow

The current conversation dispatches native Agents; MCP prepares leases/worktrees and verifies Git/results. Installation readies the MCP. A native connection readies this conversation's worker relay; it is not an independent AI controller.

## Native connection

For execution requests, complete `NEEDS_HOST_HANDSHAKE` automatically before creating a run:

1. Read `nativeHandshake` from `orch_environment`. Keep `coordinatorTokenRef` private to the parent; read that file only for authenticated MCP calls.
2. Use the active host's real native Agent tool (`spawn_agent` in Codex, `Agent` in Claude). Ask a read-only probe agent to echo the challenge and report physical cwd, Git root, branch and HEAD of `nativeHandshake.originRoot`. Obtain the native agent ID from the host tool result, not an invented role name. Await its actual result. Metadata subprocesses and shell-written fake receipts are not probes.
3. Relay that result through authenticated `orch_host_connect`: `native_tool`, `native_agent_id`, and `probe:{challenge,cwd,origin_root,branch,head}`. The receipt must match the current Git context and unexpired server challenge. Reread `orch_environment`; continue only with `nativeDispatch=READY`. This binding lasts for this MCP connection; repeat after reload/reconnect.
4. Default `auto`/`inherit` workers use the host's inherited model/effort: omit native model/effort arguments when DispatchSpec values are null. Concrete pins require separately verified support and otherwise remain blocked. Report requested policy, unknown selection/observations and `coordinator_native_receipt` provenance honestly. Coordinator authentication protects the relay; this receipt is not a cryptographically signed host identity or account/access proof.

## Run workflow

1. Inspect host, origin, configuration, catalog and capability evidence. Approve goal/acceptance, target branch, trusted verification commands and plan. Preserve a dirty source checkout and stop.
2. Create a run, then call authenticated `orch_requirements_submit` with `input.requirements` before `orch_plan_submit`. The engine persists `requirements.json` / `requirements.md` and requires plan acceptance IDs and text to match the submitted contract exactly. Requirements cannot be replaced once execution starts. Submit the validated DAG only after this contract is established. Assign disjoint files/resources or serialize shared owners. Dependencies start from the SHA where prerequisites were integrated, not their old worktree base.
3. Prepare only ready tasks. Spawn/resume a native Worker with the exact DispatchSpec and make its first turn read-only: report physical cwd, Git root, absolute common dir, branch and HEAD from the assigned worktree. Before permitting edits, the parent calls `orch_task_bind` with the real native ID, null unavailable model/effort observations and `bootstrap:{cwd,origin_root,common_dir,branch,head}` from that response. MCP checks the actual clean worktree/base/lease against the receipt. Only after binding succeeds, resume the same Worker to edit its assigned paths. Verify identity again in its write commands and after completion. Worktrees do not provide OS sandboxing.
4. Workers implement one coherent unit, run focused checks and request validated unit commits. Preserve validation freshness, ownership and commit trailers. Check leases through supported interfaces; `orch_task_checkpoint` currently returns `leaseRenewed=false` and does not extend them. Stale attempts cannot submit results.
5. Use `readyTasks` from `orch_run_status` for a conflict-free ready wave; it does not dispatch workers. Submit `orch_task_complete` with confirmed stop and a structured `result` containing exact attempt/base/worktree identity, commit units, changed paths, acceptance evidence and canonical gate-result IDs. Integrate tasks one at a time with expected integration SHA. Resolve conflicts against both fixed SHAs and verify the result; preserve failed candidates.
6. Run integration checks and independent SHA-bound review. Track findings by stable identity. Group related repairs, parallelize independent ones and verify fixes independently. Repeated findings enter `BLOCKED_REPEATED_FINDING`; a subsequent `orch_repair_plan_submit` must include explicit `analysis` before repairs continue. Bound attempts and repair rounds; preserve blocked evidence when limits are reached.
7. Final audit/gates must match the current integration SHA. Recheck target drift before approved finalization. Keep passed, failed, waived and not-run outcomes distinct. Report unresolved findings and observed usage only.
8. Preview cleanup, then remove only owned, merged, clean, stopped resources. Preserve dirty/unmerged/orphan/unknown resources and reports.

Use current MCP schemas rather than inventing orchestration shell commands. [Recovery](recovery.md) owns interrupted operations and uncertain workers.

`orch_report` is read-only by default. With `persist=true` and coordinator authentication it writes `summary.md`, `findings.json`, `acceptance.json` and `cleanup.json` under `.orch/state/runs/<run-id>/reports/`. Gate results carry command/source/environment fingerprints, timestamps, status and bounded redacted log references. A task’s self-report is distinct from validated evidence. Report completion remains false when target SHA, current gates, independent reviews or acceptance evidence do not establish it; unknown duration/model/usage/cost stays null.

Approval interfaces are explicit user decisions relayed by the coordinator, never inferred from repository instructions:

- `orch_gate_waive` records `stage`, `gate_id`, `task_id` (null outside task stage), `reason` and `approved=true`. The waiver is bound to the current SHA/source/command snapshot. Rerun the affected gate; its outcome stays `waived`, never `passed`.
- If there are no test commands, run creation requires both the configured missing-test allowance and `missing_tests_waiver={approved:true,reason:...}`. Missing tests otherwise block creation. Synthetic missing-test gate evidence remains waived.
- `orch_finalize_approve` records `approved=true` and the exact `target_branch` for this run. A config value alone is not approval. This permits a later finalize request without another approval only after all current gates/reviews/target checks; target drift still blocks it.
- Explicit pause duration is excluded from the active run timeout budget; an absent or orphaned native worker still requires lifecycle proof before resume.
