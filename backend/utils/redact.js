/**
 * Redaction utility for logging and audit serialization
 * Masks sensitive authentication parameters: passwords, tokens, API keys
 */

const SENSITIVE_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'temporarypassword',
  'temppassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'jwt',
  'secret',
  'authorization',
  'apikey',
]);

function redactObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, depth + 1));
  }

  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase().replace(/[^a-z]/g, '');
    if (SENSITIVE_KEYS.has(lowerKey)) {
      clean[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      clean[key] = redactObject(value, depth + 1);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

function maskIp(ip) {
  if (!ip || typeof ip !== 'string') return 'Unknown';
  if (ip.includes(':')) {
    // IPv6: mask last 2 segments
    const parts = ip.split(':');
    if (parts.length > 2) {
      parts[parts.length - 1] = 'xxxx';
      parts[parts.length - 2] = 'xxxx';
      return parts.join(':');
    }
    return ip;
  }
  // IPv4: mask last octet (e.g., 192.168.1.xxx)
  const parts = ip.split('.');
  if (parts.length === 4) {
    parts[3] = 'xxx';
    return parts.join('.');
  }
  return ip;
}

module.exports = {
  redactObject,
  maskIp,
};
