"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");
const { Transform } = require("node:stream");
const { sendStaticFileResponse } = require("../server/staticFileResponse.cjs");

const rootDir = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(rootDir, "server/index.cjs"), "utf8");
function between(start, end) {
  const from = serverSource.indexOf(start), to = serverSource.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `actual server section unavailable: ${start}`);
  return serverSource.slice(from, to);
}
const actualSections = [
  between("const mimeTypes = {", "let syncRunning ="),
  between("const isCompressibleType =", "const HISTORICAL_TEAM_ALIASES ="),
  between("const responseSecurityHeaders =", "const send ="),
  between("const getStaticCacheControl =", "const handleEventStream ="),
  between("const sendFile =", "const parseLimit ="),
  between("const isProtectedStaticDataPath =", "const runCommand ="),
  between("const blockedStaticSourceProbePaths =", "const runtimeTimers ="),
].join("\n");

function request(port, pathname = "/", { method = "GET", headers = {}, abortAfterChunk = false, onRequest } = {}) {
  return new Promise(resolve => {
    let settled = false, response = null;
    const chunks = [];
    const done = extra => {
      if (settled) return;
      settled = true;
      resolve({ status: response?.statusCode, headers: response?.headers || {}, body: Buffer.concat(chunks), ...extra });
    };
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers, agent: false }, res => {
      response = res;
      res.on("data", chunk => { chunks.push(chunk); if (abortAfterChunk) { req.destroy(); res.destroy(); done({ aborted: true }); } });
      res.on("end", () => done({ aborted: false }));
      res.on("error", error => done({ aborted: true, error: error.code || error.message }));
      res.on("aborted", () => done({ aborted: true }));
    });
    req.on("error", error => done({ aborted: true, error: error.code || error.message }));
    req.setTimeout(3000, () => req.destroy(new Error("isolated HTTP request deadline")));
    req.end();
    onRequest?.(req);
  });
}

async function verifyStaticFileResponseIdentity() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-static-response-identity-"));
  const checks = [];
  let fixtureNumber = 0;
  const check = async (name, fn) => { await fn(); checks.push({ name, ok: true }); };
  const write = (directory, name, bytes) => {
    const file = path.join(directory, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
  };
  const replace = (next, filename) => {
    // Win32 cannot rename over an open destination. Its fixture uses two real
    // renames to exercise fd identity; Linux verifies the production atomic op.
    if (process.platform === "win32") fs.renameSync(filename, `${filename}.retired`);
    fs.renameSync(next, filename);
  };
  async function fixture(options, run) {
    const directory = path.join(tempDir, String(++fixtureNumber)); fs.mkdirSync(directory);
    const opened = [], streams = [], pending = [];
    let lastResponseClosed = Promise.resolve();
    let streamCount = 0;
    const dependencies = {
      openFile: async (filename, flags) => {
        assert.equal(flags, "r");
        const file = await fsp.open(filename, flags);
        const row = { filename, fd: file.fd, closed: 0, stats: 0 }; opened.push(row);
        return {
          fd: file.fd,
          createReadStream: config => file.createReadStream(config),
          stat: async () => {
            row.stats++;
            const stat = await file.stat();
            try { await options.afterStat?.({ file, stat, filename, directory, row }); }
            catch (error) { row.fixtureError = error.message; throw error; }
            return stat;
          },
          close: async () => {
            await file.close(); row.closed++;
            // Numeric fd slots may already have been reused by a concurrent
            // request. The owning FileHandle must be closed, not that new slot.
            assert.equal(file.fd, -1);
          },
        };
      },
      createReadStream: file => {
        assert.ok(opened.some(row => row.fd === file.fd && !row.closed));
        streamCount++;
        const stream = file.createReadStream({ autoClose: true }); streams.push(stream);
        if (options.sourceError) queueMicrotask(() => stream.destroy(new Error("isolated read failure")));
        return stream;
      },
      createGzip: () => {
        if (options.gzipConstructionError) throw new Error("isolated compressor construction failure");
        const stream = options.gzipError
          ? new Transform({ transform(_chunk, _encoding, callback) { callback(new Error("isolated compression failure")); } })
          : zlib.createGzip();
        streams.push(stream); return stream;
      },
    };
    const context = {
      fs, path, distDir: directory, dataDir: path.join(directory, "data"),
      sendStaticFileResponse: args => sendStaticFileResponse(args, dependencies),
      sendJson: (res, body, status = 200) => {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(res.__request?.method === "HEAD" ? undefined : JSON.stringify(body));
      },
      hasRecommendationAccess: async req => req.headers["x-fixture-access"] === "yes",
      handleRuntimeConfig: res => { res.writeHead(200); res.end("isolated runtime config"); },
    };
    const handlers = vm.runInNewContext(`${actualSections}\n({sendFile, handleStatic, responseSecurityHeaders});`, context);
    const server = http.createServer((req, res) => {
      res.__request = req;
      lastResponseClosed = new Promise(resolve => res.once("close", resolve));
      const result = options.directPath
        ? handlers.sendFile(res, path.join(directory, options.directPath))
        : handlers.handleStatic(req, res, { pathname: req.url.split("?")[0] });
      pending.push(Promise.resolve(result));
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = server.address().port;
    try {
      await run({ directory, port, opened, streams, request: (pathname, opts) => request(port, pathname, opts), security: handlers.responseSecurityHeaders,
        waitForResponseClose: () => lastResponseClosed });
      await Promise.all(pending);
      for (const row of opened) { assert.equal(row.closed, 1); assert.equal(row.stats, 1); }
      assert.ok(streams.every(stream => stream.destroyed));
      return { opens: opened.length, streamCount };
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await Promise.all(pending);
    }
  }
  try {
    await check("production wrapper delegates to the single-descriptor helper, without pathname stat/reopen", () => {
      const source = between("const sendFile =", "const parseLimit =");
      assert.ok(serverSource.includes('require("./staticFileResponse.cjs")'));
      assert.ok(source.includes("sendStaticFileResponse({"));
      assert.ok(!source.includes("fsp.stat(") && !source.includes("createReadStream("));
    });
    for (const [label, oldBytes, newBytes] of [
      ["replacement longer", Buffer.from("old 中😀"), Buffer.from("new".repeat(1400))],
      ["replacement shorter", Buffer.from("old".repeat(1500)), Buffer.from("new")],
      ["equal lengths, different identity", Buffer.from("old-one"), Buffer.from("new-two")],
      ["empty original", Buffer.alloc(0), Buffer.from("non-empty replacement")],
    ]) {
      await check(`pathname replacement after fstat preserves exact original bytes and length: ${label}`, async () => {
        let replaced = false;
        const result = await fixture({ afterStat: ({ filename, directory }) => {
          if (!replaced) { replaced = true; replace(path.join(directory, "next.html"), filename); }
        } }, async ({ directory, request, opened }) => {
          write(directory, "index.html", oldBytes); write(directory, "next.html", newBytes);
          const first = await request("/");
          assert.equal(first.status, 200, JSON.stringify(opened)); assert.equal(first.aborted, false);
          assert.equal(Number(first.headers["content-length"]), oldBytes.length); assert.deepEqual(first.body, oldBytes);
          assert.equal(first.headers["cache-control"], "no-store"); assert.equal(opened.length, 1);
          const second = await request("/");
          assert.equal(second.status, 200); assert.deepEqual(second.body, newBytes);
          assert.equal(Number(second.headers["content-length"]), newBytes.length);
        });
        assert.equal(result.opens, 2); assert.equal(result.streamCount, 2);
      });
    }
    await check("gzip streams the same opened inode after rename without a stale content length", async () => {
      const oldBytes = Buffer.from("old 中😀".repeat(1000)), newBytes = Buffer.from("new");
      await fixture({ afterStat: ({ filename, directory }) => replace(path.join(directory, "next.html"), filename) }, async ({ directory, request }) => {
        write(directory, "index.html", oldBytes); write(directory, "next.html", newBytes);
        const response = await request("/", { headers: { "accept-encoding": "gzip" } });
        assert.equal(response.status, 200); assert.equal(response.headers["content-encoding"], "gzip");
        assert.equal(response.headers.vary, "Accept-Encoding"); assert.equal(response.headers["content-length"], undefined);
        assert.deepEqual(zlib.gunzipSync(response.body), oldBytes);
      });
    });
    await check("concurrent responses across one replacement each retain complete bytes without closing a reused descriptor", async () => {
      const oldBytes = Buffer.from("original".repeat(2000)), newBytes = Buffer.from("replacement".repeat(3000));
      let replaced = false;
      const result = await fixture({ afterStat: ({ filename, directory }) => {
        if (!replaced) { replaced = true; replace(path.join(directory, "next.html"), filename); }
      } }, async ({ directory, request }) => {
        write(directory, "index.html", oldBytes); write(directory, "next.html", newBytes);
        const responses = await Promise.all(Array.from({ length: 16 }, () => request("/")));
        for (const response of responses) {
          assert.equal(response.status, 200); assert.equal(response.aborted, false);
          assert.ok(response.body.equals(oldBytes) || response.body.equals(newBytes));
          assert.equal(Number(response.headers["content-length"]), response.body.length);
        }
      });
      assert.equal(result.opens, 16); assert.equal(result.streamCount, 16);
    });
    await check("HEAD reports the opened file length, never starts a stream or gzip, and closes once", async () => {
      const body = Buffer.from("head 中😀".repeat(500));
      const result = await fixture({ afterStat: ({ filename, directory }) => replace(path.join(directory, "next.html"), filename) }, async ({ directory, request }) => {
        write(directory, "index.html", body); write(directory, "next.html", "replacement");
        const response = await request("/", { method: "HEAD", headers: { "accept-encoding": "gzip" } });
        assert.equal(response.status, 200); assert.equal(response.body.length, 0);
        assert.equal(Number(response.headers["content-length"]), body.length); assert.equal(response.headers["content-encoding"], undefined);
      });
      assert.equal(result.opens, 1); assert.equal(result.streamCount, 0);
    });
    await check("security, CORS, immutable asset cache and existing no-Range/no-static-ETag semantics remain intact", async () => {
      await fixture({}, async ({ directory, request, security }) => {
        const body = Buffer.from("asset-body"); write(directory, "index.html", "shell"); write(directory, "assets/app.hash.js", body);
        const response = await request("/assets/app.hash.js", { headers: { range: "bytes=0-3", "if-none-match": '"unchanged-static-policy"' } });
        assert.equal(response.status, 200); assert.deepEqual(response.body, body);
        assert.equal(response.headers.etag, undefined); assert.equal(response.headers["content-range"], undefined);
        assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable");
        assert.equal(response.headers["content-type"], "text/javascript; charset=utf-8");
        assert.equal(response.headers["access-control-allow-origin"], "*");
        assert.equal(response.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
        assert.equal(response.headers["access-control-allow-headers"], "authorization, content-type, if-none-match, x-access-token");
        assert.equal(response.headers["access-control-expose-headers"], "cache-control, etag");
        for (const [name, value] of Object.entries(security)) assert.equal(response.headers[name], value);
      });
    });
    await check("gzip threshold and noncompressible content retain their prior behavior", async () => {
      await fixture({}, async ({ directory, request }) => {
        write(directory, "index.html", "small"); write(directory, "picture.png", Buffer.alloc(2048, 1));
        for (const pathname of ["/", "/picture.png"]) {
          const response = await request(pathname, { headers: { "accept-encoding": "gzip" } });
          assert.equal(response.status, 200); assert.equal(response.headers["content-encoding"], undefined);
          assert.equal(Number(response.headers["content-length"]), response.body.length);
        }
      });
    });
    await check("actual static routing keeps SPA fallback, blocked sources, path decoding and protected-data decisions", async () => {
      await fixture({}, async ({ directory, request }) => {
        write(directory, "index.html", "shell"); write(directory, "data/private.json", '{"private":true}');
        for (const [pathname, status] of [["/missing-page", 200], ["/.env", 404], ["/package.json", 404], ["/%2e%2e/secret", 404], ["/%GG", 400], ["/data/matches-current.json", 410], ["/data/private.json", 401]]) {
          const response = await request(pathname); assert.equal(response.status, status, pathname);
          if (status === 200) assert.equal(response.body.toString(), "shell");
        }
        const authorized = await request("/data/private.json", { headers: { "x-fixture-access": "yes" } });
        assert.equal(authorized.status, 200); assert.equal(authorized.headers["cache-control"], "no-store");
      });
    });
    await check("existing permitted directory symlink/junction resolution is unchanged", async () => {
      await fixture({}, async ({ directory, request }) => {
        const target = path.join(directory, "target"); write(directory, "target/linked.js", "linked asset");
        fs.symlinkSync(target, path.join(directory, "linked"), process.platform === "win32" ? "junction" : "dir");
        const response = await request("/linked/linked.js"); assert.equal(response.status, 200); assert.equal(response.body.toString(), "linked asset");
      });
    });
    await check("open failure returns existing 404 without opening any descriptor", async () => {
      const result = await fixture({ directPath: "missing.html" }, async ({ request }) => {
        const response = await request("/"); assert.equal(response.status, 404); assert.equal(JSON.parse(response.body).error, "not found");
      });
      assert.equal(result.opens, 0);
    });
    await check("fstat-stage failure closes the descriptor and returns existing 404", async () => {
      await fixture({ afterStat: () => { throw new Error("isolated fstat failure"); } }, async ({ directory, request }) => {
        write(directory, "index.html", "body"); assert.equal((await request("/")).status, 404);
      });
    });
    for (const errorMode of ["sourceError", "gzipError", "gzipConstructionError"]) {
      await check(`${errorMode} cannot leak a descriptor or leave an active source/compressor`, async () => {
        await fixture({ [errorMode]: true }, async ({ directory, request }) => {
          write(directory, "index.html", "body".repeat(2048));
          const response = await request("/", { headers: { "accept-encoding": "gzip" } });
          if (errorMode === "gzipConstructionError") assert.equal(response.status, 404);
          else assert.equal(response.aborted, true);
        });
      });
    }
    await check("client disconnect during streaming destroys the pipeline and closes the opened descriptor", async () => {
      await fixture({}, async ({ directory, request }) => {
        write(directory, "index.html", Buffer.alloc(8 * 1024 * 1024, 120));
        const response = await request("/", { abortAfterChunk: true }); assert.equal(response.aborted, true);
      });
    });
    await check("client disconnect while metadata is pending closes the descriptor without starting a stream", async () => {
      let entered, release;
      const atStat = new Promise(resolve => { entered = resolve; });
      const holdStat = new Promise(resolve => { release = resolve; });
      const result = await fixture({ afterStat: async () => { entered(); await holdStat; } }, async ({ directory, request, waitForResponseClose }) => {
        write(directory, "index.html", "body"); let client;
        const pending = request("/", { onRequest: req => { client = req; } });
        await atStat; client.destroy(); await pending;
        await waitForResponseClose(); release();
      });
      assert.equal(result.opens, 1); assert.equal(result.streamCount, 0);
    });
    return { ok: true, verifier: "static-file-response-identity-v1", checks,
      fixtures: fixtureNumber, replacementOperation: process.platform === "win32" ? "two real renames; not atomic on Windows" : "one atomic rename over open destination",
      productionWrites: 0, providerRequests: 0,
      scope: "actual extracted static wrapper/routes plus real loopback HTTP and temporary file replacement; auth is an explicit isolated fixture decision, not a full application or production probe" };
  } finally {
    assert.equal(path.dirname(fs.realpathSync(tempDir)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(tempDir).startsWith("football-static-response-identity-"));
    // Remove the test-created junction before deleting its private fixture tree.
    for (const dir of fs.readdirSync(tempDir)) {
      const link = path.join(tempDir, dir, "linked");
      if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = { verifyStaticFileResponseIdentity };
if (require.main === module) verifyStaticFileResponseIdentity().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
  console.error(error.stack); process.exitCode = 1;
});
