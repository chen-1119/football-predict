const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const rounded = n => Number(n.toFixed(6));

// This interval describes a binomial hit rate, not uncertainty in Brier,
// profitability, or independent match-day performance.
function wilsonInterval(n, hitRate) {
  if (!Number.isInteger(n) || n <= 0 || !Number.isFinite(hitRate) || hitRate < 0 || hitRate > 1) {
    throw new Error('invalid calibration bin');
  }
  const z = 1.959963984540054;
  const denominator = 1 + z * z / n;
  const center = (hitRate + z * z / (2 * n)) / denominator;
  const half = z * Math.sqrt(hitRate * (1 - hitRate) / n + z * z / (4 * n * n)) / denominator;
  return [rounded(Math.max(0, center - half)), rounded(Math.min(1, center + half))];
}

function pairedSummary(baseline) {
  const model = baseline?.modelOnSameRows;
  const market = baseline?.metrics;
  const n = model?.rows;
  if (!Number.isInteger(n) || n <= 0 || n !== market?.rows || n !== baseline?.comparison?.rows) {
    throw new Error('model/market cohort count mismatch');
  }
  for (const metric of ['brier', 'logLoss', 'accuracy']) {
    if (![model[metric], market[metric]].every(v => typeof v === 'number' && Number.isFinite(v))) {
      throw new Error(`missing paired ${metric}`);
    }
  }
  const bins = Object.entries(model.calibrationByConfidence || {}).map(([bin, value]) => ({
    bin, rows: value.rows, meanConfidence: value.avgConfidence, hitRate: value.hitRate,
    hitRateWilson95: wilsonInterval(value.rows, value.hitRate),
    intervalAssumption: 'independent Bernoulli events; rounded published hit rate; match-day dependence not accounted for',
  }));
  return {
    rows: n, source: baseline.source,
    model: { brier: model.brier, logLoss: model.logLoss, accuracy: model.accuracy },
    market: { brier: market.brier, logLoss: market.logLoss, accuracy: market.accuracy },
    improvement: { brier: rounded(market.brier - model.brier), logLoss: rounded(market.logLoss - model.logLoss),
      accuracy: rounded(model.accuracy - market.accuracy) },
    modelConfidenceBins: bins,
    evidenceLevel: 'published aggregate; equal counts checked, event-set identity not independently recomputed',
  };
}

function auditExport(directory) {
  const receiptBytes = fs.readFileSync(path.join(directory, 'online-validation-inputs-receipt.json'));
  const receipt = JSON.parse(receiptBytes);
  if (receipt.source !== 'online-immutable-active-generation' || receipt.sameSnapshot !== true
      || receipt.productionWrites !== false || !receipt.publication?.generationId) {
    throw new Error('unbound online export receipt');
  }
  const files = {};
  for (const name of ['model-evaluation.json', 'model-strategy.json', 'matches-current.json']) {
    const entry = receipt.files?.find(file => file.name === name);
    const bytes = fs.readFileSync(path.join(directory, name));
    if (!entry || entry.sha256 !== sha256(bytes) || entry.bytes !== bytes.length
        || entry.provenance?.generationId !== receipt.publication.generationId
        || entry.provenance?.manifestHash !== receipt.publication.manifestHash) {
      throw new Error(`export hash/size/publication mismatch: ${name}`);
    }
    files[name] = { sha256: entry.sha256, bytes: bytes.length };
  }
  const evaluation = JSON.parse(fs.readFileSync(path.join(directory, 'model-evaluation.json')));
  return {
    version: 'online-calibration-export-audit-v1', status: 'shadow-diagnostic', productionWrites: false,
    publication: receipt.publication, receivedAt: receipt.localReceivedAt,
    evaluationGeneratedAt: evaluation.generatedAt,
    receiptSha256: sha256(receiptBytes), files,
    batchWarning: 'Published September 30 batch; not current October 2 data or fresh live health proof.',
    strictSameDecision: pairedSummary(evaluation.promotionMarketBaseline),
    legacyLaggedDiagnostic: pairedSummary(evaluation.marketBaseline),
    admission: { coverage: evaluation.inputAudit?.coverage, timeWindow: evaluation.inputAudit?.timeWindow,
      blockers: evaluation.inputAudit?.promotionBlockers, marketLag: evaluation.marketPairingAudit },
    walkForward: { status: evaluation.walkForwardValidation?.status,
      eligible: evaluation.walkForwardValidation?.eligible, protocol: evaluation.walkForwardValidation?.protocolVersion },
    recommendations: evaluation.recommendationMetrics?.total,
    promotionEligible: false,
    limitations: [
      'Export contains aggregate metrics and evidence hashes, not full settled frozen decision inputs.',
      'Cannot independently re-score event identities, missing probabilities, or unknown severe-missing counts.',
      'Cannot reconstruct home/draw/away or league calibration and temporal out-of-sample metrics from hashes.',
      'No confidence interval for paired score differences without event losses and independent calendar blocks.',
      'Winning probability is not expected return: expected net return requires frozen selected odds times probability minus one.',
      'Frozen snapshots remain unchanged; no threshold tuning, promotion or profitability claim.',
    ],
    requiredNextInput: ['immutable pre-cutoff decisions with full probabilities and same-decision odds',
      'known severe-missing counts and feature clocks', 'settled results with observation clocks',
      'league and event identifiers plus preregistered time split and independent calendar blocks'],
  };
}

if (require.main === module) {
  const directory = process.argv[2];
  if (!directory) throw new Error('usage: node scripts/auditOnlineCalibrationExport.cjs <verified-export-directory>');
  process.stdout.write(`${JSON.stringify(auditExport(path.resolve(directory)), null, 2)}\n`);
}
module.exports = { auditExport, pairedSummary, wilsonInterval };
