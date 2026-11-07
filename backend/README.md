# AS Maths Educator — Backend API & Services

RESTful Backend for the AS Maths Educator Learning Management System (LMS) and Doubts Escalator.

---

## Environment Variables Reference

### 1. Required Core Variables

| Variable | Type | Default | Description & Missing Behavior |
| :--- | :--- | :--- | :--- |
| `MONGO_URI` | String | *None* | **REQUIRED.** MongoDB Atlas connection string. Server immediately terminates at startup if missing (`process.exit(1)`). |
| `JWT_SECRET` | String | `asmaths_secret_jwt_key_2026_cluster0` | Secret key used to sign and verify HMAC SHA-256 session tokens. Must be overridden with a cryptographically strong secret in production. |

---

### 2. Doubts Escalator & Gemini AI Controls

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `GEMINI_API_KEY` | String | *None* | Primary Google Gemini API key used by Question Bank, AI Import, and Exam Evaluation. If missing, AI extraction fails gracefully with honest error messages. |
| `GEMINI_DOUBTS_API_KEY` | String | Falls back to `GEMINI_API_KEY` | Dedicated API key specifically for Doubts Escalator, isolating doubt queries from Question Bank quotas. |
| `DOUBTS_AI_ENABLED` | Boolean | `true` | Platform kill switch. When set to `false`, new doubts bypass Gemini and route directly to the faculty queue with 24-hour SLA. |
| `GLOBAL_DAILY_AI_REQUEST_CAP` | Number | `40` | Total doubt-related Gemini API calls permitted platform-wide per day. When reached, doubts route directly to faculty with zero synthetic answers and refund student AI quota. |
| `DAILY_STUDENT_DOUBT_LIMIT` | Number | `3` | Maximum AI doubt attempts allowed per individual student per day. |
| `DAILY_STUDENT_TOTAL_DOUBT_LIMIT` | Number | `10` | Daily student flood guard across both AI and direct faculty submissions. |
| `GEMINI_DOUBT_MODEL` | String | `gemini-3.8-flash` | Primary AI model for doubt solving. Fallback chain: `gemini-3.5-flash` → `gemini-3.5-flash-lite`. |
| `GEMINI_TRANSCRIPTION_MODEL` | String | `gemini-3.8-flash` | Multimodal model for OCR transcription of handwritten doubts. |
| `GEMINI_MODEL_TIMEOUT_MS` | Number | `75000` (75s) | Timeout for an individual model attempt before cascading to a lighter fallback model. |
| `GEMINI_TOTAL_JOB_DEADLINE_MS` | Number | `240000` (4 min) | Overall execution deadline for a doubt resolution across all cascaded attempts. |
| `DOUBT_SWEEPER_TIMEOUT_MS` | Number | `360000` (6 min) | Interval for the background sweeper to detect and reset orphaned doubts (strictly > total deadline). |
| `LEGACY_DOUBT_ENDPOINT_ENABLED` | Boolean | `true` | Controls `/api/student/solve-doubt`. When `false`, returns HTTP 410 Gone instructing students to refresh. |
| `ENABLE_HEALTH_PROXY_DIAGNOSTICS` | Boolean | `true` | When `true`, `/api/health` exposes `clientIp` and `xForwardedFor` for reverse-proxy verification. Set to `false` to mask in production. |

---

### 3. Server & Network Options

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | Number | `5000` | HTTP listening port for Express. |
| `NODE_ENV` | String | `development` | Setting to `production` enables strict cookie security and CORS enforcement. |
| `FRONTEND_URL` | String | `http://localhost:5173` | Allowed frontend origin for CORS. |
| `ALLOWED_ORIGINS` | String | *None* | Comma-separated list of additional allowed CORS origins. |
| `DISABLE_RATE_LIMITING` | Boolean | `false` | Disables rate limiters (for testing environments only). |

---

### 4. Optional Third-Party Notification & Storage Providers

| Variable Group | Variables | Purpose |
| :--- | :--- | :--- |
| **Cloudinary** | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CLOUDINARY_URL` | Optional external CDN for file storage (defaults to MongoDB Base64 / disk uploads). |
| **WhatsApp / SMS** | `FAST2SMS_API_KEY`, `META_PHONE_NUMBER_ID`, `META_WHATSAPP_TOKEN`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `TWILIO_WHATSAPP_NUMBER`, `WATI_ACCESS_TOKEN`, `WATI_API_ENDPOINT` | SMS & WhatsApp notifications for class notices and exam alerts. |
| **SMTP Email** | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `SMTP_FROM` | Transactional email delivery for registration approvals and password resets. |

---

## Database Migrations

### Notification Partial Unique Index Migration
To migrate legacy rigid `id_1` index to partial unique:
```bash
# Dry run
node scripts/migrateNotificationIndex.js --db=asmaths_lms

# Execute
node scripts/migrateNotificationIndex.js --db=asmaths_lms --confirm
```
