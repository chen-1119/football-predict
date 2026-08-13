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

  const predictionsCss = readText(predictionsCssPath);
  const mobileSectionStart = predictionsCss.indexOf('@media (max-width: 390px)');
  const mobileSection = predictionsCss.slice(mobileSectionStart);
  assert.ok(mobileSectionStart >= 0);
  assert.match(
    mobileSection,
    /\.predictions-v4__heading p\s*{\s*display: none;/,
    'analysis hero description must be hidden at the <=390px breakpoint'
  );

  console.log(JSON.stringify({
    ok: true,
    verifier: 'probability-display-semantics',
    assertions: 33
  }, null, 2));
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
