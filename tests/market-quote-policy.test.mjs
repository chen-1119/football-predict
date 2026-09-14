import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMatchQuotes, normalizeQuoteOdds, parseResultHandicap, quoteInstant } from '../src/services/marketQuotePolicy.ts';
const nowMs = Date.parse('2026-09-14T10:00:00Z');
const odds = { odds1: 2.1, oddsX: 3.2, odds2: 3.4 };
const match = { id: 'sporttery_1', kickoffTime: '2026-09-14T12:00:00Z' };
const external = { source: '500.com:jczq', updatedAt: '2026-09-14T09:59:00Z', bookmakerOdds: { had: odds } };

test('external fallback keeps its own source and time, never stale official metadata', () => {
  const result = resolveMatchQuotes({ ...match, odds: null, oddsSource: 'sporttery:had',
    oddsUpdatedAt: '2026-09-14T09:00:00Z', externalSignals: external }, { nowMs });
  assert.equal(result.had.source, '500.com:jczq');
  assert.equal(result.had.updatedAt, '2026-09-14T09:59:00.000Z');
  assert.equal(result.had.provenance, 'reference');
});
test('invalid first external candidate does not suppress a valid API candidate', () => {
  const result = resolveMatchQuotes({ ...match, externalSignals: { ...external,
    bookmakerOdds: { had: { odds1: 0 }, apiFootball: { had: odds, source: 'api-football', updatedAt: external.updatedAt } } } }, { nowMs });
  assert.equal(result.had.source, 'api-football');
});
test('an external handicap never borrows the official handicap', () => {
  const result = resolveMatchQuotes({ ...match, handicapLine: '-2', externalSignals: {
    ...external, handicapLine: '-1', bookmakerOdds: { hhad: odds } } }, { nowMs });
  assert.equal(result.hhad.handicap, '-1');
  assert.equal(resolveMatchQuotes({ ...match, handicapLine: '-2', externalSignals: {
    ...external, bookmakerOdds: { hhad: odds } } }, { nowMs }).hhad, undefined);
});
test('zero is explicit, missing is unknown, fractional Asian handicaps are not HHAD', () => {
  for (const value of [undefined, null, '', ' ', true, [], 'home -1', '-0.5', '1/2']) assert.equal(parseResultHandicap(value), null);
  for (const value of [0, '0', '-0', '+0.0']) assert.equal(parseResultHandicap(value), 0);
  assert.equal(parseResultHandicap('−1'), -1);
});
test('odds reject booleans, arrays, missing values, malformed strings and prices <= 1', () => {
  for (const value of [null, undefined, '', ' ', true, [], Infinity, NaN, 1, '2abc', '0x20'])
    assert.equal(normalizeQuoteOdds({ ...odds, odds1: value }), null);
  assert.deepEqual(normalizeQuoteOdds({ odds1: '2.10', oddsX: '3.20', odds2: '3.40' }), odds);
});
test('generic externalOdds needs an explicit market marker', () => {
  const result = resolveMatchQuotes({ ...match, externalSignals: { source: '500', updatedAt: external.updatedAt,
    handicapLine: '-1', externalOdds: odds } }, { nowMs });
  assert.equal(result.had, undefined); assert.equal(result.hhad, undefined);
});
test('HHAD-only never fills the HAD lane', () => {
  const result = resolveMatchQuotes({ ...match, externalSignals: { ...external, handicapLine: '-1',
    bookmakerOdds: { hhad: odds } } }, { nowMs });
  assert.equal(result.had, undefined); assert.ok(result.hhad);
});
test('future observations, timezone-less timestamps and invalid calendar days are rejected', () => {
  for (const updatedAt of ['2026-09-14T10:00:01Z', '2026-09-14T09:00:00', '2026-02-30T00:00:00Z']) {
    assert.equal(resolveMatchQuotes({ ...match, externalSignals: { ...external, updatedAt } }, { nowMs }).had, undefined);
  }
  assert.equal(quoteInstant('2026-09-14T18:00:00+08:00'), nowMs);
});
test('event mismatch and manually mapped site ID mismatch are rejected without equating provider IDs', () => {
  for (const context of [{ kickoffTime: '2026-09-15T12:00:00Z' }, { siteMatchId: 'sporttery_2' }]) {
    assert.equal(resolveMatchQuotes({ ...match, externalSignals: { ...external, ...context } }, { nowMs }).had, undefined);
  }
  assert.ok(resolveMatchQuotes({ ...match, externalSignals: { ...external, sourceMatchId: '999999' } }, { nowMs }).had);
});
test('official-only cannot adopt external evidence even when it claims an official source', () => {
  const input = { ...match, externalSignals: { ...external, source: 'sporttery:had' } };
  assert.equal(resolveMatchQuotes(input, { nowMs }).had, undefined);
  assert.equal(resolveMatchQuotes({ ...match, externalSignals: external }, { nowMs, officialOnly: true }).had, undefined);
});
test('freshness-first is explicit; archive selection does not silently replace the official record', () => {
  const input = { ...match, odds, oddsSource: 'sporttery:had', oddsUpdatedAt: '2026-09-14T08:00:00Z', externalSignals: external };
  assert.equal(resolveMatchQuotes(input, { nowMs }).had.provenance, 'official');
  assert.equal(resolveMatchQuotes(input, { nowMs, preferFresh: true }).had.provenance, 'reference');
});
test('missing timestamps remain unknown and cannot pass a strict fresh or prematch gate', () => {
  const input = { ...match, odds, oddsSource: 'sporttery:had' };
  assert.equal(resolveMatchQuotes(input, { nowMs }).had.freshness, 'unknown');
  assert.equal(resolveMatchQuotes(input, { nowMs, requireFresh: true }).had, undefined);
  assert.equal(resolveMatchQuotes(input, { nowMs, prematchOnly: true }).had, undefined);
});
test('exact kickoff observations are not prematch and explicit as-of cannot leak a later quote', () => {
  const input = { ...match, odds, oddsSource: 'sporttery:had', oddsUpdatedAt: match.kickoffTime };
  assert.equal(resolveMatchQuotes(input, { nowMs: nowMs + 3 * 3600_000, prematchOnly: true }).had, undefined);
  assert.equal(resolveMatchQuotes({ ...match, externalSignals: external }, { asOf: '2026-09-14T09:58:00Z' }).had, undefined);
});
test('line mismatch is rejected when the caller requests an exact handicap', () => {
  assert.equal(resolveMatchQuotes({ ...match, handicapOdds: odds, handicapLine: '-1', handicapOddsSource: 'sporttery:hhad' },
    { nowMs, expectedHandicap: '-2' }).hhad, undefined);
});
test('candidate selection is deterministic and does not mutate input', () => {
  const input = { ...match, externalSignals: structuredClone(external) };
  const previous = structuredClone(input);
  assert.deepEqual(resolveMatchQuotes(input, { nowMs }), resolveMatchQuotes(input, { nowMs }));
  assert.deepEqual(input, previous);
  assert.throws(() => resolveMatchQuotes(input, { nowMs: NaN }), TypeError);
});
