/**
 * Robust Password Policy Validator
 * Server is the authority.
 */

const BLOCKED_BASE_STRINGS = [
  'testpassword',
  'adminpassword',
  'teacherpass',
  'studentpass',
  'adminpass',
  'smoketest',
  'password',
  'welcome',
  'qwerty',
  'asmaths',
  'educator',
  'faculty',
  'professor',
  'administrator',
  'changeme',
  'letmein',
  'secret',
  'iloveyou',
  'football',
  'monkey',
  'dragon',
  'master',
];

const BLOCKED_SPECIFIC_STRINGS = [
  'testpassword123!',
  'adminpassword123!',
  'teacherpass123!',
  'studentpass123!',
  'adminpass123!',
  'smoketest2026!',
  'password123!',
  'welcome123!',
  'qwerty123!',
];

/**
 * Validates a password candidate against corporate faculty security policy.
 * @param {string} password - The password candidate
 * @param {object} user - Optional user context ({ name, email })
 * @returns {{ valid: boolean, errors: string[], score: number }}
 */
function validatePasswordPolicy(password, user = {}) {
  const errors = [];
  if (!password || typeof password !== 'string') {
    return { valid: false, errors: ['Password must be a non-empty string.'], score: 0 };
  }

  // 1. Length check: Minimum 10 characters
  if (password.length < 10) {
    errors.push('Password must be at least 10 characters long.');
  }

  // 2. Character diversity checks
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);

  if (!hasUpper) errors.push('Password must contain at least one uppercase letter (A-Z).');
  if (!hasLower) errors.push('Password must contain at least one lowercase letter (a-z).');
  if (!hasNumber) errors.push('Password must contain at least one digit (0-9).');
  if (!hasSpecial) errors.push('Password must contain at least one special character (!@#$%^&* etc.).');

  const lowerPass = password.toLowerCase();
  const alphanumericOnly = lowerPass.replace(/[^a-z0-9]/g, '');

  // 3. Specific blocklist checks (case-insensitive with/without symbols)
  for (const blocked of BLOCKED_SPECIFIC_STRINGS) {
    const blockedClean = blocked.replace(/[^a-z0-9]/g, '');
    if (lowerPass === blocked || alphanumericOnly === blockedClean) {
      errors.push('Password is in the common/compromised password blocklist.');
      break;
    }
  }

  // 4. Base dictionary blocklist check
  if (!errors.some((e) => e.includes('blocklist'))) {
    for (const base of BLOCKED_BASE_STRINGS) {
      if (alphanumericOnly.startsWith(base) || alphanumericOnly.endsWith(base)) {
        errors.push(`Password contains a commonly exploited pattern ("${base}").`);
        break;
      }
    }
  }

  // 5. User identity parts check (name, email parts)
  if (user) {
    if (user.name && typeof user.name === 'string') {
      const nameParts = user.name
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((p) => p.length >= 3);
      for (const part of nameParts) {
        if (lowerPass.includes(part)) {
          errors.push('Password must not contain parts of your name.');
          break;
        }
      }
    }

    if (user.email && typeof user.email === 'string') {
      const emailLocal = user.email.toLowerCase().split('@')[0] || '';
      const emailParts = emailLocal
        .split(/[^a-z0-9]+/)
        .filter((p) => p.length >= 3);
      for (const part of emailParts) {
        if (lowerPass.includes(part)) {
          errors.push('Password must not contain parts of your email address.');
          break;
        }
      }
    }
  }

  // 6. Sequential or repeated character checks (e.g., "12345", "aaaaa")
  if (/(.)\1{3,}/.test(password)) {
    errors.push('Password must not contain repeated characters (4 or more in a row).');
  }

  const sequentialPatterns = ['12345', '23456', '34567', '45678', '56789', 'abcdef', 'bcdefg', 'cdefgh', 'qwerty'];
  for (const seq of sequentialPatterns) {
    if (lowerPass.includes(seq)) {
      errors.push('Password must not contain sequential character runs (e.g. 12345, qwerty).');
      break;
    }
  }

  // Calculate score (0 to 4)
  let score = 0;
  if (password.length >= 10) score += 1;
  if (password.length >= 14) score += 1;
  if (hasUpper && hasLower && hasNumber && hasSpecial) score += 1;
  if (errors.length === 0) score += 1;

  return {
    valid: errors.length === 0,
    errors,
    score: Math.min(4, score),
  };
}

module.exports = {
  validatePasswordPolicy,
  BLOCKED_BASE_STRINGS,
  BLOCKED_SPECIFIC_STRINGS,
};
