# Configuration

Scope precedence is defaults < global < project < session; host/organization permissions remain higher authority. Installation scope does not change configuration scope.

Global path: `ORCH_CONFIG_HOME/config.yaml` when set; otherwise `%APPDATA%/orch/config.yaml` on Windows, or `${XDG_CONFIG_HOME:-~/.config}/orch/config.yaml` elsewhere. Project path: `<invocation-root>/.orch/config.yaml`. Use `orch_config action=effective` for actual paths, per-field sources and current file hashes (`hashes.global` / `hashes.project` / `hashes.session`). A missing scope has its own hash; use the selected scope’s returned hash, not a hash of the merged config.

Objects merge by field; arrays replace; omitted values inherit. `unset` removes the selected scope's key and reveals the lower layer. Null is a value only where allowed by schema. Unknown/duplicate YAML keys and invalid types fail validation. Canonical schema and complete defaults ship in `packages/protocol/schemas/` and `templates/defaults/config.yaml`.

`auto` requests policy selection; `inherit` follows the parent. A concrete model/effort is a user override. Automatic optimization preserves it. Use the current host only. A natural-language global request authorizes global changes; a project request does not. Explain-only requests never write. Safety permissions cannot be granted by project config.

Writes require the selected file's current hash, validation, atomic replacement and readback. On conflict, reload and re-evaluate; preserve concurrent edits. Report changed values, sources and activation state. Existing attempts retain their config revision. An adapter without verified same-context native support remains blocked even after a valid config update.

## Current interfaces

- `npm run orch -- config --effective` returns values, field sources, files, layers and hashes.
- `npm run orch -- config set model_selection.profile quality --dry-run` validates a project patch without writing. Remove `--dry-run` only for an authorized write. Add `--global` only for an explicit global request.
- `npm run orch -- config unset model_selection.profile --dry-run` previews removing that scope’s key.
- `npm run orch -- models --host codex` reports requested roles with unresolved/unobserved values; `models available` and `models refresh` retrieve metadata. Use `claude` for that host.
- `models set ROLE --host HOST --model ID [--effort LEVEL] [--global] [--dry-run]` validates against catalog evidence. `configure [--profile balanced|quality|economy|fast] [--global] [--dry-run]` changes profile while preserving pins. CLI profile persistence alone is not evidence of native role-model application; inspect validated role recommendations and dispatch receipts.

MCP `orch_config` accepts `action=effective|patch|unset`, `scope=project|global|session`, `dry_run`, `expected_hash` and `patches` with path arrays/value/remove. Recommendation JSON Pointer patches must be translated to that actual tool shape. Session patches use `hashes.session` and return an incremented `sessionRevision` only when applied; dry-run leaves both unchanged. The session layer is isolated to this MCP server process, writes no file and disappears on server restart. Global/project files remain unchanged by a session patch. Run creation and future attempts read this effective layer; existing prepared attempts retain their pinned revision.

At each new attempt the engine rereads allowed model/profile changes, records config revision and requested/resolved model policy, and keeps prepared attempts unchanged. Other run policy changes require a new run. No setting change establishes a production native adapter.

## Automatic project initialization

Invoking the main `agent-orch` entry in a Git project calls authenticated `orch_project_init` unless the user explicitly requests no file writes. A missing `.orch/config.yaml` is created atomically with schema_version only, so user defaults stay inherited. Existing content is validated and preserved byte-for-byte; linked paths and invalid configuration fail closed. `orch_config action=effective` and direct `agent-orch-configure` explanations remain read-only. Initialization does not commit files or bypass the clean-checkout gate for write runs.

## Advisor recommendation transaction

`orch_model_recommend` accepts `action=preview|apply`, `scope=project|global|session` and an optional `profile`. Preview is read-only. Preview returns `recommendation`, `expected_hash` and `recommendation_hash`. Apply requires `approved=true` and both hashes from that exact preview; it recomputes the recommendation against current native metadata and configuration before applying it. Configuration drift produces `CONFIG_CONFLICT`; a changed recommendation produces `RECOMMENDATION_CONFLICT`. Reread/preview and obtain approval for the changed proposal rather than silently applying a different selection. Preserve fixed role values. A missing verified host default or comparative evidence leaves new-model choices unresolved rather than fabricating rankings. Inspect the returned patch/selections/warnings and effective-config readback. Model selection, accepted invocation parameters and actual execution observations remain distinct.

Advisor preserves fixed values in the target configuration scope even when a higher-precedence scope masks them. Effective inherited defaults do not authorize overwriting those hidden pins. Review the preview for both effective selections and preserved scope overrides before approval.

For an evidence-backed profile comparison, `orch_model_recommend` optionally accepts `assessments` (at most 256 strict entries): `{modelId,quality?,latencyMs?,usage?,evidenceRefs}`. Model IDs contain 1–256 trimmed characters; metrics must be finite and nonnegative; each entry requires 1–32 evidence references of 1–4096 trimmed characters. Supplying assessments requires the coordinator token even for preview. Resend the same assessments for apply: `recommendation_hash` binds both the recommendation and measurement inputs, so changed measurements conflict even when their ranking stays the same. Candidates come only from authenticated same-context `native.models` with actual per-invocation model/effort support; advertised subprocess catalog entries cannot become dispatchable choices on their own.
