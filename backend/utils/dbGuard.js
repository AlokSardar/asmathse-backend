const mongoose = require('mongoose');

/**
 * Validates that the currently connected database or target database name
 * is strictly a dev or test database.
 * Throws an Error if the database name does not contain "dev" or "test",
 * unless ALLOW_PROD_MIGRATION is explicitly set to 'true'.
 *
 * @param {string} [explicitDbName] - Optional explicit database name to check
 */
function assertDevOrTestDatabase(explicitDbName) {
  if (process.env.ALLOW_PROD_MIGRATION === 'true') {
    return true;
  }

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
        // Fallback simple regex extraction
        const match = process.env.MONGO_URI.match(/\/([^/?]+)(\?|$)/);
        if (match) dbName = match[1];
      }
    }
  }

  const name = String(dbName || '').toLowerCase().trim();

  // If connected/checking and name does NOT contain 'dev' or 'test'
  if (name && !name.includes('dev') && !name.includes('test')) {
    const error = new Error(`Database safety guard: active database "${dbName}" is not a dev or test database. Aborting.`);
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
