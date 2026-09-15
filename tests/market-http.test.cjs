'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const { fetchMarketPage } = require('../collectors/market/http.cjs');
const url = 'https://trade.500.com/jczq/';
function transport(play) {
  return (_url, _options, callback) => {
    const req = new EventEmitter(); req.destroy = () => { req.destroyed = true; };
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.headers = {}; res.statusCode = 200;
      res.destroy = () => { res.destroyed = true; }; res.complete = true;
      play(req, res, callback);
    });
    return req;
  };
}
test('fetch returns the complete bounded response', async () => {
  const request = transport((req,res,cb) => { cb(res); res.emit('data', Buffer.from('abc')); res.emit('end'); });
  assert.equal((await fetchMarketPage(url, { request })).body.toString(), 'abc');
});
test('403/429 retain Retry-After without reading or exposing block-page contents', async () => {
  const request = transport((req,res,cb) => { res.statusCode = 429; res.headers['retry-after'] = '36000'; cb(res); });
  await assert.rejects(fetchMarketPage(url, { request }), { code: 'SOURCE_BLOCKED', retryAfterSeconds: 36000 });
});
test('oversized chunks are stopped', async () => {
  const request = transport((req,res,cb) => { cb(res); res.emit('data', Buffer.alloc(10)); });
  await assert.rejects(fetchMarketPage(url, { request, maxBytes: 4 }), { code: 'SOURCE_TOO_LARGE' });
});
test('socket never completing still hits the wall-clock deadline', async () => {
  const request = transport((req,res,cb) => { cb(res); });
  await assert.rejects(fetchMarketPage(url, { request, timeoutMs: 15 }), { code: 'SOURCE_TIMEOUT' });
});
test('response truncation settles the promise rather than hanging forever', async () => {
  const request = transport((req,res,cb) => { res.complete = false; cb(res); res.emit('close'); });
  await assert.rejects(fetchMarketPage(url, { request }), { code: 'SOURCE_TRUNCATED' });
});
test('abort before a request prevents any network action', async () => {
  const controller = new AbortController(); controller.abort();
  let requested = false;
  await assert.rejects(fetchMarketPage(url, { signal: controller.signal, request: () => { requested = true; } }), { code: 'COLLECTION_ABORTED' });
  assert.equal(requested, false);
});
test('HTTP redirects are not automatically followed', async () => {
  let count = 0;
  const request = transport((req,res,cb) => { count++; res.statusCode = 302; res.headers.location = 'https://other.example'; cb(res); });
  await assert.rejects(fetchMarketPage(url, { request }), { code: 'SOURCE_HTTP_ERROR' });
  assert.equal(count, 1);
});
