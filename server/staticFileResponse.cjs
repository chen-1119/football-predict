"use strict";

const fsp = require("node:fs/promises");
const zlib = require("node:zlib");
const { pipeline } = require("node:stream/promises");

// A rename may replace the pathname at any point. Metadata and response bytes
// must refer to the same open file, never a stat(path) followed by reopen(path).
async function sendStaticFileResponse({ res, filePath, prepare, onNotFound }, {
  openFile = fsp.open,
  createReadStream = file => file.createReadStream({ autoClose: true }),
  createGzip = zlib.createGzip,
} = {}) {
  let file, source, compression;
  try {
    file = await openFile(filePath, "r");
    const stat = await file.stat();
    if (res.destroyed) return;
    const { headers, head = false, gzip = false } = prepare(stat);
    if (head) {
      await file.close();
      file = null;
      if (!res.destroyed) { res.writeHead(200, headers); res.end(); }
      return;
    }
    // The FileHandle owns both stream and close state. Sharing only its raw fd
    // with fs.createReadStream would risk an independent/double descriptor close.
    source = createReadStream(file);
    compression = gzip ? createGzip() : null;
    res.writeHead(200, headers);
    await pipeline(...(compression ? [source, compression, res] : [source, res]));
  } catch {
    if (!res.destroyed && !res.headersSent) onNotFound();
    else if (!res.destroyed) res.destroy();
  } finally {
    if (source && !source.destroyed) source.destroy();
    if (compression && !compression.destroyed) compression.destroy();
    if (file) {
      // FileHandle.close is idempotent after its stream closes automatically.
      try { await file.close(); }
      catch { if (!res.destroyed) res.destroy(); }
    }
  }
}

module.exports = { sendStaticFileResponse };
