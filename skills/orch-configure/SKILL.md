---
name: orch-configure
description: Explain, configure or optimize ORCH role models, reasoning effort, profiles and execution settings for the current project or an explicitly requested global scope. Use for ORCH quality, speed or usage optimization; exclude settings of unrelated tools.
---

# ORCH Configuration Advisor

Keep the current session as coordinator and preserve the active host. Explanation requests produce guidance only; an optimization request authorizes only its stated configuration scope.

1. Read [configuration](references/configuration.md), [model selection](references/model-selection.md) and [effort](references/reasoning-effort.md). Read [project analysis](references/project-analysis.md) when recommending for a project.
2. Obtain `orch_environment`, `orch_config` with `action=effective`, and `orch_models`. Inspect provenance, context match, access, expiry and errors. Missing or mismatched evidence limits recommendations; never invent IDs, effort support, prices or actual usage.
3. Use the user's goal or explain the `balanced` default. Preserve concrete model/effort overrides and change only `auto` fields unless the user explicitly changes a fixed value. Resolve only within this host's validated catalog. Distinguish a schema-valid patch from a model executable in the current host.
4. Produce a recommendation with scope, host, config revision/hash, proposed patch, role selections (model, effort, reasons, evidence references, confidence), preserved overrides, warnings and approval requirement. Explain-only requests stop here. Unknown choices remain unresolved.
5. Apply an authorized patch through the actual `orch_config` schema with the selected scope and fresh expected file hash. Use `unset` to remove an override. For session scope, use `hashes.session`; the applied layer lasts only for this MCP server process and is not a file setting. Use `dry_run=true` when a preview is requested. Global changes require an explicit global request; never weaken permissions, required review or host boundaries. If the current adapter rejects a model edit, report the rejection and keep the prior settings.
6. Reread effective config and report before/after values and field sources. New settings affect future workers; keep running attempts unchanged. Report requested/resolved/observed separately, using null for unavailable observations and `NEEDS_RELOAD` when the host requires it. Configuration success does not prove native dispatch support.

Installed `references/` content is generated from the shared release source.
