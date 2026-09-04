#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_ACTION = "enable-ip-tls";
const EXPECTED_IP = "134.175.132.183";
const ALLOWED_KEYS = new Set([
  "actionVersion",
  "action",
  "ipAddress",
  "acmeEmail",
  "agreeToSubscriberAgreement",
  "stagingPreflight",
  "site",
  "channel",
  "releaseSequence"
]);

const fail = (message) => {
  throw new Error(`signed TLS release action rejected: ${message}`);
};

const actionPath = process.argv[2];
if (!actionPath) fail("action JSON path is required");
const expectedSite = process.argv[3];
const expectedChannel = process.argv[4];
const expectedSequence = process.argv[5];
if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(expectedSite || "")) fail("expected site is missing or invalid");
if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(expectedChannel || "")) fail("expected channel is missing or invalid");
if (!/^[1-9][0-9]*$/.test(expectedSequence || "")) fail("expected release sequence is missing or invalid");

const resolvedPath = path.resolve(actionPath);
const stat = fs.lstatSync(resolvedPath);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
  fail("action JSON must be a single-link regular file");
}
if (stat.size <= 0 || stat.size > 4096) fail("action JSON size is outside the allowed range");

let action;
try {
  action = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
} catch (error) {
  fail(`action JSON is invalid (${error.message || String(error)})`);
}
if (!action || typeof action !== "object" || Array.isArray(action)) fail("action must be a JSON object");

const keys = Object.keys(action);
const unknownKeys = keys.filter((key) => !ALLOWED_KEYS.has(key));
const missingKeys = [...ALLOWED_KEYS].filter((key) => !Object.hasOwn(action, key));
if (unknownKeys.length) fail(`unknown fields: ${unknownKeys.join(", ")}`);
if (missingKeys.length) fail(`missing fields: ${missingKeys.join(", ")}`);
if (action.actionVersion !== 1) fail("actionVersion must be 1");
if (action.action !== EXPECTED_ACTION) fail(`action must be ${EXPECTED_ACTION}`);
if (action.ipAddress !== EXPECTED_IP) fail(`ipAddress must be ${EXPECTED_IP}`);
if (action.agreeToSubscriberAgreement !== true) fail("subscriber agreement consent must be explicitly true");
if (action.stagingPreflight !== true) fail("stagingPreflight must be explicitly true");
if (action.site !== expectedSite) fail("site does not match the signed release identity");
if (action.channel !== expectedChannel) fail("channel does not match the signed release identity");
if (!Number.isSafeInteger(action.releaseSequence) || String(action.releaseSequence) !== expectedSequence) {
  fail("releaseSequence does not match the signed anti-replay sequence");
}

const email = action.acmeEmail;
if (typeof email !== "string" || email.length > 254
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(email)) {
  fail("acmeEmail is invalid");
}

process.stdout.write(`${email}\n`);
