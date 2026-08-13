const {
  isTrustedOfficialFinal,
  officialSportteryResultUrl,
} = require("../src/services/matchLifecycle.cjs");

const hasFiveHundredResult = (match) => String(
  match?.resultSource || match?.externalSignals?.fiveHundred?.result?.source || ""
).startsWith("500.com");

const hasAcceptedResultOnlySource = (match) => Boolean(
  hasFiveHundredResult(match)
  || isTrustedOfficialFinal(match)
  || officialSportteryResultUrl(match)
);

module.exports = {
  hasAcceptedResultOnlySource,
  hasFiveHundredResult,
};
