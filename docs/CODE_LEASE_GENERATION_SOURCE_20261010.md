# Code cutover lease input

r827 failed before switching because the pre-stop lease used the mutable APP `matches-current.json`, while the code seed used the PostgreSQL-bound immutable generation. The retained observation reproduced the expected lease digest from the APP file and the rejected digest from the seed. Eighteen current rows had different clock fields; this is not evidence that the candidate server mutated the seed.

The code lane now captures its lease input through the existing protected PostgreSQL read session before stopping services. The generation identity and manifest-verified current bytes are saved create-only in the native transaction directory. Seed capture requires the same generation ID, manifest hash, source cycle and commit time. A generation advance rejects the attempt, even if its schedule happens to look identical.

The 900-second elapsed budget starts before this capture. The original 300/570/30 lease, subsequent exact transition checks, candidate checks, final database consistency and recovery behavior remain. The database-migration lane is unchanged. There is no database copy, forced synchronization, pointer mutation or live application patch.

Validation: 104 joint code-release, staged-release and reviewed-analysis tests passed with zero skips; immutable file tampering, wrong generation and oversized input are rejected. Existing real Bash dispatch fixtures and scoped lint passed. A successful test is not evidence of deployment or recommendation publication.
