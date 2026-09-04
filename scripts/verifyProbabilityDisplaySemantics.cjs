const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const rootDir = path.resolve(__dirname, '..');
const predictionsPath = path.join(rootDir, 'src/pages/PredictionsList.tsx');
const presentationPath = path.join(rootDir, 'src/services/predictionPresentation.ts');
const predictionsCssPath = path.join(rootDir, 'src/styles/predictions.css');

const readText = (filePath) => fs.readFileSync(filePath, 'utf8');

const executeTypeScriptModule = (source, fileName) => {
  const compiled = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true
    }
  }).outputText;
  const loadedModule = { exports: {} };
  Function('require', 'module', 'exports', compiled)(require, loadedModule, loadedModule.exports);
  return loadedModule.exports;
};

const loadPredictionListFormatters = () => {
  const source = readText(predictionsPath);
  const sourceFile = ts.createSourceFile(
    predictionsPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const wantedDeclarations = new Set([
    'isMissingNumericMetric',
    'formatModelPercent',
    'formatModelSignedDecimal',
    'formatCoveragePercent'
  ]);
  const nodes = sourceFile.statements.filter((statement) => {
    if (ts.isTypeAliasDeclaration(statement)) {
      return statement.name.text === 'OptionalNumericMetric';
    }
    if (!ts.isVariableStatement(statement)) return false;
    return statement.declarationList.declarations.some((declaration) => (
      ts.isIdentifier(declaration.name) && wantedDeclarations.has(declaration.name.text)
    ));
  });

  assert.equal(nodes.length, 5, 'expected the numeric metric type, guard, and three formatters');
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const isolatedSource = `${nodes
    .map((node) => printer.printNode(ts.EmitHint.Unspecified, node, sourceFile))
    .join('\n')}\nexport { formatModelPercent, formatModelSignedDecimal, formatCoveragePercent };`;
  return {
    source,
    ...executeTypeScriptModule(isolatedSource, predictionsPath)
  };
};

const calibratedMatch = (probabilities) => ({
  probabilityModel: {
    version: 'unit-calibrated-v1',
    calibration: { status: 'calibrated' },
    oneXTwo: { unifiedPosterior: probabilities }
  }
});

const hadHomePrediction = { tipCode: '1', oddsPoolCode: 'HAD' };

const run = async () => {
  const {
    source: predictionsSource,
    formatModelPercent,
    formatModelSignedDecimal,
    formatCoveragePercent
  } = loadPredictionListFormatters();

  for (const missingValue of [null, undefined, '', '   ']) {
    assert.equal(formatModelPercent(missingValue), '--');
    assert.equal(formatModelSignedDecimal(missingValue), '--');
    assert.equal(formatCoveragePercent(missingValue), '--');
  }
  assert.equal(formatModelPercent(Number.NaN), '--');
  assert.equal(formatModelPercent(0), '0%', 'a real zero must not be treated as missing');
  assert.equal(formatModelPercent(0.523), '52%');
  assert.equal(formatModelPercent(52.3), '52%');
  assert.equal(formatModelSignedDecimal(0), '0.000');
  assert.equal(formatModelSignedDecimal(0.0093), '+0.009');
  assert.equal(formatModelSignedDecimal(-0.1114), '-0.111');
  assert.equal(formatCoveragePercent(0), '0%');
  assert.equal(formatCoveragePercent(0.9234), '92.3%');

  assert.match(
    predictionsSource,
    /row\.probabilities\.home}% \/ .*row\.probabilities\.draw}% \/ .*row\.probabilities\.away}%/,
    'visible de-vig probabilities must carry an explicit percent suffix'
  );
  assert.match(
    predictionsSource,
    /市场隐含概率（去水）.*Market implied \(de-vigged\)/,
    'the probability column must identify the figures as de-vigged market-implied probabilities'
  );
  assert.match(
    predictionsSource,
    /市场隐含 · 主.*Market implied · H/,
    'the compact probability value must retain a visible market-implied source label'
  );

  const presentation = executeTypeScriptModule(readText(presentationPath), presentationPath);
  const validMatch = calibratedMatch({ home: 50, draw: 30, away: 20 });
  assert.equal(presentation.getCalibratedModelProbability(validMatch, hadHomePrediction), 50);
  assert.equal(presentation.formatCalibratedModelProbability(validMatch, hadHomePrediction), '50%');
  assert.equal(
    presentation.getCalibratedModelProbability(
      calibratedMatch({ home: 50, draw: null, away: 50 }),
      hadHomePrediction
    ),
    null,
    'a null member must invalidate the complete probability triplet'
  );
  assert.equal(
    presentation.getCalibratedModelProbability(
      calibratedMatch({ home: 50, draw: '', away: 50 }),
      hadHomePrediction
    ),
    null,
    'an empty-string member must invalidate the complete probability triplet'
  );
  assert.equal(
    presentation.getCalibratedModelProbability(
      calibratedMatch({ home: 0, draw: 40, away: 60 }),
      hadHomePrediction
    ),
    0,
    'a genuine zero remains a valid probability'
  );
  assert.equal(
    presentation.getCalibratedModelProbability(
      calibratedMatch({ home: 50, draw: 20, away: 20 }),
      hadHomePrediction
    ),
    null,
    'a materially incomplete total must fail closed'
  );

  const unavailableEvidencePrediction = {
    ...hadHomePrediction,
    trustScore: 78,
    multiFactorEvidence: { evidenceScore: 78, dataQuality: 0.62 },
    confidence: {
      available: false,
      band: 'unavailable',
      publicMetrics: {
        modelProbability: 0.5,
        evidenceCompleteness: 0.62,
        evidenceScore: 0.78,
        marketConsistency: 'aligned',
        calibrationSample: null,
        freshnessQuality: null
      }
    }
  };
  assert.equal(presentation.getEvidenceScore(unavailableEvidencePrediction), null,
    'an unavailable aggregate must not fall back to a legacy trust score');
  assert.equal(presentation.formatEvidenceScore(unavailableEvidencePrediction), '--');

  const unavailableBreakdown = presentation.getRecommendationEvidenceBreakdown(
    validMatch,
    unavailableEvidencePrediction
  );
  assert.deepEqual(unavailableBreakdown, {
    modelProbability: 50,
    evidenceCompleteness: 62,
    marketConsistency: 'aligned',
    calibrationSample: null,
    freshnessQuality: null,
    freshnessObservedAt: null,
    freshnessSourceUpdatedAt: null,
    freshnessAsOf: null,
    freshnessEvaluatedAt: null,
    freshnessAgeSeconds: null,
    freshnessSource: null,
    freshnessBasis: 'unavailable'
  });
  assert.equal(presentation.formatEvidenceCompleteness(unavailableBreakdown), '62%');
  assert.equal(presentation.formatMarketConsistency(unavailableBreakdown), '一致');
  assert.equal(presentation.formatCalibrationSample(unavailableBreakdown), '--');
  assert.equal(presentation.formatFreshnessQuality(unavailableBreakdown), '--');

  const missingCoverageBreakdown = presentation.getRecommendationEvidenceBreakdown(validMatch, {
    ...unavailableEvidencePrediction,
    confidence: {
      available: false,
      publicMetrics: {
        marketConsistency: 'unavailable',
        calibrationSample: null,
        freshnessQuality: null
      }
    }
  });
  assert.equal(missingCoverageBreakdown.evidenceCompleteness, null,
    'multi-factor dataQuality must not impersonate a missing input coverage ratio');

  const completeBreakdown = presentation.getRecommendationEvidenceBreakdown(validMatch, {
    ...hadHomePrediction,
    confidence: {
      available: true,
      publicMetrics: {
        evidenceCompleteness: 0.81,
        marketConsistency: 'conflicted',
        calibrationSample: 42,
        freshnessQuality: 0.9
      }
    }
  });
  assert.equal(presentation.formatEvidenceCompleteness(completeBreakdown), '81%');
  assert.equal(presentation.formatMarketConsistency(completeBreakdown, 'en'), 'Conflicted');
  assert.equal(presentation.formatCalibrationSample(completeBreakdown), 'n=42');
  assert.equal(presentation.formatFreshnessQuality(completeBreakdown), '90%');

  const liveShapeMatches = Array.from({ length: 30 }, (_, index) => {
    const publishedPrediction = {
      marketType: 'BEST',
      // Mirrors r655: 13 model-only BEST rows have no official pool, one
      // published BEST is HHAD +3, and the remaining rows are HAD references.
      oddsPoolCode: index < 13 ? undefined : index === 13 ? 'HHAD' : 'HAD',
      handicapLine: index < 13 ? undefined : index === 13 ? '+3' : '0',
      tipCode: index % 3 === 0 ? 'X' : '1',
      confidence: index < 14
        ? {
            publicMetrics: {
              modelProbability: index === 0 ? 0 : 0.41,
              evidenceCompleteness: index < 9 ? 1 : 0.5,
              marketConsistency: index === 0 ? 'aligned' : 'unavailable',
              calibrationSample: 0,
              freshnessQuality: 1,
              freshnessObservedAt: '2026-09-01T11:16:12.590Z',
              freshnessAsOf: '2026-09-01T11:16:12.590Z',
              freshnessAgeSeconds: 36,
              freshnessSource: 'sporttery',
              freshnessBasis: 'observed-at'
            }
          }
        : undefined
    };
    return {
      id: `live-shape-${index + 1}`,
      predictions: [publishedPrediction],
      displayedPrediction: {
        ...publishedPrediction,
        // Reproduces a UI wrapper while preserving the API-published
        // market/pool/line/tip identity. Its local confidence must be ignored.
        confidence: {
          publicMetrics: { marketConsistency: 'aligned' }
        }
      }
    };
  });
  const liveShapeBreakdowns = liveShapeMatches.map((row) => (
    presentation.getPublishedRecommendationEvidenceBreakdown(row, row.displayedPrediction)
  ));
  assert.equal(
    liveShapeBreakdowns.filter((row) => row.marketConsistency === 'aligned').length,
    1,
    'if the API publishes one aligned row, the page must render exactly one aligned row'
  );
  assert.equal(
    liveShapeBreakdowns.filter((row) => row.marketConsistency === 'unavailable').length,
    29,
    'API-unavailable or missing market consistency must remain unavailable'
  );
  assert.equal(
    liveShapeBreakdowns.filter((row) => row.modelProbability !== null).length,
    14,
    'the r655-shaped page may show only the 14 API-published selected-direction model probabilities'
  );
  assert.equal(
    liveShapeBreakdowns[0].modelProbability,
    0,
    'a genuine API-published zero probability must remain visible as zero'
  );
  assert.equal(
    liveShapeBreakdowns.filter((row) => row.evidenceCompleteness !== null).length,
    14,
    'the page must not create evidence completeness for the 16 API-missing rows'
  );
  assert.equal(
    liveShapeBreakdowns.filter((row) => row.freshnessObservedAt !== null).length,
    14,
    'the page must not create observation clocks for the 16 API-missing rows'
  );
  assert.equal(
    presentation.getPublishedRecommendationEvidenceBreakdown(
      { predictions: [] },
      unavailableEvidencePrediction
    ).marketConsistency,
    'unavailable',
    'a client-only prediction cannot publish its derived market consistency'
  );
  assert.equal(
    presentation.getPublishedRecommendationEvidenceBreakdown(
      { predictions: [{ ...hadHomePrediction, marketType: 'BEST', handicapLine: '0' }] },
      {
        ...hadHomePrediction,
        marketType: 'BEST',
        oddsPoolCode: 'HHAD',
        handicapLine: '-1',
        confidence: { publicMetrics: { marketConsistency: 'aligned' } }
      }
    ).marketConsistency,
    'unavailable',
    'a mismatched pool or handicap line cannot borrow another published confidence row'
  );

  const predictionsCss = readText(predictionsCssPath);
  const mobileSectionStart = predictionsCss.indexOf('@media (max-width: 480px)');
  const mobileSection = predictionsCss.slice(mobileSectionStart);
  assert.ok(mobileSectionStart >= 0);
  const mobileHeadingBlock = mobileSection.match(/\.predictions-v4__heading p\s*{([^}]*)}/)?.[1] || '';
  assert.match(mobileHeadingBlock, /display:\s*-webkit-box;/,
    'analysis hero description must remain readable but bounded at the <=480px breakpoint');
  assert.match(mobileHeadingBlock, /overflow:\s*hidden;/);
  assert.match(mobileHeadingBlock, /-webkit-line-clamp:\s*2;/);

  console.log(JSON.stringify({
    ok: true,
    verifier: 'probability-display-semantics',
    assertions: 56
  }, null, 2));
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
