# Existing research sources and quota

## Actual account observation

At 2026-10-14 16:23 Beijing time, the existing server's API-Football status
endpoint returned Free, active, 80 used / 100 daily calls, 20 remaining,
and a limit of 10 calls per minute. This is a timestamped observation, not
a promise that the remaining allowance will stay unchanged. No key or account
personal details were exported. No new model service or paid subscription was enabled.

The official published Free plan is 100 calls per day and 10 per minute.
Daily allowances reset at 00:00 UTC, or 08:00 Beijing time. The listed entry
paid plan is USD 19 per month / 7,500 calls daily; upgrading is not part of this work.

Sources read: <https://api-sports.io/sports/football> and
<https://www.api-football.com/news/post/how-to-optimize-api-sports-calls-and-quota-usage>.

## Collector protection candidate

Daily `x-ratelimit-requests-remaining` and minute `X-RateLimit-Remaining` are
separate. The collector retains its existing per-sync attempt ceiling of 12.
It reserves known daily allowance before a data request, counts transport
failures conservatively, and persists a monotonically decreasing allowance
within the provider's UTC day. A cached higher observation cannot refund calls.
Missing or invalid quota observations refuse data requests; `/status` remains
available within the same per-sync ceiling. The next UTC day requires a new
provider observation. A changed credential must perform its own preflight.

Free-plan requests are spaced at least 6 seconds apart. A depleted minute
allowance enters the existing minute cooldown instead of declaring the entire
daily quota exhausted. Normal cache/deduplication remains in place.

This does not implement a shared budget for unrelated applications using the
same provider key. Their consumption may only become visible in the next
provider response. Conservatively counting failed attempts can under-use the
allowance; it does not authorize retries, buying quota, or fetching missing data
through a second writer. The code remains a candidate until normal signed deployment.

## Research facts and website reading

- The existing Sporttery collector supplies official event identity, HAD/HHAD
  SP, actual cutoff and 90-minute settlement data. External bookmaker odds do
  not replace official SP.
- API-Football remains shadow enrichment with the original exact team/fixture
  identity and committed evidence checks. Coverage is verified per league and
  season; an advertised endpoint does not establish a record for every match.
- UEFA, MLS and ge.globo football pages were actually readable during this
  check. Use specific league or club articles for news, injuries and match
  reports, recording URL, publication/event time, observation time and body hash.
- 500 live returned HTTP 567. No access-control bypass or summary-only evidence
  substitutes for reading the page. Keep unavailable fields explicitly unverified.
- Current open-research discovery has a 30-minute cache, 2 concurrent requests,
  4 matches and 8 results configured. Search metadata is not complete team
  evidence; standings, recent form and H2H still require two independent sources.

The server has no configured text-research model API. Its existing GPT review
relay is also disabled and limited to explanations, not direction generation.
Free website access provides facts; it does not itself provide a server reasoning
model or permission for dot to access production. These components and actual
offline acceptance remain necessary before retiring local research schedules.
