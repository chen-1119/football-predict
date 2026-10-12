# Trained cutover readiness diagnostics

r821 failed before live cutover and rolled back normally. Its candidate verifier
reported only `false !== true`. A subsequent read-only r819 health observation
also failed list/detail projection parity: one started event lacked an immutable
archive. This later observation is not the missing candidate health response and
does not prove a unique cause of the original assertion.

The verifier now reports exact failing gates and safe aggregate projection counts.
All PostgreSQL, result-integrity, projection-parity, reference-only and publication
identity requirements remain unchanged. A missing archive still rejects release;
no predictions, source clocks, archive contents or settlements are repaired here.
Natural production publication must resolve its inputs before another release
can be accepted. The new diagnostics are not a model promotion or a bypass.
