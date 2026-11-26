'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { isUtf8 } = require('node:buffer');
// Strict whole-document validation; selected array items are released after the
// synchronous callback. Skipped candidates never become an object graph.
function streamJsonObjectArrays(filePath, {
  keys,
  onItem,
  expectedSha256,
  expectedBytes,
  allowNonArrays = false,
  inventoryFields = false,
  chunkBytes = 256 * 1024,
  maxItemChars = 16 * 1024 * 1024,
  maxBytes = 2 * 1024 ** 3,
  maxDepth = 256,
} = {}) {
  const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
  if (!Array.isArray(keys) || keys.some(k => typeof k !== 'string') || typeof onItem !== 'function'
    || typeof inventoryFields !== 'boolean'
    || ![chunkBytes, maxItemChars, maxBytes, maxDepth].every(n => Number.isSafeInteger(n) && n > 0)
    || chunkBytes > 1024 ** 2 || maxItemChars > 32 * 1024 ** 2) {
    fail('STREAM_JSON_OPTIONS_INVALID', 'Invalid streaming array options');
  }
  const selected = new Set(keys), seen = new Set(), admittedFields = new Set();
  const counts = Object.fromEntries(keys.map(k => [k, 0])), stack = [];
  const hash = crypto.createHash('sha256');
  const scalarDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const itemDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let utf8Carry = Buffer.alloc(0);
  const rootFields = new Map();
  let rootKeyChars = 0;
  let rootDone = false, mode = '', isKey = false, escape = false, unicodeLeft = 0;
  let fragments = [], scalarChars = 0, bytes = 0, retainScalar = false;
  const invalid = message => fail('FILE_JSON_INVALID', 'Invalid JSON: ' + message);
  const before = fs.lstatSync(filePath);
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  if (!before.isFile() || before.isSymbolicLink()) fail('GENERATION_FILE_UNSAFE', 'JSON input must be a plain file');
  if (before.size > maxBytes) fail('STREAM_JSON_FILE_LIMIT', 'JSON file exceeds bounded size');
  if (expectedBytes !== undefined && before.size !== expectedBytes) fail('FILE_SIZE_MISMATCH', 'JSON file size mismatch');

  const validateUtf8Chunk = part => {
    const checkBuf = utf8Carry.length ? Buffer.concat([utf8Carry, part]) : part;
    let end = checkBuf.length, back = 0;
    while (back < 3 && end - 1 - back >= 0 && (checkBuf[end - 1 - back] & 0xc0) === 0x80) back++;
    if (end - 1 - back >= 0 && checkBuf[end - 1 - back] >= 0xc0) {
      const lead = checkBuf[end - 1 - back];
      const needed = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 5;
      if (needed <= 4 && back + 1 < needed) end = end - 1 - back;
    }
    if (end > 0 && !isUtf8(checkBuf.subarray(0, end))) invalid('Invalid UTF-8');
    utf8Carry = end < checkBuf.length ? Buffer.from(checkBuf.subarray(end)) : Buffer.alloc(0);
  };

  const appendText = text => {
    if (!retainScalar || !text) return;
    scalarChars += text.length;
    if (scalarChars > maxItemChars) fail('STREAM_JSON_ITEM_LIMIT', 'JSON scalar exceeds memory admission bound');
    fragments.push(text);
  };
  const appendBytes = (buf, start, end, stream) => {
    if (!retainScalar) return;
    if (start < end) {
      let decoded;
      try { decoded = scalarDecoder.decode(buf.subarray(start, end), { stream }); } catch { invalid('Invalid UTF-8'); }
      appendText(decoded);
    } else if (!stream) {
      let tail;
      try { tail = scalarDecoder.decode(); } catch { invalid('Invalid UTF-8'); }
      appendText(tail);
    }
  };
  const accept = value => {
    const parent = stack.at(-1);
    if (!parent) { rootDone = true; return; }
    if (!['value', 'valueOrEnd', 'valueRequired'].includes(parent.state)) invalid('Unexpected completed value');
    if (parent.selected !== null) {
      onItem(parent.selected, value, counts[parent.selected]++);
    } else if (parent.keep) {
      if (parent.array) parent.value.push(value);
      else Object.defineProperty(parent.value, parent.key, { value, enumerable: true, writable: true, configurable: true });
    }
    parent.key = null;
    parent.state = 'commaOrEnd';
  };
  const finishScalar = () => {
    const text = fragments.join('');
    let value;
    if (mode === 'atom' && !/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(text)) invalid('Invalid scalar');
    if (retainScalar) {
      try { value = JSON.parse(text); } catch { invalid('Invalid scalar'); }
    }
    if (isKey) {
      const frame = stack.at(-1);
      frame.key = value;
      frame.state = 'colon';
    } else {
      accept(value);
    }
    fragments = [];
    scalarChars = 0;
    mode = '';
  };
  const push = array => {
    const parent = stack.at(-1), top = stack.length === 1 && selected.has(parent.key) && array;
    if (top) {
      if (seen.has(parent.key)) invalid('Duplicate ledger array');
      seen.add(parent.key);
    }
    const keep = Boolean(parent?.keep || parent?.selected != null);
    stack.push({ array, keep, selected: top ? parent.key : null, value: keep ? (array ? [] : {}) : undefined, key: null, state: array ? 'valueOrEnd' : 'keyOrEnd' });
    if (stack.length > maxDepth) fail('STREAM_JSON_DEPTH_LIMIT', 'JSON depth exceeds admission bound');
  };
  const close = () => { const frame = stack.pop(); accept(frame.value); };

  const atomDelimiter = /[\x20\t\r\n,\]}]/g, whitespace = /[\x20\t\r\n]+/y, special = /["\\\x00-\x1f]/g;
  const jsonString = '"(?:[^"\\\\\\x00-\\x1f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
  const boundedJsonScalar = '(?:' + jsonString + '|true|false|null|-?(?:0|[1-9][0-9]{0,20})(?:\\.[0-9]{1,24})?(?:[eE][+-]?[0-9]{1,10})?(?![0-9.eE+-]))';
  const gap = '[ \\t\\r\\n]*', separator = gap + ',' + gap;
  const property = jsonString + gap + ':' + gap + boundedJsonScalar;
  const openProp = jsonString + gap + ':' + gap + '([{\\[])';
  // Multi-property / multi-value skipped-region scanners reuse exact JSON
  // grammar on 1-byte Latin-1 views after SIMD UTF-8 validation. Any scalar
  // matched by boundedJsonScalar has atom length <= 58 chars, so only enable
  // the batch fast-path when maxItemChars >= 64.
  const canUseBatchSkip = maxItemChars >= 64;
  const objectStep = canUseBatchSkip
    ? new RegExp('(?:' + property + '(?:' + separator + property + '){0,31}(?:' + gap + '(\\})|' + separator + openProp + '|(?=' + gap + '[,}]))|' + openProp + ')', 'y')
    : null;
  const scalarValues = canUseBatchSkip
    ? new RegExp(boundedJsonScalar + '(?:' + separator + boundedJsonScalar + '){0,31}(?=' + gap + '[,\\]])', 'y')
    : null;
  const jsonScalar = '(?:' + jsonString + '|true|false|null|-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)';
  const scalarProperty = new RegExp(jsonString + '[ \\t\\r\\n]*:[ \\t\\r\\n]*(' + jsonScalar + ')(?=[ \\t\\r\\n]*[,}])', 'y');

  // A selected array element must be materialized. Scan its exact byte frame
  // over 1-byte Latin-1, decode UTF-8 once, and parse with V8 JSON.parse.
  const structural = /["{}\[\]]/g, quoted = /["\\]/g;
  let containerItem = null;
  function appendContainerText(item, fragment) {
    if (!fragment) return;
    item.chars += fragment.length;
    if (item.chars > maxItemChars) fail('STREAM_JSON_ITEM_LIMIT', 'JSON array item exceeds memory admission bound');
    item.pending.push(fragment);
    item.pendingChars += fragment.length;
    if (!item.depth || item.pendingChars >= 64 * 1024) {
      item.parts.push(item.pending.join(''));
      item.pending = [];
      item.pendingChars = 0;
    }
  }
  function consumeContainer(buf, text, start) {
    const item = containerItem;
    let cursor = start;
    if (item.skipEscaped) { cursor++; item.skipEscaped = false; }
    while (cursor < text.length) {
      const tokens = item.inString ? quoted : structural;
      tokens.lastIndex = cursor;
      const token = tokens.exec(text);
      if (!token) { cursor = text.length; break; }
      cursor = tokens.lastIndex;
      const char = token[0];
      if (char === '"') { item.inString = !item.inString; continue; }
      if (char === '\\') {
        if (cursor === text.length) item.skipEscaped = true;
        else cursor++;
        continue;
      }
      if (char === '{' || char === '[') {
        if (++item.depth + stack.length > maxDepth) fail('STREAM_JSON_DEPTH_LIMIT', 'JSON depth exceeds admission bound');
      } else if (--item.depth === 0) break;
    }
    const done = item.depth === 0;
    let fragment = '';
    if (start < cursor) {
      try { fragment = itemDecoder.decode(buf.subarray(start, cursor), { stream: !done }); } catch { invalid('Invalid UTF-8'); }
    }
    if (done) {
      let tail = '';
      try { tail = itemDecoder.decode(); } catch { invalid('Invalid UTF-8'); }
      if (tail) fragment += tail;
    }
    if (done && item.parts.length === 0 && item.pending.length === 0) {
      if (fragment.length > maxItemChars) fail('STREAM_JSON_ITEM_LIMIT', 'JSON array item exceeds memory admission bound');
      finishContainer(fragment);
    } else {
      appendContainerText(item, fragment);
      if (done) finishContainer(item.parts.join(''));
    }
    return cursor;
  }
  function finishContainer(raw) {
    let value;
    try { value = JSON.parse(raw); } catch { invalid('Invalid selected array item'); }
    containerItem = null;
    accept(value);
  }

  const consume = (buf, text) => {
    let i = 0, fragmentStart = mode ? 0 : -1;
    while (i < text.length) {
      const c = text[i];
      if (containerItem) { i = consumeContainer(buf, text, i); continue; }
      if (mode === 'string') {
        if (unicodeLeft) { if (!/[a-fA-F0-9]/.test(c)) invalid('Invalid Unicode escape'); unicodeLeft--; i++; continue; }
        if (escape) { escape = false; if (c === 'u') unicodeLeft = 4; else if (!'"\\/bfnrt'.includes(c)) invalid('Invalid string escape'); i++; continue; }
        special.lastIndex = i;
        const found = special.exec(text);
        if (!found) { i = text.length; continue; }
        i = found.index;
        if (text[i] === '\\') { escape = true; i++; continue; }
        if (text[i] !== '"') invalid('Unescaped control character');
        appendBytes(buf, fragmentStart, ++i, false);
        if (retainScalar) appendBytes(buf, i, i, false);
        finishScalar();
        fragmentStart = -1;
        continue;
      }
      if (mode === 'atom') {
        atomDelimiter.lastIndex = i;
        const found = atomDelimiter.exec(text);
        if (!found) { i = text.length; continue; }
        i = found.index;
        appendText(text.slice(fragmentStart, i));
        finishScalar();
        fragmentStart = -1;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { whitespace.lastIndex = i; whitespace.exec(text); i = whitespace.lastIndex; continue; }
      if (rootDone) invalid('Trailing content');
      const frame = stack.at(-1);
      if (!frame && c !== '{') invalid('Root must be an object');

      if (frame && !frame.keep && frame.selected === null && stack.length > 1) {
        if (!frame.array && (frame.state === 'keyOrEnd' || frame.state === 'keyRequired') && c === '"') {
          if (objectStep) {
            objectStep.lastIndex = i;
            const m = objectStep.exec(text);
            if (m) {
              i = objectStep.lastIndex;
              const open = m[2] || m[3];
              if (m[1]) close();
              else if (open) { frame.key = null; frame.state = 'value'; push(open === '['); }
              else { frame.key = null; frame.state = 'commaOrEnd'; }
              continue;
            }
          } else {
            scalarProperty.lastIndex = i;
            const pair = scalarProperty.exec(text);
            if (pair) {
              if (pair[1][0] !== '"' && pair[1].length > maxItemChars) fail('STREAM_JSON_ITEM_LIMIT', 'JSON scalar exceeds memory admission bound');
              frame.key = null; frame.state = 'commaOrEnd'; i = scalarProperty.lastIndex; continue;
            }
          }
        } else if (frame.array && scalarValues && (frame.state === 'valueOrEnd' || frame.state === 'valueRequired') && (c === '"' || c === '-' || (c >= '0' && c <= '9') || c === 't' || c === 'f' || c === 'n')) {
          scalarValues.lastIndex = i;
          if (scalarValues.exec(text)) {
            frame.state = 'commaOrEnd';
            i = scalarValues.lastIndex;
            continue;
          }
        }
      }

      if (frame?.state === 'keyOrEnd' || frame?.state === 'keyRequired') {
        if (c === '}' && frame.state === 'keyOrEnd') { i++; close(); continue; }
        if (c !== '"') invalid('Expected object key');
        mode = 'string'; isKey = true; retainScalar = stack.length === 1 || frame.keep; fragmentStart = i++; continue;
      }
      if (frame?.state === 'colon') { if (c !== ':') invalid('Expected colon'); frame.state = 'value'; i++; continue; }
      if (frame?.state === 'commaOrEnd') {
        if (c === (frame.array ? ']' : '}')) { i++; close(); continue; }
        if (c !== ',') invalid('Expected comma or end');
        frame.state = frame.array ? 'valueRequired' : 'keyRequired'; i++; continue;
      }
      if (frame?.state === 'valueOrEnd' && c === ']') { i++; close(); continue; }
      if (stack.length === 1 && inventoryFields) {
        if (rootFields.has(frame.key)) invalid('Duplicate root field');
        rootKeyChars += frame.key.length;
        if (rootFields.size >= 4096 || rootKeyChars > 512 * 1024) fail('STREAM_JSON_FIELDS_LIMIT', 'Root field inventory exceeds admission bound');
        rootFields.set(frame.key, c === '[');
      }
      if (stack.length === 1 && selected.has(frame.key)) {
        if (admittedFields.has(frame.key)) invalid('Duplicate ledger field');
        admittedFields.add(frame.key);
        if (c !== '[' && !allowNonArrays) invalid('Selected ledger field must be an array');
      }
      if (c === '{' || c === '[') {
        if (frame?.selected != null) {
          containerItem = { depth: 0, inString: false, skipEscaped: false, chars: 0, parts: [], pending: [], pendingChars: 0 };
          i = consumeContainer(buf, text, i);
          continue;
        }
        push(c === '['); i++; continue;
      }
      isKey = false; retainScalar = Boolean(frame?.keep || frame?.selected != null);
      if (c === '"') { mode = 'string'; fragmentStart = i++; continue; }
      if (c === '-' || (c >= '0' && c <= '9') || c === 't' || c === 'f' || c === 'n') { mode = 'atom'; retainScalar = true; fragmentStart = i++; continue; }
      invalid('Expected value');
    }
    if (mode === 'string') appendBytes(buf, fragmentStart, buf.length, true);
    else if (mode === 'atom') appendText(text.slice(fragmentStart));
  };

  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!same(before, opened) || !opened.isFile()) fail('GENERATION_FILE_CHANGED', 'JSON changed before open');
    const buffer = Buffer.allocUnsafe(chunkBytes);
    let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      bytes += n;
      if (bytes > before.size) fail('GENERATION_FILE_CHANGED', 'JSON grew while reading');
      const part = buffer.subarray(0, n);
      hash.update(part);
      validateUtf8Chunk(part);
      consume(part, part.toString('latin1'));
    }
    if (utf8Carry.length > 0) invalid('Incomplete UTF-8');
    if (mode === 'atom') finishScalar();
    if (containerItem || mode || !rootDone || stack.length) invalid('Incomplete document');
    const after = fs.fstatSync(fd), current = fs.lstatSync(filePath);
    if (bytes !== before.size || !same(opened, after) || current.isSymbolicLink() || !same(opened, current)) {
      fail('GENERATION_FILE_CHANGED', 'JSON changed while reading');
    }
    const sha256 = hash.digest('hex');
    if (expectedSha256 !== undefined && expectedSha256 !== sha256) fail('FILE_HASH_MISMATCH', 'JSON hash mismatch');
    return {
      bytes,
      sha256,
      counts,
      fields: [...seen],
      ...(inventoryFields ? { rootFields: [...rootFields].map(([key, array]) => ({ key, array })) } : {}),
    };
  } finally {
    fs.closeSync(fd);
  }
}
module.exports = { streamJsonObjectArrays };
