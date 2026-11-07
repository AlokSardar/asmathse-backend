/**
 * Structured Logging Utility without Personal Data
 * Strictly masks API keys, JWT bearer tokens, emails, phone numbers, and student PII
 */

function maskSensitiveStrings(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED_GEMINI_KEY]')
    .replace(/bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, '[REDACTED_EMAIL]')
    .replace(/(?:(?:\+|00)880|0)1[3-9]\d{8}/g, '[REDACTED_PHONE]') // Bangladeshi phone formats
    .replace(/(?:\+91|0)?[6-9]\d{9}/g, '[REDACTED_PHONE]'); // Indian phone formats
}

function sanitizeLogPayload(data) {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') return maskSensitiveStrings(data);
  if (typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    return data.map(sanitizeLogPayload);
  }

  const sanitized = {};
  const blockedKeys = [
    'password',
    'token',
    'authorization',
    'apikey',
    'geminiapikey',
    'studentemail',
    'studentroll',
    'phone',
    'whatsapp',
    'fathercontact',
    'fatherwhatsapp',
    'studentwhatsapp',
    'mobile',
    'base64data',
  ];

  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    if (blockedKeys.includes(lowerKey)) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeLogPayload(value);
    } else if (typeof value === 'string') {
      sanitized[key] = maskSensitiveStrings(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

const logger = {
  info: (msg, meta = {}) => {
    console.log(JSON.stringify({
      level: 'info',
      timestamp: new Date().toISOString(),
      message: maskSensitiveStrings(msg),
      ...sanitizeLogPayload(meta),
    }));
  },
  warn: (msg, meta = {}) => {
    console.warn(JSON.stringify({
      level: 'warn',
      timestamp: new Date().toISOString(),
      message: maskSensitiveStrings(msg),
      ...sanitizeLogPayload(meta),
    }));
  },
  error: (msg, meta = {}) => {
    console.error(JSON.stringify({
      level: 'error',
      timestamp: new Date().toISOString(),
      message: maskSensitiveStrings(msg),
      ...sanitizeLogPayload(meta),
    }));
  },
};

module.exports = {
  logger,
  sanitizeLogPayload,
  maskSensitiveStrings,
};
