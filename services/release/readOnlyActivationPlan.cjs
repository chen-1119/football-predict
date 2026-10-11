'use strict';
const { validate } = require('./componentSigning.cjs');
function plan(envelope, actual, now = Date.now()) {
  const component = validate(envelope);
  const reject = reason => { throw Object.assign(new Error(reason), { code: reason }); };
  // Writer ownership is deliberately excluded until the existing publisher
  // has a tested fence and a durable handover/rollback transaction.
  if (!['read-api', 'web'].includes(component.component)) reject('WRITER_HANDOVER_UNIMPLEMENTED');
  if (actual.signatureVerified !== true || actual.archiveSha256 !== component.archiveSha256 || actual.sourceHead !== component.head) reject('SIGNED_ARTIFACT_IDENTITY_REQUIRED');
  if (actual.platform !== 'linux' || (component.component === 'web' && component.artifactPlatform !== 'linux')) reject('LINUX_RUNTIME_REQUIRED');
  if (actual.runtimeVerified !== true || actual.runtimeArchiveSha256 !== component.archiveSha256) reject('EXACT_ARTIFACT_RUNTIME_REQUIRED');
  if (actual.apiContract !== component.apiContract || actual.schemaSha256 !== component.schemaSha256) reject('COMPONENT_CONTRACT_MISMATCH');
  if (actual.releaseLockHeld !== true || actual.releaseProcesses?.length !== 0 || actual.recoveryPending !== false
    || !/^[a-f0-9]{64}$/.test(actual.appSha256 || '') || actual.appSha256 !== actual.completeSha256) reject('RELEASE_BOUNDARY_UNPROVEN');
  if (actual.databaseOid !== '28598409' || actual.databaseWritesEnabled !== false || actual.migrations !== false) reject('READ_ONLY_PRODUCTION_DATABASE_REQUIRED');
  if (!Number.isSafeInteger(actual.observedAtMs) || actual.observedAtMs > now || now - actual.observedAtMs > 60_000) reject('FRESH_BOUNDARY_REQUIRED');
  if (!Number.isSafeInteger(actual.leaseStartedAtMs) || actual.leaseStartedAtMs > now || now - actual.leaseStartedAtMs >= 900_000
    || !Number.isSafeInteger(actual.elapsedMonotonicMs) || actual.elapsedMonotonicMs < 0 || actual.elapsedMonotonicMs >= 900_000) reject('ACTIVATION_LEASE_EXPIRED');
  if (!Number.isSafeInteger(actual.requiredBytes) || actual.requiredBytes < component.archiveBytes * 2
    || !Number.isSafeInteger(actual.availableBytes) || actual.availableBytes < actual.requiredBytes) reject('COMPONENT_CAPACITY_UNPROVEN');
  if (actual.loopbackPortAvailable !== true || actual.existingProductionServicesUnchanged !== true) reject('SIDE_BY_SIDE_BOUNDARY_REQUIRED');
  return { version: 'read-only-component-activation-plan-v1', component: component.component, archiveSha256: component.archiveSha256,
    databaseCopies: 0, migrations: false, productionWriterStarted: false, originalServicesRestarted: false,
    operations: ['Verify exact archive and dependency inventory', 'Create-only isolated component directory',
      'Start this component on its dedicated loopback port', 'Verify authenticated API and browser contracts',
      'Atomically select this component code pointer; preserve the previous pointer and database commits'],
    rollback: 'Stop only the new component; restore its previous code pointer. Preserve PostgreSQL, frozen recommendations, ACKs and settlement.',
    executableControllerImplemented: false, installed: false };
}
module.exports = { plan };
