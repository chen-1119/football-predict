# Completing cloud production access and publication

## Platform permission

The original dot audit found no permission for `134.175.132.183:443`, no
confirmed removal of the old CONNECT 403, and no network-policy editing tool.
The two public article reads on 2026-10-14 prove website reading only.
No fresh request to the denied production destination has been made.

For a managed workspace, the official control location is Admin Console →
Permissions & roles → Workspace capabilities → Cloud computer capabilities.
Cloud network access and Cloud browser use are distinct controls. An administrator
must verify the effective permission for the intended task and production target.
Enabling a capability alone is not proof that an IP-specific refusal is removed.
If this console or the target permission is unavailable, platform support must
resolve the denied destination. There is no confirmed self-service IP allowlist
editor available in this session.

Official references:
- <https://learn.chatgpt.com/docs/enterprise/chatgpt-work-cloud-security>
- <https://help.openai.com/en/articles/6614161-how-can-i-contact-support>

The following support request was submitted and escalated to a support
specialist on 2026-10-14. No case number or production-IP approval has been
confirmed. Do not submit it again or treat the desktop proxy restart as cloud
network permission:

> My dot cloud task needs authorized HTTPS access to my production server
> 134.175.132.183 on port 443. The original cloud connection returned
> “Tunnel connection failed: 403 Forbidden” before any server HTTP response.
> The current task allowlist does not contain this target. Please identify the
> applicable network rule and the formal process for permitting this destination.
> The planned scope is independently authenticated read/report/publish endpoints,
> with the existing session, signed input, cutoff and deployment-mutex controls.

## Server work and acceptance

| Route | Scope | Current status |
| --- | --- | --- |
| GET `/api/operator/research/day` | Existing publication index | Included in r863 |
| GET `/api/operator/research/artifact` | Original record/signature/ACK replay | Included in r863 |
| GET `/api/operator/research/official` | Complete current/calculator signed inputs | Included in r863 |
| POST `/api/operator/research/report` | Original create-only report archive | HTTP wired in r868; signed broker installation pending |
| POST `/api/operator/research/report-read` | Exact report/hash readback | HTTP wired; actual broker caller acceptance pending |
| POST `/api/operator/research/publish` | Original v3 exact-draft controlled publication | HTTP wired; actual signed broker/publish/ACK acceptance pending |
| POST `/api/operator/research/publication-read` | Record plus second ACK readback | HTTP wired; actual broker caller acceptance pending |

Before accepting the POST routes as operational, complete the separate normal
signed broker installation. Verify the root-owned installed binding, signature,
Node image, complete source closure, API process identity and inherited real
`/run/lock/football-release.lock`. Keep the release mutex until the actual child
exits. Publication reuses the original signed official identity/market/SP/cutoff
checks and second-transaction ACK. Report storage does not upgrade source truth
or prediction eligibility. No schema migration or additional collector is required.

Run new-head isolated Linux/PostgreSQL integration tests, independent source
review and normal signed installation. Then verify actual installed source/dist,
public TLS and the required natural cycle. Today's already published references
are immutable; they are not republished for testing.

## Cloud and workstation-offline acceptance

1. Obtain formal network permission, refresh the dot cloud environment, and
   perform one normal TLS access check. A renewed refusal stops that source.
2. Use an independent hosted login with the existing operator/admin account.
   Never export a desktop browser cookie, SSH key or collector signing key.
3. Read production identity, existing report/publication state and signed inputs.
   Archive a real new scheduled report and read exact original bytes/hash.
   For a genuinely new eligible event, verify normal publication, second ACK,
   natural projection and page reference. Unknown COMMIT is read before retry.
4. Only after the complete cloud path passes, pause local automation-5 and -7,
   confirm their prior running/queued executions have ended, then enable the
   two original dot schedule IDs. Do not add duplicate schedules.
5. Record a real workstation-offline interval. During it, verify a new server
   natural collection/PG cycle and an actual dot scheduled research report with
   server receipt. This has not occurred and is not proven by architecture alone.

Original dot IDs remain `6abf7f1911dc8191a0ba3fe47f657dc5` and
`6abf7f19fa888191aee9d6f51cc6186c`. They remain paused until acceptance;
the original local schedules remain active meanwhile. Server collection
continues in the existing sole worker. No new paid model API is enabled.
