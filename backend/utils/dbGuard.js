/**
 * Database Safety Guard
 * Restricts all operations strictly to local/staging DEV or TEST databases.
 * Throws a fatal error immediately if the active database is production,
 * UNLESS explicitly authorized in production via ALLOW_PROD_MIGRATION=true.
 */
const mongoose = require('mongoose');

function assertDevOrTestDatabase(explicitDbName, options = {}) {
  let dbName = explicitDbName;
  if (!dbName) {
    if (mongoose.connection && mongoose.connection.name) {
      dbName = mongoose.connection.name;
    } else if (process.env.MONGO_URI) {
      try {
        const urlPart = process.env.MONGO_URI.split('/').pop().split('?')[0];
        dbName = urlPart;
      } catch (_) {}
    }
  }

  const normalized = String(dbName || '').trim().toLowerCase();

  // Strict refusal if database name is empty
  if (!normalized) {
    throw new Error('❌ [CRITICAL DB GUARD]: Could not determine active database name. Operation aborted.');
  }

  // Secure production override check: ONLY permitted when ALLOW_PROD_MIGRATION is explicitly 'true'
  const isProdOverrideActive = process.env.ALLOW_PROD_MIGRATION === 'true' || options.allowProd === true;

  if (isProdOverrideActive && (normalized === 'asmaths_lms' || normalized === 'asmaths_lms_prod' || normalized.includes('production'))) {
    console.warn(`⚠️ [DB GUARD PROD OVERRIDE]: Operations against production database "${dbName}" authorized via ALLOW_PROD_MIGRATION=true.`);
    return true;
  }

  // Strict refusal if name contains production identifiers or equals asmaths_lms without dev/test
  if (normalized === 'asmaths_lms' || normalized === 'asmaths_lms_prod' || normalized.includes('production')) {
    throw new Error(
      `❌ [CRITICAL DB GUARD VIOLATION]: Production database detected: "${dbName}". ` +
      'All tests, migrations, and workspace scripts must strictly run against DEV/TEST databases only! ' +
      'To execute an authorized production migration in Render/staging, explicitly set ALLOW_PROD_MIGRATION=true.'
    );
  }

  // Must contain 'dev' or 'test'
  if (!normalized.includes('dev') && !normalized.includes('test')) {
    throw new Error(
      `❌ [CRITICAL DB GUARD VIOLATION]: Active database "${dbName}" does not contain "dev" or "test". Operation aborted. ` +
      'To execute an authorized production migration in Render/staging, explicitly set ALLOW_PROD_MIGRATION=true.'
    );
  }

  return true;
}

module.exports = {
  assertDevOrTestDatabase,
};
