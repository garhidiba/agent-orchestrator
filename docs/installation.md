# Installation, update and removal

This checkout is a development source distribution; no published package URL or authenticated remote release is declared. Node.js 24+ (with npm), Git and an installed host are prerequisites. From a trusted checkout, run `./scripts/install.sh` (PowerShell: `./scripts/install.ps1`). This one-command installer bootstraps missing npm dependencies with lifecycle scripts disabled, builds a local bundle, verifies its checksum and installs for detected hosts. Repeat the command to update; content-derived version IDs reuse unchanged releases. Explicit `--bundle` / `--checksum` inputs still use the verified-bundle path below. No remote ORCH release is downloaded.

`--dry-run` leaves host configuration and installation state unchanged, but missing npm dependencies may be installed in the local checkout and a disposable bundle is built then removed. Node/npm themselves are prerequisites, not installed by this script. Consult the advanced management parser with:

```sh
npm run orch:manage -- --help
```

The advanced local bundle interface is `pack --source DIR --bundle DIR --version VERSION`, then `install` or `update` with `--bundle DIR --checksum SHA256 --target auto|codex|claude|both --scope user|project --project DIR`. `--dry-run` previews changes; `--yes` is accepted but never overrides ownership conflicts. SHA256 is the checksum of the bundle’s `release.json`; obtain it from a separately trusted source; generating a checksum from untrusted bytes does not authenticate them. Do not treat example metavariables as commands to run verbatim.

Installation copies the two shared entry skills and references into `.agents/skills/` for Codex or `.claude/skills/` for Claude beneath the user/project base and registers only the managed MCP entry. It must preserve unrelated host config and refuse user-owned skill collisions. Scope controls installation location, not configuration precedence. User installation state defaults to `${XDG_DATA_HOME:-~/.local/share}/orch` (Windows: `%LOCALAPPDATA%/orch`); project state is `<project>/.orch/installation`. Version directories and old data are retained. MCP configuration pins the absolute Node executable and immutable version path; runs pin their original runtimeRoot. Updating the active version does not migrate an in-progress run to new code. Host reload/discovery and actual native execution require separate evidence; successful file installation is not a capability probe.

`uninstall --target codex|claude|both --keep-data` removes only owned host assets and preserves run data. Default removal preserves data as well. Read the dry-run result before removing anything; dirty/unknown/modified assets remain explicit. Do not use uninstall to clean an active worker or unmerged worktree.

Updates use checksum-validated local bundles and managed backups. `rollback --version VERSION` uses a retained version with the same target/scope options; it still validates content and preserves ownership boundaries. Migration failure must preserve the prior installation/configuration and run data. [Recovery](../references/recovery.md) covers interrupted runs. Run-management and bundle-management parser options are separate; the conversation entry does not require an external `orch run` command.

The management help was checked against the implementation on 2026-10-20. Actual parser help and focused installer tests are the authority; OS and native-host installation acceptance remain [not verified](compatibility.md).

Bundles record platform/architecture and include the pinned installed production dependency closure. They reject missing required modules, unsafe links and unsupported cross-platform native content; optional-package omissions are recorded. A bundle built on one platform is not evidence that its dependencies run on another. The installer returns `NEEDS_RELOAD`, `UNVERIFIED`, `CONFIGURED_NOT_HANDSHAKE_VERIFIED` and `NOT_CHECKED` for reload/execution/MCP handshake/authentication respectively. No automatic login or inference is performed.
