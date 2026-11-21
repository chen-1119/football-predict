'use strict';
const path = require('node:path');
const { readGenerationSelectedObject } = require('../server/dataGenerationStore.cjs');
const { createFileJsonPayload } = require('./postgresFileJsonPayload.cjs');

// Keep the complete immutable source in PostgreSQL json. Only the two scalar
// columns are materialized; the ordinary writer verifies and streams all bytes.
function externalGenerationRow(context) {
  const name = 'external-signals.json';
  const entry = context?.manifest?.files?.find(item => item.path === name);
  if (!entry) throw new Error('native projection external signals missing');
  const { value } = readGenerationSelectedObject(context, name, {
    keys: ['source', 'updatedAt'], maxSelectedChars: 16384,
  });
  if ((value.source != null && typeof value.source !== 'string')
    || (value.updatedAt != null && typeof value.updatedAt !== 'string')) {
    throw new Error('native projection external metadata invalid');
  }
  return {
    id: 'external-signals:current', source: value.source || 'external-signals',
    captured_at: value.updatedAt || null,
    payload: createFileJsonPayload(path.join(context.generationDir, name), {
      bytes: entry.bytes, sha256: entry.sha256,
    }),
  };
}
module.exports = { externalGenerationRow };
