# Verification status glossary

These meanings apply to ORCH reports and completion claims. A status must name its requirement, source revision, command or host scenario, and evidence location.

| Term | Meaning | Does not mean |
|---|---|---|
| Configuration saved | A validated, authorized file change passed atomic write and effective-config readback. | The current conversation changed model, or a worker can apply the setting. |
| Contract tested | A named deterministic test passed at a stated source revision, including any synthetic host receipts. | The real host supplied those capabilities or completed that workflow. |
| Host E2E verified | The named installed host completed the stated native workflow at recorded settings and SHAs, with actual lifecycle/gate/review evidence. Unknown backend observations stay null. | Other hosts, unexercised role settings, failure paths, or all PRD requirements passed. |
| Open runtime failure | A reported or reproduced real workflow contradicts the intended behavior. | Earlier test passes close or override this failure. |
| PRD complete | Every required acceptance condition and release gate has current sufficient evidence; required unrun or blocked cases remain incomplete. | A test count, fixture pass, installation READY, or a completed single smoke run. |

`CODE_AND_LOCAL_CHECKS_PASSED` in the historical audit records is local checkpoint evidence only. It is not a current acceptance or release status.
