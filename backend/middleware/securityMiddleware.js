const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');

/**
 * 1. Global API Rate Limiter
 * Guards the entire /api surface against brute-force crawlers, flood bots, and denial-of-service spam
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 600, // Limit each IP to 600 requests per 15 minutes window
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    success: false,
    status: 429,
    error: 'Too Many Requests',
    message: 'Too many requests from this IP address. Please try again after 15 minutes.',
  },
  skip: (req) => {
    // Do not rate-limit health checks, pingers, or static uploads
    return (
      req.path === '/api/health' ||
      req.path === '/health' ||
      req.path === '/healthz' ||
      req.path === '/api/health/ping' ||
      req.path.startsWith('/uploads') ||
      req.path.startsWith('/api/uploads')
    );
  },
});

/**
 * 2. Sensitive Authentication Rate Limiter
 * Applied on login, OTP dispatch, registration, and password recovery endpoints
 * to strictly prevent brute-force credential attacks
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Limit each IP to 30 attempts per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const ip = req.ip || req.connection?.remoteAddress || '';
    return ip.includes('127.0.0.1') || ip === '::1' || process.env.NODE_ENV === 'test';
  },
  message: {
    success: false,
    status: 429,
    error: 'Too Many Requests',
    message: 'Too many authentication attempts from this IP address. Please try again after 15 minutes to protect account security.',
  },
});

/**
 * Helper to generate rate limiter key:
 * Uses authenticated user ID if present (or decodes Bearer JWT token if available),
 * falling back to client IP only for unauthenticated callers.
 * This guarantees an entire college classroom or campus sharing a single Wi-Fi / NAT IP
 * will never block each other from submitting or reviewing doubts.
 */
const getAuthUserOrIpKey = (req) => {
  if (req.user?._id) return `user_${req.user._id}`;
  if (req.user?.id) return `user_${req.user.id}`;
  try {
    const authHeader = req.headers?.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const jwt = require('jsonwebtoken');
      const decoded = jwt.decode(token);
      if (decoded?.id || decoded?._id) {
        return `user_${decoded.id || decoded._id}`;
      }
    }
  } catch (err) {
    // ignore decode error and fallback to IP
  }
  return `ip_${req.ip || req.connection?.remoteAddress || '127.0.0.1'}`;
};

/**
 * 3. AI Doubt Clearing Rate Limiter
 * Per-user rate limiter keyed by authenticated student ID.
 * Generously sized for daily quota of 5 doubts + transcription revisions + 15 follow-ups (60 submissions / 15m)
 */
const doubtLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60, // Limit each user to 60 doubt submissions / follow-ups per 15 minutes window
  keyGenerator: getAuthUserOrIpKey,
  validate: { keyGeneratorIpFallback: false, xForwardedForHeader: false },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.DISABLE_RATE_LIMITING === 'true',
  message: {
    success: false,
    status: 429,
    error: 'Too Many Requests',
    message: 'Too many doubt solving queries submitted in a short period. Please wait a few minutes before submitting another doubt.',
  },
});

/**
 * 3b. High-Frequency General Read Rate Limiter for Doubts Queue & My Doubts
 * Generously sized for real-time polling (300 reads / min per authenticated user)
 */
const doubtGeneralLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 300, // Limit each user to 300 reads/polls per minute
  keyGenerator: getAuthUserOrIpKey,
  validate: { keyGeneratorIpFallback: false, xForwardedForHeader: false },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.DISABLE_RATE_LIMITING === 'true',
  message: {
    success: false,
    status: 429,
    error: 'Too Many Requests',
    message: 'Too many requests on doubts service. Please slow down.',
  },
});

/**
 * 3c. Heavy Operations Rate Limiter (CSV Export, Complex Analytics Aggregation)
 */
const analyticsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 60, // Limit each user to 60 export/analytics requests per 5 minutes
  keyGenerator: getAuthUserOrIpKey,
  validate: { keyGeneratorIpFallback: false, xForwardedForHeader: false },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.DISABLE_RATE_LIMITING === 'true',
  message: {
    success: false,
    status: 429,
    error: 'Too Many Requests',
    message: 'Too many analytics or export requests. Please wait a moment before trying again.',
  },
});

/**
 * 4. HTTP Security Headers via Helmet
 * Secures HTTP response headers against cross-site scripting (XSS), clickjacking, MIME sniffing
 * while maintaining compatibility with KaTeX fonts and PDF embeds.
 */
const securityHeaders = helmet({
  contentSecurityPolicy: false, // Ensures KaTeX CDN fonts, MathJax, and PDF previews render smoothly
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allows uploaded PDFs and images to be embedded
  crossOriginEmbedderPolicy: false,
  frameguard: { action: 'sameorigin' }, // Clickjacking protection
  xssFilter: true, // XSS filter
  noSniff: true, // X-Content-Type-Options: nosniff
});

/**
 * 5. Strict Production CORS Configuration
 * Explicitly allows the live production frontend domain (via process.env.FRONTEND_URL)
 * along with supported development origins.
 */
const getAllowedOrigins = () => {
  const list = [];
  if (process.env.FRONTEND_URL) {
    const envOrigins = process.env.FRONTEND_URL.split(',').map(u => u.trim().replace(/\/+$/, '')).filter(Boolean);
    list.push(...envOrigins);
  }
  if (process.env.ALLOWED_ORIGINS) {
    const envOrigins = process.env.ALLOWED_ORIGINS.split(',').map(u => u.trim().replace(/\/+$/, '')).filter(Boolean);
    list.push(...envOrigins);
  }

  // Trusted production and development origins
  const defaultOrigins = [
    'https://asmathse-frontend.onrender.com',
    'https://as-maths-educator.vercel.app',
    'https://asmaths-educator.vercel.app',
    'https://asmathseducator.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:5000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:3000',
  ];

  for (const d of defaultOrigins) {
    if (!list.includes(d)) list.push(d);
  }

  return list;
};

const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser requests (mobile apps, server-to-server curl, health checks)
    if (!origin) return callback(null, true);

    const normalized = origin.trim().replace(/\/+$/, '');
    const allowed = getAllowedOrigins();

    const isAllowed =
      allowed.includes(normalized) ||
      /^https:\/\/([a-zA-Z0-9_-]+\.)?onrender\.com$/.test(normalized) ||
      /^https:\/\/as-?maths-?[a-zA-Z0-9_-]*\.vercel\.app$/.test(normalized);

    if (isAllowed) {
      return callback(null, true);
    }

    return callback(new Error(`CORS Error: Origin "${origin}" is not authorized by server security policy.`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
  maxAge: 86400,
};

const strictCors = cors(corsOptions);

/**
 * 4. Evaluation Workspace & Marking Rate Limiter
 * Keyed by authenticated User ID (falls back to IP).
 * Generously accommodates rapid on-screen marking & draft autosaves (180 actions / min per user).
 */
const evaluationWorkspaceLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 180, // 180 actions/min per user
  keyGenerator: getAuthUserOrIpKey,
  validate: { keyGeneratorIpFallback: false, xForwardedForHeader: false },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.DISABLE_RATE_LIMITING === 'true' || process.env.NODE_ENV === 'test',
  message: {
    success: false,
    status: 429,
    error: 'Too Many Requests',
    message: 'Too many evaluation marking requests in a short period. Please slow down.',
  },
});

/**
 * 4b. Student Exam Submission Rate Limiter
 * Keyed by authenticated User ID (prevents automated bot flooding while never blocking NAT/campus peers).
 */
const evaluationSubmissionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 exam submissions per 15 minutes window per user
  keyGenerator: getAuthUserOrIpKey,
  validate: { keyGeneratorIpFallback: false, xForwardedForHeader: false },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.DISABLE_RATE_LIMITING === 'true' || process.env.NODE_ENV === 'test',
  message: {
    success: false,
    status: 429,
    error: 'Too Many Requests',
    message: 'Too many exam submissions submitted in a short period. Please wait before submitting again.',
  },
});

/**
 * 5. Tests and Schedule Workspace Rate Limiter
 * Per-user rate limiter keyed by authenticated faculty/admin ID (200 requests/min).
 */
const testsScheduleLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 200,
  keyGenerator: getAuthUserOrIpKey,
  validate: { keyGeneratorIpFallback: false, xForwardedForHeader: false },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.DISABLE_RATE_LIMITING === 'true' || process.env.NODE_ENV === 'test',
  message: {
    success: false,
    status: 429,
    error: 'Too Many Requests',
    message: 'Too many requests on Tests and Schedule workspace. Please slow down.',
  },
});

module.exports = {
  testsScheduleLimiter,
  apiLimiter,
  authLimiter,
  doubtLimiter,
  doubtGeneralLimiter,
  analyticsLimiter,
  evaluationWorkspaceLimiter,
  evaluationSubmissionLimiter,
  securityHeaders,
  strictCors,
  corsOptions,
  getAllowedOrigins,
};
