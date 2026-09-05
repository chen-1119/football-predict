"use strict";

const fs = require("node:fs");

// WAL commits do not necessarily change the main database inode, size or mtime.
// Track the WAL too, and bound positive entries so coarse filesystem timestamps
// can never pin a valid but obsolete publication identity indefinitely.
const sqlitePublicationFileToken = (dbPath) => ["", "-wal"].map((suffix) => {
  try {
    const stat = fs.statSync(`${dbPath}${suffix}`, { bigint: true });
    return [suffix || "db", stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs]
      .map(String).join(":");
  } catch (error) {
    return `${suffix || "db"}:${error?.code || "stat-error"}`;
  }
}).join("|");

const createSqlitePublicationIdentityCache = ({ dbPath, readIdentity, now = Date.now }) => {
  let cache = null;
  return () => {
    const fileToken = sqlitePublicationFileToken(dbPath);
    const checkedAtMs = now();
    const ageMs = checkedAtMs - (cache?.checkedAtMs ?? 0);
    if (cache?.fileToken === fileToken && ageMs >= 0 && ageMs < 1_000) {
      return cache.state;
    }
    const state = { ...readIdentity(dbPath), fileToken };
    // Do not retain a read across a concurrent commit/checkpoint/replacement.
    cache = fileToken === sqlitePublicationFileToken(dbPath)
      ? { fileToken, checkedAtMs, state }
      : null;
    return state;
  };
};

module.exports = { createSqlitePublicationIdentityCache, sqlitePublicationFileToken };
