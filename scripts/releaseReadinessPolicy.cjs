"use strict";
const VERSION = "release-readiness-fail-fast-v1";
function recordCheck(checks, name, ok, details = {}, diagnosticAll = false) {
  const row = { name, ...details, ok: Boolean(ok) };
  checks.push(row);
  if (!row.ok && !diagnosticAll) {
    const error = new Error(`readiness failed: ${name}`);
    error.code = "RELEASE_READINESS_FAILED";
    error.readinessReport = { version: VERSION, ok: false, failFast: true,
      summary: { total: checks.length, passed: checks.filter(c => c.ok).length,
        failed: checks.filter(c => !c.ok).map(c => c.name) }, checks: [...checks] };
    throw error;
  }
}
function currentListBudget(response) {
  const rows = Array.isArray(response?.body?.rows) ? response.body.rows : [];
  const heavy = rows.some(row => row?.gptPrediction?.relay || row?.probabilityModel?.calculationTrace
    || row?.probabilityModel?.basis || row?.predictionMeta?.analystFramework || row?.predictionMeta?.dataPolicy
    || row?.externalSignals?.fiveHundred?.recentForm?.home?.rows
    || row?.externalSignals?.fiveHundred?.europeOdds?.rows || row?.externalSignals?.fiveHundred?.asianHandicap?.rows);
  const bytes = response?.bytes;
  const avgBytesPerRow = rows.length ? Math.round(bytes / rows.length) : bytes;
  return { ok: response?.status === 200 && rows.length > 0 && Number.isSafeInteger(bytes) && bytes >= 0
      && avgBytesPerRow <= 20000 && !heavy,
    status: response?.status || 0, rows: rows.length, bytes, avgBytesPerRow, exposesHeavyCurrentListFields: heavy };
}
async function probeCurrentList({ request, adminToken }) {
  const checks = []; let codeId = null;
  const add = (name, ok, details) => recordCheck(checks, name, ok, details);
  const headers = { authorization: `Bearer ${adminToken}` };
  try {
    add("early list admin credential available", Boolean(adminToken), {});
    const created = await request("POST", "/api/admin/access-codes", { label: "release-early-payload-check", ttlSeconds: 900 }, headers);
    codeId = typeof created.body?.id === "string" && created.body.id ? created.body.id : null;
    add("early list temporary credential created", created.status === 200 && codeId && created.body?.code, { status: created.status });
    const verified = await request("POST", "/api/access/verify", { code: created.body.code });
    const token = verified.body?.session?.token;
    add("early list temporary credential verified", verified.status === 200 && token, { status: verified.status });
    const response = await request("GET", "/api/v1/matches/current?view=list", null, { "x-access-token": token });
    const budget = currentListBudget(response);
    add("early current list compact payload", budget.ok, budget);
    return { ok: true, checks };
  } finally {
    if (codeId) {
      const revoked = await request("POST", `/api/admin/access-codes/${encodeURIComponent(codeId)}/revoke`, null, headers);
      add("early list temporary credential revoked", revoked.status === 200 && revoked.body?.ok === true
        && revoked.body?.row?.status === "revoked", { status: revoked.status });
    }
  }
}
module.exports = { VERSION, recordCheck, currentListBudget, probeCurrentList };
