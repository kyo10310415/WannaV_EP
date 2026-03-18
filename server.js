require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { createTables } = require('./src/models/schema');
const { scheduleInactiveUserReminders } = require('./src/utils/scheduler');
const User = require('./src/models/User');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Routes
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/lessons', require('./src/routes/lessons'));
app.use('/api/progress', require('./src/routes/progress'));
app.use('/api/admin', require('./src/routes/admin'));

// Serve HTML pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/lesson/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'lesson.html'));
});

app.get('/admin/accounts', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin-accounts.html'));
});

app.get('/admin/contents', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin-contents.html'));
});

app.get('/admin/users', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin-users.html'));
});

// Initialize database and create admin user
const initializeApp = async () => {
  try {
    console.log('🚀 Initializing WannaV eラーニング...');
    
    // Create uploads directory if it doesn't exist
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
      console.log('✅ Uploads directory created');
    }
    
    // Create tables
    await createTables();
    
    // Create default admin user if not exists
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@wannav.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    
    const existingAdmin = await User.findByEmail(adminEmail);
    if (!existingAdmin) {
      await User.create(adminEmail, adminPassword, '管理者', '管理者');
      console.log(`✅ Admin user created: ${adminEmail}`);
    }
    
    // Start cron jobs
    scheduleInactiveUserReminders();
    
    console.log('✅ App initialized successfully');
  } catch (error) {
    console.error('❌ Initialization error:', error);
    process.exit(1);
  }
};

// Start server
const startServer = async () => {
  await initializeApp();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🎉 WannaV eラーニング server running on http://0.0.0.0:${PORT}`);
  });
};

startServer();
