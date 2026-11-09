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
    } else if (mongoose.connection && mongoose.connection.db && mongoose.connection.db.databaseName) {
      dbName = mongoose.connection.db.databaseName;
    } else if (process.env.MONGO_URI) {
      try {
        const uri = new URL(process.env.MONGO_URI.replace('mongodb+srv://', 'http://').replace('mongodb://', 'http://'));
        dbName = uri.pathname.replace(/^\//, '');
      } catch {
        const match = process.env.MONGO_URI.match(/\/([^/?]+)(\?|$)/);
        if (match) dbName = match[1];
      }
    }
  }

  const normalized = String(dbName || '').trim().toLowerCase();

  // Strict refusal if database name is empty
  if (!normalized) {
    const error = new Error('❌ [CRITICAL DB GUARD]: Could not determine active database name. Operation aborted.');
    error.statusCode = 403;
    throw error;
  }

  // Secure production override check: ONLY permitted when ALLOW_PROD_MIGRATION is explicitly 'true'
  const isProdOverrideActive = process.env.ALLOW_PROD_MIGRATION === 'true' || options.allowProd === true;

  if (isProdOverrideActive && (normalized === 'asmaths_lms' || normalized === 'asmaths_lms_prod' || normalized.includes('production'))) {
    console.warn(`⚠️ [DB GUARD PROD OVERRIDE]: Operations against production database "${dbName}" authorized via ALLOW_PROD_MIGRATION=true.`);
    return true;
  }

  // Strict refusal if name contains production identifiers or equals asmaths_lms without dev/test
  if (normalized === 'asmaths_lms' || normalized === 'asmaths_lms_prod' || normalized.includes('production')) {
    const error = new Error(
      `❌ [CRITICAL DB GUARD VIOLATION]: Production database detected: "${dbName}". ` +
      'All tests, migrations, and workspace scripts must strictly run against DEV/TEST databases only! ' +
      'To execute an authorized production migration in Render/staging, explicitly set ALLOW_PROD_MIGRATION=true.'
    );
    error.statusCode = 403;
    throw error;
  }

  // Must contain 'dev' or 'test'
  if (!normalized.includes('dev') && !normalized.includes('test')) {
    const error = new Error(
      `❌ [CRITICAL DB GUARD VIOLATION]: Active database "${dbName}" does not contain "dev" or "test". Operation aborted. ` +
      'To execute an authorized production migration in Render/staging, explicitly set ALLOW_PROD_MIGRATION=true.'
    );
    error.statusCode = 403;
    throw error;
  }

  return true;
}

function isDevOrTestDatabase(explicitDbName) {
  try {
    assertDevOrTestDatabase(explicitDbName);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  assertDevOrTestDatabase,
  isDevOrTestDatabase,
};
