const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const connectDB = require('./config/db');

// Load environment variables
dotenv.config();

// Connect to MongoDB Atlas
connectDB();

const app = express();

// Ensure local uploads directory exists (Atlas Free Tier file system storage)
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Serve uploaded files statically
app.use('/uploads', express.static(uploadsDir));

// High-capacity body parser for base64 documents (PDFs, question sheets, diagrams)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Enable CORS
app.use(cors());

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

// Mount routers
app.use('/api/auth', authRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/evaluations', evaluationRoutes);
app.use('/api/analytics', activityRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/tests', testRoutes);
app.use('/api/fees', feeRoutes);

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

  res.json({
    status: 'ok',
    database: 'MongoDB Atlas',
    connectionState: states[state] || 'unknown',
    connected: state === 1,
    host: mongoose.connection.host || null,
    dbName: mongoose.connection.name || 'asmaths_lms',
    stats,
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.send('AS Maths Educator MongoDB Atlas Cloud API is running...');
});

const PORT = process.env.PORT || 5000;

// Task 3 & 4: Force Admin Upsert on Startup
// Automatically updates or creates the guaranteed admin account with EXACT credentials on server launch:
// Email: admin@asmaths.com, Password: AdminPassword123!, role: "admin", isApproved: true
const { forceAdminUpsert } = require('./controllers/authController');

mongoose.connection.on('connected', () => {
  forceAdminUpsert();
});
mongoose.connection.once('open', () => {
  forceAdminUpsert();
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`MongoDB Atlas integration active at /api/*`);
  console.log(`Static file uploads served from ${uploadsDir}`);
});
