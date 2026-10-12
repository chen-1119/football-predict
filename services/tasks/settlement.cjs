'use strict';
require('../../scripts/recommendationPlatform/worker.cjs').run({ lane: 'settlement', watch: process.argv.includes('--watch') })
  .then(value => console.log(JSON.stringify(value)))
  .catch(error => { console.error(error.code || 'SETTLEMENT_FAILED'); process.exitCode = 1; });
