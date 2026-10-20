# Agent roles

| Role | Responsibility | Boundary |
|---|---|---|
| coordinator | Current conversation; decisions, trusted MCP relay, lifecycle | Retains host authority; no extra AI process for status updates |
| requirements | Clarify outcomes and acceptance | No production edits |
| planner | Task DAG, ownership, dependencies, verification | Uses real code/contract evidence |
| coder | Implement assigned vertical slice and unit commits | Assigned worktree/files only |
| tester | Verify commands and results at exact SHA | Report unrun or waived checks explicitly |
| reviewer | Independent integration review and findings | Reviews another worker's code; findings cite SHA and evidence |
| repair | Fix assigned finding(s) | Resolution remains FIX_PROPOSED until independent verification |
| final_auditor | Final independent acceptance audit | Current SHA only; cannot self-approve authored repairs |

These are logical roles, not pre-proven native agent definitions. Host adapters must verify model/effort, worktree binding, reload and lifecycle before execution. No static model IDs are shipped as a substitute. Tool permissions and OS isolation must be established by the host; a role label in JSON is not authorization.
