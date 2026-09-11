# Full release fast-result verifier alignment

r728 stopped before application replacement because two static fast-publication
checks still required the removed direct SQLite call in `syncData.cjs`. The real
full-sync path uses `readRuntimeFastResultInput`, including its receipt-only read
inside the sync-meta commit lock. The remaining 102 fast-publication checks passed.

The verifier now checks that actual facade call, the receipt-only option, and the
same lock ordering. A real SQLite crash-recovery fixture is also read through the
facade in a fresh child: the committed receipt and final must match, and receipt-only
mode must return the receipt without finals. The complete 105-check verifier runs
before signing and sequence reservation as well as in production readiness.

Validation: Node 22.22.1 passed all 105 checks on Windows and Linux. The Linux run
used the retained hash-verified r728 source in a separate fixture tree with the
updated verifier, under systemd as football, ProtectSystem=strict, PrivateTmp and
PrivateNetwork. It performed no production writes. The complete pre-sign verifier
contract suite passed 342 checks. These are code-validation results, not deployment
acceptance; the new signed package must still pass normal candidate and live checks.

The failed r728 run restored the existing r718 service, preserved its accepted
runtime marker and left recoveryPending=false. Frozen recommendation continuity,
the original 198 evidence bindings and a new official cycle remain mandatory for
the subsequent successful release. Recommendation risk/admission gates are unchanged.
