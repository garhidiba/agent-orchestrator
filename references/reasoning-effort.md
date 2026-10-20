# Reasoning effort

Use each catalog entry's supported efforts and default; the vocabulary is host/model specific. `null` support means unknown, while an empty list means explicitly unsupported. Omit effort for a model that does not accept it. Reject unsupported explicit values before save or dispatch.

For `auto`, begin with the verified default. Consider a supported increase for difficult planning, security/data integrity, concurrency or repeated reasoning failures. Diagnose environment, specification and dependencies before raising effort. Lower effort only when task evidence supports adequate quality. Preserve a user's fixed setting.

Keep requested/resolved/observed distinct. Report policy clamping and `NEEDS_RELOAD`; an unobserved request is not an applied value. Running attempts retain their configuration revision. Do not interrupt a worker to apply a recommendation.
