'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

// Materialize the JSON value, never a file-sized Buffer or string. Memory is
// the resulting object graph plus one bounded scalar and a 64 KiB read buffer.
// This is not a selective/truncating reader: every key, row and token is kept.
function readChunkedJsonFile(filePath, { expectedBytes, expectedSha256,
  chunkBytes = 64 * 1024, maxBytes = 2 * 1024 ** 3,
  maxScalarChars = 16 * 1024 ** 2, maxDepth = 256 } = {}) {
  const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  if (![chunkBytes, maxBytes, maxScalarChars, maxDepth].every(n => Number.isSafeInteger(n) && n > 0)
    || chunkBytes > 1024 ** 2 || maxScalarChars > 128 * 1024 ** 2
    || (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0))
    || (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)))
    fail('CHUNKED_JSON_OPTIONS_INVALID', 'invalid chunked JSON options');
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink()) fail('GENERATION_FILE_UNSAFE', 'JSON input must be a plain file');
  if (before.size > maxBytes) fail('CHUNKED_JSON_FILE_LIMIT', 'JSON file exceeds the admission bound');
  if (expectedBytes !== undefined && before.size !== expectedBytes) fail('FILE_SIZE_MISMATCH', 'JSON size mismatch');
  const unchanged = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  const hash = crypto.createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const stack = [];
  let result, rootDone = false, mode = '', isKey = false, escape = false, unicodeLeft = 0;
  let fragments = [], scalarChars = 0, bytes = 0, scalarCount = 0;
  const invalid = message => fail('FILE_JSON_INVALID', `invalid JSON: ${message}`);
  const append = text => {
    scalarChars += text.length;
    if (scalarChars > maxScalarChars) fail('CHUNKED_JSON_SCALAR_LIMIT', 'JSON scalar exceeds the admission bound');
    if (text) fragments.push(text);
  };
  const accept = value => {
    const parent = stack.at(-1);
    if (!parent) { result = value; rootDone = true; return; }
    if (!['value', 'valueOrEnd', 'valueRequired'].includes(parent.state)) invalid('unexpected completed value');
    if (parent.array) parent.value.push(value);
    // Match JSON.parse own-property semantics; never invoke Object.prototype's setter.
    else if (parent.key === '__proto__') Object.defineProperty(parent.value, parent.key,
      { value, enumerable: true, configurable: true, writable: true });
    else parent.value[parent.key] = value;
    parent.key = null;
    parent.state = 'commaOrEnd';
  };
  const finishScalar = () => {
    const text = fragments.join('');
    if (mode === 'atom' && !/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(text))
      invalid('invalid scalar');
    let value;
    try { value = JSON.parse(text); } catch { invalid('invalid scalar'); }
    if (isKey) { const frame = stack.at(-1); frame.key = value; frame.state = 'colon'; }
    else accept(value);
    fragments = []; scalarChars = 0; mode = ''; scalarCount++;
  };
  const push = array => {
    stack.push({ array, value: array ? [] : {}, key: null, state: array ? 'valueOrEnd' : 'keyOrEnd' });
    if (stack.length > maxDepth) fail('CHUNKED_JSON_DEPTH_LIMIT', 'JSON nesting exceeds the admission bound');
  };
  const close = () => { const frame = stack.pop(); accept(frame.value); };
  const consume = text => {
    let i = 0, fragmentStart = mode ? 0 : -1;
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
        const special = /["\\\x00-\x1f]/g;
        special.lastIndex = i;
        const found = special.exec(text);
        if (!found) { i = text.length; continue; }
        i = found.index;
        if (text[i] === '\\') { escape = true; i++; continue; }
        if (text[i] !== '"') invalid('unescaped control character');
        append(text.slice(fragmentStart, ++i)); finishScalar(); fragmentStart = -1;
        continue;
      }
      if (mode === 'atom') {
        const end = /[\x20\t\r\n,\]}]/g;
        end.lastIndex = i;
        const found = end.exec(text);
        if (!found) { i = text.length; continue; }
        i = found.index;
        append(text.slice(fragmentStart, i)); finishScalar(); fragmentStart = -1;
        continue;
      }
      if (/[\x20\t\r\n]/.test(c)) {
        // Skip pretty-print padding in native code; never retain whitespace.
        const nonspace = /[^\x20\t\r\n]/g;
        nonspace.lastIndex = i;
        const found = nonspace.exec(text);
        i = found ? found.index : text.length; continue;
      }
      if (rootDone) invalid('trailing content');
      const frame = stack.at(-1);
      if (frame?.state === 'keyOrEnd' || frame?.state === 'keyRequired') {
        if (c === '}' && frame.state === 'keyOrEnd') { close(); i++; continue; }
        if (c !== '"') invalid('expected object key');
        mode = 'string'; isKey = true; fragmentStart = i++; continue;
      }
      if (frame?.state === 'colon') {
        if (c !== ':') invalid('expected colon');
        frame.state = 'value'; i++; continue;
      }
      if (frame?.state === 'commaOrEnd') {
        if (c === (frame.array ? ']' : '}')) { close(); i++; continue; }
        if (c !== ',') invalid('expected comma or container end');
        frame.state = frame.array ? 'valueRequired' : 'keyRequired'; i++; continue;
      }
      if (frame?.state === 'valueOrEnd' && c === ']') { close(); i++; continue; }
      if (c === '{' || c === '[') { push(c === '['); i++; continue; }
      isKey = false;
      if (c === '"') { mode = 'string'; fragmentStart = i++; continue; }
      if (c === '-' || /[0-9tfn]/.test(c)) { mode = 'atom'; fragmentStart = i++; continue; }
      invalid('expected value');
    }
    if (mode) append(text.slice(fragmentStart));
  };
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !unchanged(before, opened)) fail('GENERATION_FILE_CHANGED', 'JSON changed before open');
    const buffer = Buffer.allocUnsafe(chunkBytes);
    while (true) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      bytes += n;
      if (bytes > before.size) fail('GENERATION_FILE_CHANGED', 'JSON grew while reading');
      const part = buffer.subarray(0, n); hash.update(part);
      let text;
      try { text = decoder.decode(part, { stream: true }); } catch { invalid('invalid UTF-8'); }
      consume(text);
    }
    let tail;
    try { tail = decoder.decode(); } catch { invalid('incomplete UTF-8'); }
    consume(tail);
    if (mode === 'atom') finishScalar();
    if (mode || !rootDone || stack.length) invalid('incomplete document');
    const after = fs.fstatSync(fd), current = fs.lstatSync(filePath);
    if (bytes !== before.size || !unchanged(opened, after) || current.isSymbolicLink() || !unchanged(opened, current))
      fail('GENERATION_FILE_CHANGED', 'JSON changed while reading');
    const sha256 = hash.digest('hex');
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) fail('FILE_HASH_MISMATCH', 'JSON hash mismatch');
    return { value: result, evidence: { bytes, sha256, scalarCount, reader: 'chunked-json-v1' } };
  } finally { fs.closeSync(fd); }
}

module.exports = { readChunkedJsonFile };
