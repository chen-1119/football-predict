"use strict";
const { VERSION, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, validateRequest, validateResponse, decode } = require("./postgresWorkerReadProtocol.cjs");
const { readPostgresWorkerObservation, readPostgresWorkerCounts } = require("./postgresWorkerObservation.cjs");

async function main() {
  if (process.argv.length !== 2) throw Error("native worker read accepts no arguments");
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw Error("native worker read request limit");
    chunks.push(chunk);
  }
  const request = validateRequest(decode(Buffer.concat(chunks), MAX_REQUEST_BYTES));
  // These original readers still validate the full immutable payload and the
  // active/serving pair, and close the native RR READ ONLY session and lease.
  const result = request.action === "observation"
    ? await readPostgresWorkerObservation(request.input)
    : await readPostgresWorkerCounts(request.input);
  const response = { version: VERSION, id: request.id, action: request.action, result };
  validateResponse(response, request);
  const output = Buffer.from(JSON.stringify(response));
  if (output.length > MAX_RESPONSE_BYTES) throw Error("native worker read response limit");
  await new Promise((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = { main };
