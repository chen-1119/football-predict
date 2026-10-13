'use strict';
console.log(JSON.stringify(require('../services/release/componentPolicy.cjs').plan(process.argv[2]), null, 2));
