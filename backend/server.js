const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const connectDB = require('./config/db');

// Load environment variables
dotenv.config();

// Fail-Fast Startup Validation for Required Security & DB Credentials
const requiredEnvVars = ['MONGO_URI', 'JWT_SECRET'];
const missingRequired = requiredEnvVars.filter((k) => !process.env[k] || !process.env[k].trim());
if (missingRequired.length > 0) {
  console.error(`❌ [FATAL CONFIG ERROR]: Missing required environment variable(s): ${missingRequired.join(', ')}`);
  console.error('Server cannot start without essential security and database credentials. Exiting immediately.');
  process.exit(1);
}

// Connect to MongoDB Atlas
connectDB();

const app = express();

// Trust proxy for accurate client IP identification on Render / cloud reverse proxies
app.set('trust proxy', 1);

// Reverse Proxy & Client IP Diagnostic Logger (Logs first incoming client IP after startup for verification)
let hasLoggedClientIp = false;
app.use((req, res, next) => {
  if (!hasLoggedClientIp && req.path.startsWith('/api')) {
    const rawForwarded = req.headers['x-forwarded-for'];
    console.log(`[PROXY DIAGNOSTIC] Express identified Client IP: "${req.ip}" (X-Forwarded-For: "${rawForwarded || 'none'}")`);
    hasLoggedClientIp = true;
  }
  next();
});

// Security Hardening: HTTP Security Headers via Helmet (XSS, Clickjacking, MIME sniffing protection)
const {
  securityHeaders,
  strictCors,
  apiLimiter,
  authLimiter,
  doubtLimiter,
} = require('./middleware/securityMiddleware');

const { verifyRoleSegregation } = require('./middleware/authMiddleware');

app.use(securityHeaders);

// Strict CORS Configuration: allows live production frontend domain and authorized origins
app.use(strictCors);

// Global API Rate Limiter
app.use('/api', apiLimiter);

// Role-Segregation Guard: strictly blocks student privilege escalation to administrative endpoints
app.use(verifyRoleSegregation);

// Ensure local uploads directory exists (Atlas Free Tier file system storage)
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
const privateUploadsDir = path.join(uploadsDir, 'private_scripts');
if (!fs.existsSync(privateUploadsDir)) {
  fs.mkdirSync(privateUploadsDir, { recursive: true });
}

// Block unauthenticated direct access to private student answer scripts and legacy submissions
app.use(['/uploads', '/api/uploads'], (req, res, next) => {
  const cleanPath = (req.path || '').toLowerCase();
  if (
    cleanPath.includes('/private_scripts') ||
    cleanPath.includes('submission_') ||
    cleanPath.includes('script_') ||
    cleanPath.includes('answersheet_')
  ) {
    return res.status(403).json({
      message: 'Forbidden: Direct static access to student answer scripts is prohibited. Access via authenticated endpoint /api/evaluations/:id/script-file.'
    });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  next();
});
app.use('/uploads', express.static(uploadsDir));
app.use('/api/uploads', express.static(uploadsDir));

// High-capacity body parser for base64 documents (PDFs, question sheets, diagrams)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Route files
const authRoutes = require('./routes/authRoutes');
const contentRoutes = require('./routes/contentRoutes');
const evaluationRoutes = require('./routes/evaluationRoutes');
const activityRoutes = require('./routes/activityRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const adminRoutes = require('./routes/adminRoutes');
const studentRoutes = require('./routes/studentRoutes');
const testRoutes = require('./routes/testRoutes');
const feeRoutes = require('./routes/feeRoutes');
const approvalRoutes = require('./routes/approvalRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const aiRoutes = require('./routes/aiRoutes');
const doubtRoutes = require('./routes/doubtRoutes');
const accountRoutes = require('./routes/accountRoutes');

// Mount routers with sensitive route protection
app.use('/api/upload', uploadRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/doubts', doubtRoutes);
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/approvals', approvalRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/evaluations', evaluationRoutes);
app.use('/api/analytics', activityRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/notices', notificationRoutes);
app.use('/api/admin', adminRoutes);

// Rate-limit doubt submission endpoints against automated spam/abuse
app.use(['/api/student/solve-doubt', '/api/student/doubt', '/student/solve-doubt', '/student/doubt'], doubtLimiter);
app.use(['/api/student', '/student'], studentRoutes);
app.use('/api/tests', testRoutes);
app.use('/api/fees', feeRoutes);
app.use('/api/account', accountRoutes);


// ── Lightweight Health Routes for External Uptime Pingers ────────────────────────
// Responds with instant 200 OK without database queries or rate limiting.
app.all(['/health', '/healthz', '/api/health/ping'], (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    service: 'as-maths-educator-backend',
  });
});

// Database Health & Status check endpoint
app.get('/api/health', async (req, res) => {
  const state = mongoose.connection.readyState;
  const states = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };

  let stats = {};
  if (state === 1) {
    try {
      const Content = require('./models/Content');
      const User = require('./models/User');
      const Evaluation = require('./models/Evaluation');
      const Notification = require('./models/Notification');
      stats = {
        contentCount: await Content.countDocuments(),
        userCount: await User.countDocuments(),
        evaluationCount: await Evaluation.countDocuments(),
        notificationCount: await Notification.countDocuments(),
      };
    } catch (e) {}
  }

  const isAiConfigured = Boolean(
    (process.env.GEMINI_DOUBTS_API_KEY && process.env.GEMINI_DOUBTS_API_KEY.trim()) ||
    (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim())
  );
  const hasSeparateDoubtsKey = Boolean(process.env.GEMINI_DOUBTS_API_KEY && process.env.GEMINI_DOUBTS_API_KEY.trim());
  const isAiKillSwitchActive = process.env.DOUBTS_AI_ENABLED === 'false';

  const showProxyDiagnostic = process.env.ENABLE_HEALTH_PROXY_DIAGNOSTICS !== 'false';
  const rawForwarded = req.headers['x-forwarded-for'] || null;

  res.json({
    status: 'ok',
    database: 'MongoDB Atlas',
    connectionState: states[state] || 'unknown',
    connected: state === 1,
    host: mongoose.connection.host || null,
    dbName: mongoose.connection.name || 'asmaths_lms',
    clientIp: showProxyDiagnostic ? req.ip : '[PROTECTED]',
    xForwardedFor: showProxyDiagnostic ? rawForwarded : '[PROTECTED]',
    proxyDiagnosticEnabled: showProxyDiagnostic,
    aiConfigured: isAiConfigured,
    hasSeparateDoubtsKey,
    aiKillSwitchActive: isAiKillSwitchActive,
    aiModel: process.env.GEMINI_DOUBT_MODEL || 'gemini-3.8-flash',
    globalDailyCap: parseInt(process.env.GLOBAL_DAILY_AI_REQUEST_CAP || '40', 10),
    stats,
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'AS Maths Educator MongoDB Atlas Cloud API is running.',
  });
});

// JSON-Only 404 Catch-All Handler (Never returns HTML "Cannot GET/POST ...")
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `API endpoint not found: ${req.method} ${req.originalUrl}`,
  });
});

// JSON-Only 500 Global Error Middleware (Never returns HTML stack traces)
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[AS Maths LMS Backend Error]:', err.message);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error occurred.',
  });
});

const PORT = process.env.PORT || 5000;

// Force Admin Upsert on Startup
const { forceAdminUpsert } = require('./controllers/authController');
const ExtractionCache = require('./models/ExtractionCache');

mongoose.connection.on('connected', () => {
  forceAdminUpsert();
  // Clear legacy extraction cache once
  ExtractionCache.deleteMany({ promptVersion: { $ne: 'v2-ocr-pure-transcription' } })
    .then((res) => {
      if (res && res.deletedCount > 0) {
        console.log(`🧹 [CACHE MIGRATION]: Cleared ${res.deletedCount} legacy extraction cache records.`);
      }
    })
    .catch(() => {});
});
const { sweepStuckDoubtJobs } = require('./controllers/doubtController');

mongoose.connection.once('open', () => {
  forceAdminUpsert();
  sweepStuckDoubtJobs()
    .then((count) => {
      if (count > 0) console.log(`🧹 [DOUBT SWEEPER]: Swept ${count} stuck doubt jobs from previous server run.`);
    })
    .catch(() => {});

  // Recurring sweeper: periodically cleans stuck jobs (>5m) and deletes abandoned drafts (>7d)
  const doubtSweepTimer = setInterval(() => {
    sweepStuckDoubtJobs().catch(() => {});
  }, 10 * 60 * 1000);
  if (doubtSweepTimer && doubtSweepTimer.unref) doubtSweepTimer.unref();
});

// Startup verification for Gemini API Key
if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
  console.log('✅ [GEMINI AI]: Google Gemini API Key configured and active.');
} else {
  console.warn('⚠️ [WARNING]: GEMINI_API_KEY is not configured in server environment. AI Question Import will be disabled until configured.');
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`MongoDB Atlas integration active at /api/*`);
    console.log(`Static file uploads served from ${uploadsDir}`);
  });
}

module.exports = app;
