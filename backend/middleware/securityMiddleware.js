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
    // Do not rate-limit health checks or static uploads
    return (
      req.path === '/api/health' ||
      req.path === '/health' ||
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
  message: {
    success: false,
    status: 429,
    error: 'Too Many Requests',
    message: 'Too many authentication attempts from this IP address. Please try again after 15 minutes to protect account security.',
  },
});

/**
 * 3. AI Doubt Clearing Rate Limiter
 * Prevents spamming and cost exhaustion on Gemini AI solver endpoints
 */
const doubtLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 40, // Limit each IP to 40 doubt queries per 10 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    status: 429,
    error: 'Too Many Requests',
    message: 'Too many doubt solving queries submitted in a short period. Please wait a few minutes before submitting another doubt.',
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
      /^https:\/\/as-maths-[a-zA-Z0-9_-]+\.vercel\.app$/.test(normalized);

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

module.exports = {
  apiLimiter,
  authLimiter,
  doubtLimiter,
  securityHeaders,
  strictCors,
  corsOptions,
  getAllowedOrigins,
};
