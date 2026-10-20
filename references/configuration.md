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
- `models set ROLE --host HOST --model ID [--effort LEVEL] [--global] [--dry-run]` validates against catalog evidence. `configure [--profile balanced|quality|economy|fast] [--global] [--dry-run]` currently changes profile while preserving pins and unverified host defaults; it is not a benchmark-based optimizer.

MCP `orch_config` accepts `action=effective|patch|unset`, `scope=project|global|session`, `dry_run`, `expected_hash` and `patches` with path arrays/value/remove. Recommendation JSON Pointer patches must be translated to that actual tool shape. Session patches use `hashes.session` and return an incremented `sessionRevision` only when applied; dry-run leaves both unchanged. The session layer is isolated to this MCP server process, writes no file and disappears on server restart. Global/project files remain unchanged by a session patch. Run creation and future attempts read this effective layer; existing prepared attempts retain their pinned revision.

At each new attempt the engine rereads allowed model/profile changes, records config revision and requested/resolved model policy, and keeps prepared attempts unchanged. Other run policy changes require a new run. No setting change establishes a production native adapter.
