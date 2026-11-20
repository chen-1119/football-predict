"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const api = require("../scripts/syncApiFootballData.cjs");

const account = (remaining = 20, rateLimit = {}) => api.normalizeAccountStatus({
  response: {
    account: { status: "active" }, subscription: { plan: "Free", active: true },
    requests: { current: 100 - remaining, limit_day: 100 },
  },
}, { checkedAt: new Date().toISOString(), rateLimit });

const cacheWithQuota = remaining => {
  const cache = api.createCache();
  cache.apiAccess.status = account(remaining);
  return cache;
};

test("minute headers cannot replace the daily quota", () => {
  for (const remaining of [0, 1, 9]) {
    const status = account(20, { limit: 10, remaining });
    assert.equal(status.quota.remaining, 20);
    assert.equal(status.eligible, true);
  }
});

test("conflicting daily observations use the lower value", () => {
  assert.equal(account(20, { requestsRemaining: 50 }).quota.remaining, 20);
  assert.equal(account(20, { requestsRemaining: 3 }).quota.remaining, 3);
});

test("malformed quota headers are not parsed as available calls", () => {
  for (const value of ["20 calls", "2.5", "-1", "Infinity", "", "2e3"]) {
    assert.equal(account(20, { requestsRemaining: value }).quota.remaining, 20);
  }
});

test("20 observed calls cannot become 24 across two 12-attempt syncs", () => {
  const cache = cacheWithQuota(20);
  const first = api.createRequestBudget(12);
  for (let i = 0; i < 12; i += 1) api.reserveRequestAttempt(cache, first, "/fixtures");
  assert.equal(api.currentDailyQuota(cache).remaining, 8);
  assert.throws(() => api.reserveRequestAttempt(cache, first, "/fixtures"), /MAX_CALLS_PER_SYNC/);
  const second = api.createRequestBudget(12);
  for (let i = 0; i < 8; i += 1) api.reserveRequestAttempt(cache, second, "/injuries");
  assert.throws(() => api.reserveRequestAttempt(cache, second, "/injuries"), { code: "API_FOOTBALL_DAILY_QUOTA_EXHAUSTED" });
  assert.equal(second.attempts, 8);
  assert.equal(cache.requestLedger.count, 20);
});

test("cache serialization does not replenish the observed quota", () => {
  const cache = cacheWithQuota(2);
  api.reserveRequestAttempt(cache, api.createRequestBudget(), "/fixtures");
  const restored = api.normalizeCache(JSON.parse(JSON.stringify(cache)));
  api.reserveRequestAttempt(restored, api.createRequestBudget(), "/injuries");
  assert.throws(() => api.reserveRequestAttempt(restored, api.createRequestBudget(), "/fixtures"), { code: "API_FOOTBALL_DAILY_QUOTA_EXHAUSTED" });
});

test("older or higher observations do not refund reserved attempts", () => {
  const cache = cacheWithQuota(20);
  api.reserveRequestAttempt(cache, api.createRequestBudget(), "/fixtures");
  assert.equal(api.observeDailyQuota(cache, 20).remaining, 19);
  assert.equal(api.observeDailyQuota(cache, 50).remaining, 19);
  assert.equal(api.observeDailyQuota(cache, 5).remaining, 5);
});

test("invalid and future quota clocks cannot authorize a data request", () => {
  const cache = cacheWithQuota(20);
  delete cache.apiAccess.status.checkedAt;
  assert.equal(api.currentDailyQuota(cache), null);
  cache.apiAccess.status.checkedAt = new Date(Date.now() + 60000).toISOString();
  assert.equal(api.currentDailyQuota(cache), null);
  assert.throws(() => api.reserveRequestAttempt(cache, api.createRequestBudget(), "/fixtures"), { code: "API_FOOTBALL_DAILY_QUOTA_UNVERIFIED" });
});

test("UTC midnight requires a new observation instead of carrying yesterday's allowance", () => {
  const cache = api.createCache();
  const prior = Date.parse("2026-10-14T23:59:00.000Z");
  api.observeDailyQuota(cache, 2, { now: prior });
  const next = Date.parse("2026-10-15T00:00:01.000Z");
  assert.equal(api.currentDailyQuota(cache, next), null);
  assert.equal(api.observeDailyQuota(cache, 100, { now: next }).remaining, 100);
  assert.equal(api.observeDailyQuota(cache, 200, { now: prior, checkedAt: new Date(next).toISOString() }), null);
});

test("a changed credential discards its old account quota", () => {
  const cache = cacheWithQuota(1);
  cache.apiAccess.credentialFingerprint = "old";
  api.currentDailyQuota(cache);
  assert.equal(api.synchronizeCredentialState(cache, "new").changed, true);
  assert.equal(api.currentDailyQuota(cache), null);
});

test("daily reset refreshes quota while preserving the original suspension cooldown", () => {
  const checkedAt = "2026-10-14T23:59:00.000Z";
  const next = Date.parse("2026-10-15T00:00:01.000Z");
  assert.equal(api.canReuseAccountStatus({ checkedAt, eligible: true }, next), false);
  assert.equal(api.canReuseAccountStatus({ checkedAt, eligible: false, blockers: ["provider-quota-unavailable"] }, next), false);
  const suspended = { checkedAt, eligible: false, suspended: true, blockers: ["account-suspended"] };
  assert.equal(api.canReuseAccountStatus(suspended, next), true);
  assert.equal(api.canReuseAccountStatus(suspended, next + 24 * 3600000), false);
  assert.equal(api.canReuseAccountStatus({ checkedAt: new Date(next + 1).toISOString(), eligible: true }, next), false);
});

test("status attempts still use the original per-sync ceiling but not the data allowance", () => {
  const cache = cacheWithQuota(1);
  const budget = api.createRequestBudget(2);
  api.reserveRequestAttempt(cache, budget, "/status");
  api.reserveRequestAttempt(cache, budget, "/fixtures");
  assert.equal(api.currentDailyQuota(cache).remaining, 0);
  assert.throws(() => api.reserveRequestAttempt(cache, budget, "/status"), /MAX_CALLS_PER_SYNC/);
});

test("Free plan spacing cannot be disabled with a zero interval setting", () => {
  const cache = cacheWithQuota(20);
  assert.equal(api.requestIntervalFor(cache, { API_FOOTBALL_MIN_REQUEST_INTERVAL_MS: "0" }), 6000);
  assert.equal(api.requestIntervalFor(cache, { API_FOOTBALL_MIN_REQUEST_INTERVAL_MS: "10000" }), 10000);
  cache.apiAccess.status.rateLimit.limit = 5;
  assert.equal(api.requestIntervalFor(cache, {}), 12000);
});

test("real transport failures spend the observed allowance and block before sending again", async () => {
  const original = https.request;
  let sent = 0;
  https.request = () => { sent += 1; throw new Error("test transport failure"); };
  try {
    const cache = cacheWithQuota(1);
    const budget = api.createRequestBudget(12);
    await assert.rejects(api.apiGet(cache, "/fixtures", {}, budget), /test transport failure/);
    await assert.rejects(api.apiGet(cache, "/fixtures", {}, budget), { code: "API_FOOTBALL_DAILY_QUOTA_EXHAUSTED" });
    assert.equal(sent, 1);
    assert.equal(budget.attempts, 1);
  } finally { https.request = original; }
});

test("a zero minute response sets a minute cooldown, not daily exhaustion", async () => {
  const original = https.request;
  https.request = (_url, _options, onResponse) => {
    const request = new EventEmitter();
    request.end = () => {
      const response = new EventEmitter();
      response.headers = { "x-ratelimit-limit": "10", "x-ratelimit-remaining": "0", "x-ratelimit-requests-remaining": "19" };
      response.statusCode = 200;
      response.setEncoding = () => {};
      onResponse(response);
      response.emit("data", JSON.stringify({ errors: [], response: [] }));
      response.emit("end");
      request.emit("close");
    };
    request.destroy = error => request.emit("error", error);
    return request;
  };
  try {
    const cache = cacheWithQuota(20);
    // Avoid waiting in this mocked transport test; the pure interval test covers pacing.
    cache.apiAccess.status.plan = "test";
    await api.apiGet(cache, "/fixtures", {}, api.createRequestBudget());
    assert.deepEqual(cache.apiAccess.status.blockers, ["provider-minute-rate-limit"]);
    assert.equal(cache.apiAccess.requestQuota.remaining, 19);
    assert.equal(api.statusRefreshMinutesFor(cache.apiAccess.status), 1);
  } finally { https.request = original; }
});
