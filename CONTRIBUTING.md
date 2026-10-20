# Contributing

Read the PRD and current compatibility limits before changing behavior. Use Node 24+ and Git, install locked dependencies with `npm ci`, then run `npm run check`. Use focused `node --test tests/unit/<owner>.test.ts` checks while iterating and `git diff --check` before committing.

Keep changes in the owning package. Treat protocol schemas, callers, fixtures, CLI help and documented commands as one contract. Regenerate protocol schemas with `npm run schema` after schema changes. Tests must isolate HOME/config/state and use disposable Git repositories; never use a developer's actual host settings as fixture output.

Edit common `skills/` and `references/` sources; installation generates host copies. Avoid static model IDs and speculative native role templates. Test packaged reference resolution and actual command parsing rather than snapshotting prose. Evaluate bilingual trigger fixtures in `skills/evaluations.json` with each installed host separately; that human/host behavioral evaluation is not covered by structural tests.

Record real command results and exact SHAs. Keep mocked runtime evidence separate from native-host and OS release evidence. Never remove BLOCKED_CAPABILITY just to make a test pass. Do not change PRD acceptance criteria to hide missing functionality.
