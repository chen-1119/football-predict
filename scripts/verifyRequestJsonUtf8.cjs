"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { readRequestJson } = require("../server/readRequestJson.cjs");

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const deadline = (promise) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("request verifier deadline exceeded")), 3000);
  })]).finally(() => clearTimeout(timer));
};

class RequestStream extends EventEmitter {
  constructor() { super(); this.complete = false; this.destroyed = false; this.destroyCalls = 0; }
  destroy(error) {
    this.destroyCalls += 1;
    this.destroyed = true;
    queueMicrotask(() => { if (error) this.emit("error", error); this.emit("close"); });
  }
}

async function readChunks(chunks, maxBytes) {
  const req = new RequestStream();
  const result = readRequestJson(req, maxBytes);
  const observed = result.then(value => ({ value }), error => ({ error }));
  for (const chunk of chunks) req.emit("data", chunk);
  req.complete = true;
  req.emit("end");
  return { req, ...(await deadline(observed)) };
}

async function verifyRequestJsonUtf8() {
  const checks = [];
  const check = async (name, run) => {
    await run();
    checks.push({ name, ok: true });
  };
  const value = { home: "尤文图斯", away: "中国", marker: "😀𐀀", nested: ["汉", 3] };
  const payload = Buffer.from(JSON.stringify(value));

  await check("actual server imports the tested byte reader instead of concatenating Buffer chunks", () => {
    const source = fs.readFileSync(path.join(__dirname, "../server/index.cjs"), "utf8");
    assert.ok(source.includes('const { readRequestJson } = require("./readRequestJson.cjs");'));
    assert.ok(!source.includes("const readRequestJson = (req,"));
    assert.ok(source.includes("await readRequestJson(req, maxBytes)"));
  });
  await check("normal full bundle requires and verifies the byte reader before sequence reservation", () => {
    const source = fs.readFileSync(path.join(__dirname, "createReleaseBundle.cjs"), "utf8");
    const verifier = source.indexOf('const requestJsonUtf8 = spawnSync(process.execPath, ["scripts/verifyRequestJsonUtf8.cjs"]');
    assert.ok(verifier >= 0 && verifier < source.indexOf("const sequenceReservation = reserveReleaseSequence("));
    assert.ok(source.includes('if (requestJsonUtf8.status !== 0)'));
    assert.ok(source.includes('"server/readRequestJson.cjs",'));
    assert.ok(source.includes('"scripts/verifyRequestJsonUtf8.cjs",'));
  });
  await check("old per-chunk coercion reproduces damaged Chinese under a valid byte split", () => {
    const split = payload.indexOf(Buffer.from("文")) + 1;
    let oldBody = "";
    for (const chunk of [payload.subarray(0, split), payload.subarray(split)]) oldBody += chunk;
    assert.ok(JSON.parse(oldBody).home.includes("\uFFFD"));
    assert.notEqual(JSON.parse(oldBody).home, value.home);
  });
  for (let split = 0; split <= payload.length; split += 1) {
    await check(`UTF-8 Chinese and four-byte characters survive byte boundary ${split}`, async () => {
      const result = await readChunks([payload.subarray(0, split), payload.subarray(split)], payload.length);
      assert.ifError(result.error);
      assert.deepEqual(result.value, value);
      assert.equal(result.req.destroyCalls, 0);
    });
  }
  await check("every byte can arrive as a separate chunk", async () => {
    const result = await readChunks(Array.from(payload, byte => Buffer.from([byte])), payload.length);
    assert.ifError(result.error);
    assert.deepEqual(result.value, value);
  });
  for (const text of ["", "{bad json", "\uFEFF{}", "null", "0", "false", "[]", '{"v":"\\ud800"}']) {
    await check(`existing empty or safe JSON fallback preserved for ${JSON.stringify(text)}`, async () => {
      let expected = {};
      if (text) { try { expected = JSON.parse(text); } catch { /* original fallback */ } }
      const result = await readChunks([Buffer.from(text)]);
      assert.ifError(result.error);
      assert.deepEqual(result.value, expected);
    });
  }
  for (const text of ['{"v":"abcd"}', '{"v":"汉😀"}']) {
    const bytes = Buffer.from(text);
    await check(`true byte limit accepts exact ${bytes.length} bytes for ${text}`, async () => {
      const result = await readChunks([bytes.subarray(0, 4), bytes.subarray(4)], bytes.length);
      assert.ifError(result.error);
      assert.deepEqual(result.value, JSON.parse(text));
    });
    await check(`true byte limit rejects ${bytes.length} bytes at ${bytes.length - 1} for ${text}`, async () => {
      const result = await readChunks([bytes.subarray(0, 4), bytes.subarray(4)], bytes.length - 1);
      assert.equal(result.error?.message, "request body too large");
      assert.equal(result.req.destroyCalls, 1);
    });
  }
  await check("byte count closes the old multibyte character-limit gap", async () => {
    const text = '{"v":"汉汉汉"}', bytes = Buffer.from(text);
    assert.ok(bytes.length > text.length);
    const result = await readChunks([bytes], text.length);
    assert.equal(result.error?.message, "request body too large");
  });
  const invalidUtf8 = [
    [0x80], [0xc0, 0xaf], [0xc2, 0x20], [0xe0, 0x80, 0x80],
    [0xed, 0xa0, 0x80], [0xf0, 0x80, 0x80, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xff],
  ];
  for (const invalid of invalidUtf8) {
    const bytes = Buffer.concat([Buffer.from('{"v":"'), Buffer.from(invalid), Buffer.from('"}')]);
    await check(`malformed UTF-8 ${Buffer.from(invalid).toString("hex")} never becomes legal replacement JSON`, async () => {
      assert.doesNotThrow(() => JSON.parse(bytes.toString("utf8")));
      const result = await readChunks(Array.from(bytes, byte => Buffer.from([byte])));
      assert.equal(result.error?.message, "request body contains invalid UTF-8");
      assert.equal(result.req.destroyCalls, 1);
    });
  }
  for (const tail of [[0xc2], [0xe4], [0xe4, 0xb8], [0xf0], [0xf0, 0x9f], [0xf0, 0x9f, 0x98]]) {
    await check(`truncated UTF-8 tail ${Buffer.from(tail).toString("hex")} rejects at end rather than falling back`, async () => {
      const result = await readChunks([Buffer.from('{"v":"'), Buffer.from(tail)]);
      assert.equal(result.error?.message, "request body contains invalid UTF-8");
      assert.equal(result.req.destroyCalls, 1);
    });
  }
  await check("valid encoded replacement character is preserved, not guessed into a team name", async () => {
    const result = await readChunks([Buffer.from('{"v":"�"}')]);
    assert.ifError(result.error);
    assert.deepEqual(result.value, { v: "�" });
  });
  await check("Uint8Array byte chunks are decoded without implicit string coercion", async () => {
    const result = await readChunks([new Uint8Array(payload)]);
    assert.ifError(result.error);
    assert.deepEqual(result.value, value);
  });
  await check("already-decoded strings cannot conceal invalid original UTF-8", async () => {
    const result = await readChunks(['{"v":"汉"}']);
    assert.equal(result.error?.message, "request body must be a byte stream");
  });
  for (const limit of [-1, 1.5, NaN, Infinity]) {
    await check(`invalid byte limit ${String(limit)} fails closed`, async () => {
      const result = await readChunks([Buffer.from("{}")], limit);
      assert.equal(result.error?.message, "invalid request body byte limit");
      assert.equal(result.req.destroyCalls, 1);
    });
  }
  await check("zero byte limit accepts empty input and rejects nonempty input", async () => {
    assert.deepEqual((await readChunks([], 0)).value, {});
    assert.equal((await readChunks([Buffer.from(" ")], 0)).error?.message, "request body too large");
  });
  for (const event of ["aborted", "error", "close"]) {
    await check(`${event} before end rejects once and later data/end/error cannot resolve`, async () => {
      const req = new RequestStream();
      let resolved = 0, rejected = 0;
      const original = new Error("synthetic incoming request error");
      const observed = readRequestJson(req).then(value => { resolved += 1; return { value }; }, error => { rejected += 1; return { error }; });
      req.emit("data", Buffer.from('{"v":"'));
      req.emit(event, ...(event === "error" ? [original] : []));
      req.emit("data", Buffer.from('汉"}'));
      req.complete = true;
      req.emit("end");
      req.emit("error", new Error("late error"));
      const result = await deadline(observed);
      if (event === "error") assert.equal(result.error, original);
      else assert.equal(result.error?.code, "REQUEST_BODY_ABORTED");
      await nextTurn();
      assert.equal(resolved, 0); assert.equal(rejected, 1);
      assert.equal(req.listenerCount("data"), 0);
    });
  }
  for (const property of ["aborted", "destroyed"]) {
    await check(`preexisting ${property} request rejects without awaiting another event`, async () => {
      const req = new RequestStream(); req[property] = true;
      await assert.rejects(deadline(readRequestJson(req)), { code: "REQUEST_BODY_ABORTED" });
    });
  }
  await check("close before the readable end rejects even when HTTP parser complete is already true", async () => {
    const req = new RequestStream();
    const observed = readRequestJson(req);
    req.emit("data", Buffer.from("{}")); req.complete = true; req.emit("close");
    await assert.rejects(deadline(observed), { code: "REQUEST_BODY_ABORTED" });
  });
  for (const failure of ["size", "utf8"]) {
    await check(`${failure} rejection remains single after repeated failure and end events`, async () => {
      const req = new RequestStream();
      const observed = readRequestJson(req, 2).then(value => ({ value }), error => ({ error }));
      req.emit("data", failure === "size" ? Buffer.from("long") : Buffer.from([0xff]));
      req.emit("data", Buffer.from("long")); req.emit("aborted"); req.emit("end");
      req.emit("error", new Error("late request error"));
      const result = await deadline(observed);
      assert.ok(result.error); assert.ok(!Object.hasOwn(result, "value"));
      await nextTurn(); assert.equal(req.destroyCalls, 1);
    });
  }
  await check("success ignores later stream errors and end events", async () => {
    const req = new RequestStream();
    const observed = readRequestJson(req);
    req.emit("data", Buffer.from("{}")); req.complete = true; req.emit("end");
    req.emit("error", new Error("late error")); req.emit("end");
    assert.deepEqual(await observed, {});
  });

  // Exercise the same imported reader on real IncomingMessage Buffer chunks.
  const records = [];
  const server = http.createServer((req, res) => {
    const record = { id: Number(req.headers["x-test-id"]), chunks: [] };
    records.push(record);
    req.on("data", chunk => record.chunks.push(Buffer.from(chunk)));
    readRequestJson(req, Number(req.headers["x-max-bytes"] || 1024)).then(value => {
      record.value = value;
      res.end(JSON.stringify(value));
    }, error => { record.error = error.message; if (!res.destroyed) res.destroy(); });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  let id = 0;
  async function sendHttp(chunks, { limit = 1024, abort = false } = {}) {
    const testId = ++id;
    const outcome = new Promise(resolve => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST", agent: false,
        headers: { "x-test-id": String(testId), "x-max-bytes": String(limit), "transfer-encoding": "chunked" } }, res => {
        const body = [];
        res.on("data", chunk => body.push(chunk));
        res.on("end", () => resolve({ body: Buffer.concat(body).toString("utf8") }));
        res.on("error", error => resolve({ error: error.message }));
      });
      req.on("error", error => resolve({ error: error.message }));
      (async () => {
        for (let index = 0; index < chunks.length; index += 1) {
          if (req.destroyed || records.find(row => row.id === testId)?.error) break;
          req.write(chunks[index]);
          // Wait for the actual server data event, so TCP coalescing cannot make
          // a claimed byte-boundary test pass without testing that boundary.
          for (let turn = 0; turn < 100 && !records.find(row => row.id === testId)?.chunks[index]; turn += 1) await nextTurn();
          assert.ok(records.find(row => row.id === testId)?.chunks[index], "HTTP chunk not observed separately");
        }
        if (abort) req.destroy(new Error("intentional partial HTTP upload abort"));
        else if (!req.destroyed) req.end();
      })().catch(error => { req.destroy(error); });
    });
    const client = await deadline(outcome);
    for (let turn = 0; turn < 100 && !Object.hasOwn(records.find(row => row.id === testId) || {}, "error")
      && !Object.hasOwn(records.find(row => row.id === testId) || {}, "value"); turn += 1) await nextTurn();
    return { client, record: records.find(row => row.id === testId) };
  }
  try {
    for (const character of ["文", "😀", "𐀀"]) {
      const offset = payload.indexOf(Buffer.from(character)), length = Buffer.byteLength(character);
      for (let inside = 1; inside < length; inside += 1) {
        await check(`real chunked HTTP split inside ${character} after byte ${inside}`, async () => {
          const split = offset + inside;
          const { client, record } = await sendHttp([payload.subarray(0, split), payload.subarray(split)], { limit: payload.length });
          assert.equal(record.chunks.length, 2);
          assert.equal(record.chunks[0].length, split);
          assert.deepEqual(record.value, value);
          assert.deepEqual(JSON.parse(client.body), value);
        });
      }
    }
    await check("real HTTP rejects true multibyte byte overflow", async () => {
      const { record } = await sendHttp([payload], { limit: payload.length - 1 });
      assert.equal(record.error, "request body too large");
      assert.ok(!Object.hasOwn(record, "value"));
    });
    await check("real HTTP rejects malformed UTF-8 rather than accepting replacement JSON", async () => {
      const { record } = await sendHttp([Buffer.from('{"v":"'), Buffer.from([0xff]), Buffer.from('"}')]);
      assert.equal(record.error, "request body contains invalid UTF-8");
      assert.ok(!Object.hasOwn(record, "value"));
    });
    await check("real HTTP rejects incomplete UTF-8 on completed upload", async () => {
      const { record } = await sendHttp([Buffer.from('{"v":"'), Buffer.from([0xf0, 0x9f])]);
      assert.equal(record.error, "request body contains invalid UTF-8");
      assert.ok(!Object.hasOwn(record, "value"));
    });
    await check("real HTTP partial upload abort cannot resolve an empty or partial JSON object", async () => {
      const { record } = await sendHttp([Buffer.from('{"v":"'), Buffer.from([0xe4])], { abort: true });
      assert.equal(record.error, "request body aborted");
      assert.ok(!Object.hasOwn(record, "value"));
    });
    await check("real HTTP empty body keeps the original empty object response", async () => {
      const { client, record } = await sendHttp([]);
      assert.deepEqual(record.value, {}); assert.deepEqual(JSON.parse(client.body), {});
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  return { ok: true, verifier: "request-json-utf8-v1", checks, passed: checks.length, failed: 0,
    productionWrites: 0, providerRequests: 0,
    scope: "synthetic stream boundaries and actual loopback HTTP; no historical match data; proves request-reader bug, not unique production causation" };
}

module.exports = { verifyRequestJsonUtf8 };
if (require.main === module) verifyRequestJsonUtf8().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
  console.error(error.stack); process.exitCode = 1;
});
