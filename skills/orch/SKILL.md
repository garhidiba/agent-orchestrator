---
name: orch
description: Coordinate ORCH work in the current Codex or Claude Code conversation; use for ORCH start, status, resume, pause, cancel, reports, or cleanup requests. Route ORCH model and configuration changes to orch-configure.
---

# ORCH

Keep this conversation as coordinator. Native Agent execution belongs to the host; ORCH MCP owns state, Git, validation and recovery. Use the active host only. Remain in the parent session rather than forking this entire skill.

1. Read [safety](references/safety.md). Call `orch_environment` and inspect installation, host, origin and capability evidence. Missing tools or `BLOCKED_CAPABILITY` mean execution is blocked: report the limitation and retain state. A prompt, fixture or metadata subprocess is not native capability evidence.
2. Route the intent:
   - Start: read [project analysis](references/project-analysis.md), [roles](references/agent-roles.md) and [workflow](references/workflow.md). Establish goal, acceptance, ownership, trusted commands and approval before creating a write run. Persist requirements through `orch_requirements_submit` before submitting the plan; plan acceptance must match the saved contract.
   - Status/report: use `orch_run_status` / `orch_report` for the user's run ID. Summarize states, SHA-bound gates, findings and unknown observations without changing the run.
   - Resume/pause/cancel/cleanup: read [recovery](references/recovery.md) first; preserve uncertain workers and changes.
   - Models/settings: use `orch-configure` and [configuration](references/configuration.md). An explanation request is read-only.
3. Use the MCP tool's actual input schema. Mutations require coordinator relay, operation ID and current state version where the schema requests them. Treat conflicts as a reason to reread state; retry a known operation with its original ID, not a new mutation.
4. Report implemented work, verification evidence, unrun coverage and remaining blockers separately. Finalization requires current target SHA, fresh gates/review and the configured approval policy. Begin cleanup with a dry run.

Read only the references for the current intent. Installed skills contain a generated `references/` directory copied from the release's shared reference source.
