'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

// A strict streaming JSON recognizer. Only selected top-level values are
// materialized; skipped values still undergo the complete JSON grammar check.
// This is deliberately not a regex extractor, nor a fallback for bad hashes.
function readSelectedJsonObjectFile({ filePath, expectedBytes, expectedSha256, keys,
  chunkBytes = 64 * 1024, maxSelectedChars = 128 * 1024 * 1024, maxDepth = 256 }) {
  const fail = (code, detail) => { const e = new Error(detail); e.code = code; throw e; };
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || !/^[a-f0-9]{64}$/.test(expectedSha256)
    || !Array.isArray(keys) || keys.some(k => typeof k !== 'string')
    || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 1024 * 1024
    || !Number.isSafeInteger(maxSelectedChars) || maxSelectedChars < 1
    || !Number.isSafeInteger(maxDepth) || maxDepth < 1) fail('SELECTED_JSON_OPTIONS_INVALID', 'invalid selected JSON options');
  const selected = new Set(keys), result = Object.create(null), stack = [];
  const hash = crypto.createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let mode = '', atom = '', rootStarted = false, rootDone = false, escape = false, unicodeLeft = 0;
  let isKey = false, keyText = '', keyStart = -1;
  let capture = null, captureStart = -1, selectedChars = 0, readBytes = 0, maxObservedDepth = 0;
  const invalid = detail => fail('FILE_JSON_INVALID', `invalid JSON: ${detail}`);
  const appendCapture = text => {
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
  const appendKey = text => {
    keyText += text;
    if (keyText.length > 16384) fail('SELECTED_JSON_KEY_LIMIT', 'top-level JSON key is too long');
  };
  let currentText = '';
  const completeValue = end => {
    const parent = stack.at(-1);
    if (!parent) { rootDone = true; return; }
    if (!['value', 'valueOrEnd', 'valueRequired'].includes(parent.state)) invalid('unexpected completed value');
    parent.state = 'commaOrEnd';
    if (stack.length === 1 && capture) {
      appendCapture(currentText.slice(captureStart, end));
      if (capture.pending.length) capture.parts.push(capture.pending.join(''));
      const key = capture.key, parts = capture.parts;
      capture = null; captureStart = -1;
      // JSON.parse supplies exact number/string/duplicate-key semantics for
      // retained values. The recognizer already checked their outer framing.
      result[key] = JSON.parse(parts.join(''));
    }
  };
  const closeContainer = end => { stack.pop(); completeValue(end); };
  const push = type => {
    stack.push({ type, state: type === 'object' ? 'keyOrEnd' : 'valueOrEnd', key: null });
    maxObservedDepth = Math.max(maxObservedDepth, stack.length);
    if (stack.length > maxDepth) fail('SELECTED_JSON_DEPTH_LIMIT', 'JSON nesting exceeds the admission bound');
  };
  const finishAtom = end => {
    if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(atom)) invalid('invalid scalar');
    mode = ''; atom = ''; completeValue(end);
  };
  // Reuse native scans within this invocation; grammar and byte hashing remain
  // complete even when a skipped ledger contains long runs of formatting.
  const atomDelimiter = /[\x20\t\r\n,\]}]/g, whitespace = /[\x20\t\r\n]+/y, special = /["\\\x00-\x1f]/g;

  // Bounded runs of complete skipped scalars use the same exact grammar in a
  // native scan. Containers, retained values and incomplete chunk tails still
  // use the state machine. The numeric lookahead keeps the original 4096-char
  // admission bound; longer atoms fall back to its explicit refusal below.
  const jsonString = '"(?:[^"\\\\\\x00-\\x1f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
  const jsonScalar = '(?:' + jsonString + '|true|false|null|(?![-0-9eE+.]{4097})-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)';
  const gap = '[ \\t\\r\\n]*', separator = gap + ',' + gap;
  const property = jsonString + gap + ':' + gap + jsonScalar;
  const scalarProperties = new RegExp(property + '(?:' + separator + property + '){0,63}(?=' + gap + '[,}])', 'y');
  const scalarValues = new RegExp(jsonScalar + '(?:' + separator + jsonScalar + '){0,63}(?=' + gap + '[,\\]])', 'y');
  const consume = text => {
    currentText = text;
    if (capture) captureStart = 0;
    if (mode === 'string' && isKey) keyStart = 0;
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
          const frame = stack.at(-1);
          if (stack.length === 1) { appendKey(text.slice(keyStart, i)); frame.key = JSON.parse(keyText); }
          frame.state = 'colon'; keyText = ''; keyStart = -1;
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
          appendCapture(text.slice(captureStart, i));
          captureStart = after;
        }
        i = after; continue;
      }
      if (rootDone) invalid('trailing content');
      if (!rootStarted) {
        if (c !== '{') invalid('top-level value must be an object');
        rootStarted = true; push('object'); i++; continue;
      }
      const frame = stack.at(-1);

      if (!capture && stack.length > 1 && frame.type === 'object'
        && (frame.state === 'keyOrEnd' || frame.state === 'keyRequired') && c === '"') {
        scalarProperties.lastIndex = i;
        if (scalarProperties.exec(text)) {
          frame.state = 'commaOrEnd'; i = scalarProperties.lastIndex; continue;
        }
      }
      if (!capture && frame.type === 'array'
        && (frame.state === 'valueOrEnd' || frame.state === 'valueRequired')) {
        scalarValues.lastIndex = i;
        if (scalarValues.exec(text)) {
          frame.state = 'commaOrEnd'; i = scalarValues.lastIndex; continue;
        }
      }
      if (frame.state === 'keyOrEnd' || frame.state === 'keyRequired') {
        if (c === '}' && frame.state === 'keyOrEnd') { closeContainer(++i); continue; }
        if (c !== '"') invalid('expected object key');
        mode = 'string'; isKey = true; keyText = ''; keyStart = i; i++; continue;
      }
      if (frame.state === 'colon') {
        if (c !== ':') invalid('expected colon');
        frame.state = 'value'; i++; continue;
      }
      if (frame.state === 'commaOrEnd') {
        if (c === (frame.type === 'object' ? '}' : ']')) { closeContainer(++i); continue; }
        if (c !== ',') invalid('expected comma or container end');
        frame.state = frame.type === 'object' ? 'keyRequired' : 'valueRequired'; i++; continue;
      }
      if (frame.state === 'valueOrEnd' && c === ']') { closeContainer(++i); continue; }
      if (stack.length === 1 && selected.has(frame.key)) {
        capture = { key: frame.key, parts: [], pending: [], pendingChars: 0 }; captureStart = i;
      }
      if (c === '{' || c === '[') { push(c === '{' ? 'object' : 'array'); i++; continue; }
      if (c === '"') { mode = 'string'; isKey = false; i++; continue; }
      if (c === '-' || /[0-9tfn]/.test(c)) { mode = 'atom'; atom = c; i++; continue; }
      invalid('expected value');
    }
    if (capture) { appendCapture(text.slice(captureStart)); captureStart = 0; }
    if (mode === 'string' && isKey && stack.length === 1) { appendKey(text.slice(keyStart)); keyStart = 0; }
    currentText = '';
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
      let text;
      try { text = decoder.decode(bytes, { stream: true }); } catch { invalid('invalid UTF-8'); }
      consume(text);
    }
    let tail;
    try { tail = decoder.decode(); } catch { invalid('incomplete UTF-8'); }
    consume(tail);
    if (mode === 'atom') finishAtom(0);
    if (mode || !rootDone || stack.length) invalid('incomplete document');
    if (readBytes !== expectedBytes) fail('FILE_SIZE_MISMATCH', 'selected JSON file shrank while reading');
    const after = fs.fstatSync(fd), current = fs.lstatSync(filePath);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) fail('GENERATION_FILE_CHANGED', 'selected JSON file changed while reading');
    const actualHash = hash.digest('hex');
    if (actualHash !== expectedSha256) fail('FILE_HASH_MISMATCH', 'selected JSON file hash mismatch');
    return { value: result, evidence: { bytes: readBytes, sha256: actualHash, selectedChars, maxObservedDepth, selectedKeys: Object.keys(result).sort() } };
  } finally { fs.closeSync(fd); }
}

module.exports = { readSelectedJsonObjectFile };
