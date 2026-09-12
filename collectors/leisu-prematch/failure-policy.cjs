'use strict';

// Only explicitly recognized transport failures retry automatically. Login,
// blocking pages, malformed content and identity conflicts require inspection.
function shouldPauseSource(result) {
  if (['blocked', 'login_required', 'conflict'].includes(result?.status)) return true;
  if (result?.status !== 'parse_error') return false;
  if (['page-timeout', 'page-read-failed'].includes(result.reason)) return false;
  if (result.reason === 'non-success-http-status' && Number.isInteger(result.httpStatus) && result.httpStatus >= 500 && result.httpStatus <= 599) return false;
  return true;
}

module.exports = { shouldPauseSource };
