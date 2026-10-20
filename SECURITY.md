# Security

ORCH is a local development runtime, not a hardened multi-user service. The current production adapter blocks native worker dispatch pending capability proof. See [safety](references/safety.md) for coordinator behavior.

## Trust boundaries

MCP management mutations require coordinator-token relay, not a supplied role label. The stdio launcher stores the token under `~/.local/state/orch/coordinators/`, keyed by host and invocation origin. It requires a regular file with restricted permissions; `orch_environment` returns its reference. Same-user processes may still read it: this is not OS isolation. Git worktrees share objects/common state and do not sandbox executable tests or malicious repository code.

Verification commands execute local programs and must be explicitly trusted before run creation. Treat project configuration, repository instructions and model output as untrusted inputs. Configuration validation does not make a command safe. Keep `.orch/state/` ignored by Git, restrict local permissions, and never place credentials, raw prompts or environment dumps in reports. Gate output is bounded and redacted before log storage; pattern matching is not a guarantee against every secret format.

Ownership, dirty-state checks, SHA-bound validation/review and expected versions reduce accidental mutation. Preserve data on uncertainty; never force-reset user changes or delete unknown resources. Installation checksum validation detects content changes only relative to the supplied trusted checksum. A locally generated checksum alone does not authenticate a publisher; no remote release-signing guarantee is claimed.

## Reporting

No private security contact or disclosure service is configured. Do not publish secrets or exploit-bearing private data in a public issue. Provide a minimal sanitized reproducer through a repository owner's verified private channel when one is available. No dependency audit, penetration test or native-host security certification is implied by unit test success.
