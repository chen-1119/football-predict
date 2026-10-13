'use strict';
const {spawnSync}=require('node:child_process'),path=require('node:path');
const tests=['tests/publishedReviewCoverage.test.cjs','tests/publishedReviewCoverageRepository.test.cjs',
 'tests/publishedReviewCoverageIntegration.test.cjs','tests/recommendation-review-page.test.cjs','tests/publishedReviewCoverageUi.test.cjs'];
const requiredEntries=['scripts/verifyPublishedReviewCoverage.cjs',
 "src/services/publishedReviewCoverage.ts","src/components/recommendations/PublishedReviewCoverage.tsx","src/components/recommendations/published-review-coverage.css","src/services/recommendationCenterView.ts","src/services/recommendationReviewPage.ts","src/components/recommendations/RecommendationCenter.tsx","src/components/recommendations/DailyBulletinPanel.tsx",
 'scripts/recommendationPlatform/publishedReviewCoverage.cjs','scripts/recommendationPlatform/publishedReviewCoverageRepository.cjs',
 'scripts/recommendationPlatform/repository.cjs','scripts/recommendationPlatform/runtime.cjs','server/recommendationReviewPage.cjs',
 'tests/fixtures/coverageFixtures.cjs','tests/fixtures/coverageClient.cjs',...tests];
function run(){const child=spawnSync(process.execPath,['--test','--test-reporter=tap',...tests],{
 cwd:path.resolve(__dirname,'..'),encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:2*1024*1024});
 const count=name=>Number(child.stdout?.match(new RegExp('^# '+name+' (\\d+)$','m'))?.[1]??NaN);
 if(child.status!==0||count('tests')<79||count('pass')!==count('tests')||count('fail')!==0||count('skipped')!==0)
  throw Error('Published review coverage contract failed: '+String(child.error?.message||child.stderr||child.stdout).slice(-4000));
 return {ok:true,tests:count('tests'),passed:count('pass'),skipped:0,scope:'synthetic signature/ACK replay, exact event history admission, read-only API; not live settlement acceptance'};
}
if(require.main===module)process.stdout.write(JSON.stringify(run()));
module.exports={run,requiredEntries,tests};
