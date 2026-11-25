'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { isUtf8 } = require('node:buffer');
const HASH_FROM_OWNED_THREAD = Symbol('independent full hash');
let hashOwner = null;

// A strict streaming JSON recognizer. Only selected top-level values are
// materialized; skipped values still undergo the complete JSON grammar check.
// This is deliberately not a regex extractor, nor a fallback for bad hashes.
function readSelectedJsonObjectFile({ filePath, expectedBytes, expectedSha256, keys,
  chunkBytes = 64 * 1024, maxSelectedChars = 128 * 1024 * 1024, maxDepth = 256 }, privateMode) {
  const fail = (code, detail) => { const e = new Error(detail); e.code = code; throw e; };
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || !/^[a-f0-9]{64}$/.test(expectedSha256)
    || !Array.isArray(keys) || keys.some(k => typeof k !== 'string')
    || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 1024 * 1024
    || !Number.isSafeInteger(maxSelectedChars) || maxSelectedChars < 1
    || !Number.isSafeInteger(maxDepth) || maxDepth < 1) fail('SELECTED_JSON_OPTIONS_INVALID', 'invalid selected JSON options');
  const S_OBJ_KEY_OR_END = 1, S_OBJ_KEY_REQ = 2, S_OBJ_COLON = 3, S_OBJ_VALUE = 4, S_OBJ_COMMA_OR_END = 5;
  const S_ARR_VAL_OR_END = 6, S_ARR_VAL_REQ = 7, S_ARR_COMMA_OR_END = 8;
  const selected = new Set(keys), result = Object.create(null), stack = new Uint8Array(maxDepth + 1);
  let depth = 0, topKey = null;
  const hash = crypto.createHash('sha256');
  const keyDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const captureDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let utf8Carry = Buffer.alloc(0);
  let mode = '', atom = '', rootStarted = false, rootDone = false, escape = false, unicodeLeft = 0;
  let isKey = false, keyText = '', keyStart = -1;
  let capture = null, captureStart = -1, selectedChars = 0, readBytes = 0, maxObservedDepth = 0;
  const invalid = detail => fail('FILE_JSON_INVALID', `invalid JSON: ${detail}`);
  const validateUtf8Chunk = bytes => {
    const checkBuf = utf8Carry.length ? Buffer.concat([utf8Carry, bytes]) : bytes;
    let end = checkBuf.length, back = 0;
    while (back < 3 && end - 1 - back >= 0 && (checkBuf[end - 1 - back] & 0xc0) === 0x80) back++;
    if (end - 1 - back >= 0 && checkBuf[end - 1 - back] >= 0xc0) {
      const lead = checkBuf[end - 1 - back];
      const needed = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 5;
      if (needed <= 4 && back + 1 < needed) end = end - 1 - back;
    }
    if (end > 0 && !isUtf8(checkBuf.subarray(0, end))) invalid('invalid UTF-8');
    utf8Carry = end < checkBuf.length ? Buffer.from(checkBuf.subarray(end)) : Buffer.alloc(0);
  };
  const appendCaptureText = text => {
    if (!capture || !text) return;
    selectedChars += text.length;
    if (selectedChars > maxSelectedChars) fail('SELECTED_JSON_VALUE_LIMIT', 'selected JSON values exceed the memory admission bound');
    capture.pending.push(text);
    capture.pendingChars += text.length;
    if (capture.pendingChars >= 64 * 1024) {
      capture.parts.push(capture.pending.join(''));
      capture.pending = [];
      capture.pendingChars = 0;
    }
  };
  const appendCaptureBytes = (bytes, start, end, stream) => {
    if (!capture || start >= end) return;
    let text;
    try { text = captureDecoder.decode(bytes.subarray(start, end), { stream }); } catch { invalid('invalid UTF-8'); }
    appendCaptureText(text);
  };
  const appendKeyBytes = (bytes, start, end, stream) => {
    if (start >= end) return;
    let text;
    try { text = keyDecoder.decode(bytes.subarray(start, end), { stream }); } catch { invalid('invalid UTF-8'); }
    keyText += text;
    if (keyText.length > 16384) fail('SELECTED_JSON_KEY_LIMIT', 'top-level JSON key is too long');
  };
  let currentBytes = null;
  const completeValue = end => {
    if (depth === 0) { rootDone = true; return; }
    const st = stack[depth - 1];
    if (st !== S_OBJ_VALUE && st !== S_ARR_VAL_OR_END && st !== S_ARR_VAL_REQ) invalid('unexpected completed value');
    stack[depth - 1] = st === S_OBJ_VALUE ? S_OBJ_COMMA_OR_END : S_ARR_COMMA_OR_END;
    if (depth === 1 && capture) {
      appendCaptureBytes(currentBytes, captureStart, end, false);
      let tail;
      try { tail = captureDecoder.decode(); } catch { invalid('invalid UTF-8'); }
      appendCaptureText(tail);
      if (capture.pending.length) capture.parts.push(capture.pending.join(''));
      const key = capture.key, parts = capture.parts;
      capture = null; captureStart = -1;
      // JSON.parse supplies exact number/string/duplicate-key semantics for
      // retained values. The recognizer already checked their outer framing.
      result[key] = JSON.parse(parts.join(''));
    }
  };
  const closeContainer = end => { depth--; completeValue(end); };
  const push = isObject => {
    if (depth + 1 > maxDepth) fail('SELECTED_JSON_DEPTH_LIMIT', 'JSON nesting exceeds the admission bound');
    stack[depth++] = isObject ? S_OBJ_KEY_OR_END : S_ARR_VAL_OR_END;
    if (depth > maxObservedDepth) maxObservedDepth = depth;
  };
  const atomValid = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;
  const finishAtom = end => {
    if (!atomValid.test(atom)) invalid('invalid scalar');
    mode = ''; atom = ''; completeValue(end);
  };
  // Reuse native scans within this invocation; grammar and byte hashing remain
  // complete even when a skipped ledger contains long runs of formatting.
  const atomDelimiter = /[\x20\t\r\n,\]}]/g, whitespace = /[\x20\t\r\n]+/y, special = /["\\\x00-\x1f]/g;

  // Bounded runs of complete skipped scalars use the same exact grammar in a
  // native scan over 1-byte Latin-1 views after C++ SIMD UTF-8 validation.
  // Longer atoms fall back to the state machine and its explicit 4096-char bound.
  const jsonString = '"(?:[^"\\\\\\x00-\\x1f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
  const jsonScalar = '(?:' + jsonString + '|true|false|null|-?(?:0|[1-9][0-9]{0,20})(?:\\.[0-9]{1,24})?(?:[eE][+-]?[0-9]{1,10})?(?![0-9.eE+-]))';
  const gap = '[ \\t\\r\\n]*', separator = gap + ',' + gap;
  const property = jsonString + gap + ':' + gap + jsonScalar;
  const openProp = jsonString + gap + ':' + gap + '([{\\[])';
  const objectStep = new RegExp('(?:' + property + '(?:' + separator + property + '){0,31}(?:' + gap + '(\\})|' + separator + openProp + '|(?=' + gap + '[,}]))|' + openProp + ')', 'y');
  const scalarValues = new RegExp(jsonScalar + '(?:' + separator + jsonScalar + '){0,31}(?=' + gap + '[,\\]])', 'y');
  const consume = (bytes, text) => {
    currentBytes = bytes;
    if (capture) captureStart = 0;
    if (mode === 'string' && isKey && depth === 1) keyStart = 0;
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (mode === 'string') {
        if (unicodeLeft) {
          if (!/[a-fA-F0-9]/.test(c)) invalid('invalid Unicode escape');
          unicodeLeft--; i++; continue;
        }
        if (escape) {
          escape = false;
          if (c === 'u') unicodeLeft = 4;
          else if (!'"\\/bfnrt'.includes(c)) invalid('invalid string escape');
          i++; continue;
        }
        // Native scanning keeps a hundreds-of-megabytes skipped string cheap.
        special.lastIndex = i;
        const found = special.exec(text);
        if (!found) { i = text.length; continue; }
        i = found.index;
        if (text[i] === '\\') { escape = true; i++; continue; }
        if (text[i] !== '"') invalid('unescaped control character');
        i++; mode = '';
        if (isKey) {
          if (depth === 1) {
            appendKeyBytes(bytes, keyStart, i, false);
            let tail;
            try { tail = keyDecoder.decode(); } catch { invalid('invalid UTF-8'); }
            if (tail) {
              keyText += tail;
              if (keyText.length > 16384) fail('SELECTED_JSON_KEY_LIMIT', 'top-level JSON key is too long');
            }
            topKey = JSON.parse(keyText);
          }
          stack[depth - 1] = S_OBJ_COLON; keyText = ''; keyStart = -1;
        } else completeValue(i);
        continue;
      }
      if (mode === 'atom') {
        atomDelimiter.lastIndex = i;
        const found = atomDelimiter.exec(text), end = found ? found.index : text.length;
        atom += text.slice(i, end);
        if (atom.length > 4096) fail('SELECTED_JSON_SCALAR_LIMIT', 'JSON scalar is too long');
        i = end;
        if (found) finishAtom(i);
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        // Formatting whitespace can dominate an audited pretty-printed ledger.
        // Retain only JSON tokens; string contents still use the string branch
        // above unchanged, and the hash continues to cover every original byte.
        whitespace.lastIndex = i;
        whitespace.exec(text);
        const after = whitespace.lastIndex;
        if (capture) {
          appendCaptureBytes(bytes, captureStart, i, true);
          captureStart = after;
        }
        i = after; continue;
      }
      if (rootDone) invalid('trailing content');
      if (!rootStarted) {
        if (c !== '{') invalid('top-level value must be an object');
        rootStarted = true; push(true); i++; continue;
      }
      const st = stack[depth - 1];

      if (!capture && depth > 1) {
        if ((st === S_OBJ_KEY_OR_END || st === S_OBJ_KEY_REQ) && c === '"') {
          objectStep.lastIndex = i;
          const m = objectStep.exec(text);
          if (m) {
            i = objectStep.lastIndex;
            const opened = m[2] || m[3];
            if (opened !== undefined) {
              stack[depth - 1] = S_OBJ_VALUE;
              push(opened === '{');
            } else if (m[1] !== undefined) {
              closeContainer(i);
            } else {
              stack[depth - 1] = S_OBJ_COMMA_OR_END;
            }
            continue;
          }
        } else if (st === S_OBJ_COMMA_OR_END && c === ',' && i + 1 < text.length && text[i + 1] === '"') {
          objectStep.lastIndex = i + 1;
          const m = objectStep.exec(text);
          if (m) {
            i = objectStep.lastIndex;
            const opened = m[2] || m[3];
            if (opened !== undefined) {
              stack[depth - 1] = S_OBJ_VALUE;
              push(opened === '{');
            } else if (m[1] !== undefined) {
              closeContainer(i);
            } else {
              stack[depth - 1] = S_OBJ_COMMA_OR_END;
            }
            continue;
          }
        } else if (st === S_ARR_VAL_OR_END || st === S_ARR_VAL_REQ) {
          if (c === '{') { push(true); i++; continue; }
          scalarValues.lastIndex = i;
          if (scalarValues.exec(text)) {
            stack[depth - 1] = S_ARR_COMMA_OR_END; i = scalarValues.lastIndex; continue;
          }
        }
      }
      if (st === S_OBJ_KEY_OR_END || st === S_OBJ_KEY_REQ) {
        if (c === '}' && st === S_OBJ_KEY_OR_END) { closeContainer(++i); continue; }
        if (c !== '"') invalid('expected object key');
        mode = 'string'; isKey = true; keyText = ''; keyStart = depth === 1 ? i : -1; i++; continue;
      }
      if (st === S_OBJ_COLON) {
        if (c !== ':') invalid('expected colon');
        stack[depth - 1] = S_OBJ_VALUE; i++; continue;
      }
      if (st === S_OBJ_COMMA_OR_END) {
        if (c === '}') { closeContainer(++i); continue; }
        if (c !== ',') invalid('expected comma or container end');
        stack[depth - 1] = S_OBJ_KEY_REQ; i++; continue;
      }
      if (st === S_ARR_COMMA_OR_END) {
        if (c === ']') { closeContainer(++i); continue; }
        if (c !== ',') invalid('expected comma or container end');
        stack[depth - 1] = S_ARR_VAL_REQ; i++; continue;
      }
      if (st === S_ARR_VAL_OR_END && c === ']') { closeContainer(++i); continue; }
      if (depth === 1 && selected.has(topKey)) {
        capture = { key: topKey, parts: [], pending: [], pendingChars: 0 }; captureStart = i;
      }
      if (c === '{' || c === '[') { push(c === '{'); i++; continue; }
      if (c === '"') { mode = 'string'; isKey = false; i++; continue; }
      if (c === '-' || (c >= '0' && c <= '9') || c === 't' || c === 'f' || c === 'n') { mode = 'atom'; atom = c; i++; continue; }
      invalid('expected value');
    }
    if (capture) { appendCaptureBytes(bytes, captureStart, bytes.length, true); captureStart = 0; }
    if (mode === 'string' && isKey && depth === 1) { appendKeyBytes(bytes, keyStart, bytes.length, true); keyStart = 0; }
    currentBytes = null;
  };
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink()) fail('GENERATION_FILE_UNSAFE', 'selected JSON file must be a plain file');
  if (before.size !== expectedBytes) fail('FILE_SIZE_MISMATCH', 'selected JSON file size mismatch');
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail('GENERATION_FILE_CHANGED', 'selected JSON file changed before open');
    const buffer = Buffer.allocUnsafe(chunkBytes);
    while (true) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      readBytes += n;
      if (readBytes > expectedBytes) fail('FILE_SIZE_MISMATCH', 'selected JSON file grew while reading');
      const bytes = buffer.subarray(0, n); hash.update(bytes);
      validateUtf8Chunk(bytes);
      consume(bytes, bytes.toString('latin1'));
    }
    if (utf8Carry.length > 0) invalid('incomplete UTF-8');
    if (mode === 'atom') finishAtom(0);
    if (mode || !rootDone || depth !== 0) invalid('incomplete document');
    if (readBytes !== expectedBytes) fail('FILE_SIZE_MISMATCH', 'selected JSON file shrank while reading');
    const after = fs.fstatSync(fd), current = fs.lstatSync(filePath);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) fail('GENERATION_FILE_CHANGED', 'selected JSON file changed while reading');
    const actualHash = hash.digest('hex');
    if (privateMode !== HASH_FROM_OWNED_THREAD && actualHash !== expectedSha256) fail('FILE_HASH_MISMATCH', 'selected JSON file hash mismatch');
    return { value: result, evidence: { bytes: readBytes, sha256: actualHash, selectedChars, maxObservedDepth, selectedKeys: Object.keys(result).sort() } };
  } finally { fs.closeSync(fd); }
}

// Two independent complete passes overlap. Only this function has the private
// capability to retain the strict parser result before the other digest arrives.
// No rows escape until its fixed owned thread has actually exited successfully.
async function readSelectedJsonObjectFileWithIndependentHash({ filePath, keys,
  maxFileBytes = 2 * 1024 ** 3, maxSelectedChars = 128 * 1024 * 1024 }) {
  const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  if (hashOwner) fail('SELECTED_JSON_HASH_BUSY', 'an owned full hash read is still active');
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0 || maxFileBytes > 2 * 1024 ** 3)
    fail('SELECTED_JSON_OPTIONS_INVALID', 'invalid full hash file bound');
  const started = performance.now(), before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxFileBytes)
    fail('CANDIDATE_SNAPSHOT_FILE_BOUND', 'snapshot file exceeds bounded object admission');
  const same = (a, b) => a.isFile() && b.isFile() && !b.isSymbolicLink()
    && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const nonce = crypto.randomBytes(16).toString('hex');
  let worker, exited = false, done, reply, messages = 0, failure = null, exitCode;
  hashOwner = { fd, nonce };
  try {
    if (!same(before, fs.fstatSync(fd))) fail('GENERATION_FILE_CHANGED', 'snapshot changed before independent hashing');
    worker = new Worker(require.resolve('./selectedJsonFullHashWorker.cjs'), {
      workerData: { version: 1, action: 'full-sha256', nonce, fd, expectedBytes: before.size },
      env: {}, stdout: true, stderr: true, trackUnmanagedFds: true,
      resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
    });
    const refuse = () => { failure ||= new Error('invalid owned full hash response'); };
    done = new Promise(resolve => {
      worker.on('message', value => {
        messages++;
        if (messages !== 1 || typeof value !== 'string' || Buffer.byteLength(value) > 1024) return refuse();
        try { reply = JSON.parse(value); } catch { refuse(); }
      });
      worker.on('messageerror', refuse);
      worker.on('error', error => { failure = error; });
      worker.stdout.on('data', refuse); worker.stderr.on('data', refuse);
      worker.once('exit', code => { exited = true; exitCode = code; resolve(); });
    });
    const parseStarted = performance.now();
    const result = readSelectedJsonObjectFile({ filePath, expectedBytes: before.size,
      expectedSha256: '0'.repeat(64), keys, maxSelectedChars, chunkBytes: 1024 * 1024 }, HASH_FROM_OWNED_THREAD);
    const parseMs = performance.now() - parseStarted;
    await done;
    if (failure || exitCode !== 0 || messages !== 1 || !reply || Object.getPrototypeOf(reply) !== Object.prototype
      || Object.keys(reply).sort().join(',') !== 'action,bytes,durationMs,nonce,sha256,version'
      || reply.version !== 1 || reply.action !== 'full-sha256' || reply.nonce !== nonce
      || reply.bytes !== before.size || !/^[a-f0-9]{64}$/.test(reply.sha256)
      || !Number.isFinite(reply.durationMs) || reply.durationMs < 0)
      fail('SELECTED_JSON_HASH_PROTOCOL', 'owned full hash did not complete with one valid response and exit zero');
    if (reply.sha256 !== result.evidence.sha256) fail('FILE_HASH_MISMATCH', 'independent complete snapshot hashes differ');
    if (!same(before, fs.fstatSync(fd)) || !same(before, fs.lstatSync(filePath)))
      fail('GENERATION_FILE_CHANGED', 'snapshot changed during independent full reads');
    return { ...result, bytesRead: reply.bytes + result.evidence.bytes, fileBytes: before.size,
      timings: { hashMs: Number(reply.durationMs.toFixed(3)), selectedParseMs: Number(parseMs.toFixed(3)),
        totalMs: Number((performance.now() - started).toFixed(3)), fullPasses: 2, passesOverlap: true, hashThreadExited: true } };
  } finally {
    // Keep both descriptor and owner until the actual final exit event. The
    // capture's existing process deadline also owns all of its worker threads.
    if (worker && !exited) { try { await worker.terminate(); } finally { await done; } }
    fs.closeSync(fd); hashOwner = null;
  }
}
module.exports = { readSelectedJsonObjectFile, readSelectedJsonObjectFileWithIndependentHash };
