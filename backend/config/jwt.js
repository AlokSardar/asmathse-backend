const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const knownWeakSecrets = [
  'asmaths_secret_jwt_key_2026_cluster0',
  'secret',
  'jwtsecret',
  '123456',
  'changeme',
  'supersecret',
  'password',
];

let testSessionSecret = null;

/**
 * Centralized JWT secret resolver.
 * - Production: Strictly requires non-default secret >= 32 characters.
 * - Development/Staging: Strictly requires JWT_SECRET in environment; throws if missing.
 * - Test: Dynamically generates a secure per-session secret if JWT_SECRET is omitted.
 */
function getJwtSecret() {
  const secret = (process.env.JWT_SECRET || '').trim();
  const env = process.env.NODE_ENV || 'development';

  if (!secret) {
    if (env === 'test') {
      if (!testSessionSecret) {
        testSessionSecret = crypto.randomBytes(32).toString('hex');
      }
      return testSessionSecret;
    }
    throw new Error('❌ [FATAL CONFIG ERROR]: JWT_SECRET environment variable is missing. Server cannot sign or verify tokens.');
  }

  if (env === 'production') {
    if (secret.length < 32 || knownWeakSecrets.includes(secret)) {
      throw new Error(
        `❌ [FATAL SECURITY ERROR]: Production requires a strong, non-default JWT_SECRET of at least 32 characters (current length: ${secret.length}).`
      );
    }
  }

  return secret;
}

/**
 * Sign payload using the centralized, validated JWT secret.
 */
function signToken(payload, options = {}) {
  const secret = getJwtSecret();
  return jwt.sign(payload, secret, { expiresIn: '30d', ...options });
}

/**
 * Verify token using the centralized, validated JWT secret.
 */
function verifyToken(token, options = {}) {
  const secret = getJwtSecret();
  return jwt.verify(token, secret, options);
}

module.exports = {
  getJwtSecret,
  signToken,
  verifyToken,
  knownWeakSecrets,
};
