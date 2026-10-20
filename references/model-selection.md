# Model selection

Use the current host's same-context catalog. Advertised support, confirmed account access, availability and observed execution are separate evidence. A model name prefix or a complete provider API list cannot establish host support.

Start with the host default when evidence is weak. `balanced`, `quality`, `economy` and `fast` express goals, not a hardcoded model ranking. Choose capabilities for the task: planning and review need reasoning appropriate to complexity; repetitive implementation needs demonstrated adequate quality. Preserve explicit overrides. Change `auto` fields only, record reason, affected attempt, config revision and any observed budget impact.

Query every available catalog page; preserve lookup errors and stale-cache provenance. Context mismatch or unknown access prevents claiming verified selection. Do not probe every candidate with billable requests. No catalog means no invented recommendation. Resolve `auto` before dispatch and represent `inherit` as parent policy when the actual parent ID is unavailable.

Record requested, resolved and observed model/effort independently. Unknown actual model, tokens or price stays null. A test fixture's verified capability is not production host proof. Never reduce required tests/review or switch providers as a usage optimization.

The current registry persists unknown-scope disk metadata under the ORCH global config directory’s `cache/models/unknown/<host>/`. Its key includes executable/version, origin and local settings/environment fingerprints, but account/workspace/policy identity remains unknown. `source`, `stale`, fetch/expiry timestamps and `errors` distinguish live/cache/failure. `refresh=true` requests a refresh; a failed refresh may return stale cached entries with the failure. Cache presence never promotes `contextMatches=false` to a current-session match.
