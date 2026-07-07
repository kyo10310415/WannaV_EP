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

// ===== アップロードディレクトリ設定 =====
// Render Disk を使う場合は環境変数 UPLOAD_DIR=/var/data/uploads を設定
// ローカル開発時はデフォルトの ./uploads を使用
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, 'uploads');
const THUMBS_DIR = path.join(UPLOAD_DIR, 'thumbs');

// グローバルに公開（admin.js / thumbnail.js から参照）
global.UPLOAD_DIR  = UPLOAD_DIR;
global.THUMBS_DIR  = THUMBS_DIR;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static('public'));
app.use('/uploads', express.static(UPLOAD_DIR));

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
    console.log('🚀 Initializing WannaV エントリープラン...');
    
    // アップロードディレクトリ作成（Render Diskマウント後でも確実に存在させる）
    [UPLOAD_DIR, THUMBS_DIR].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`✅ Directory created: ${dir}`);
      }
    });
    console.log(`📂 Upload directory: ${UPLOAD_DIR}`);
    
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
    console.log(`🎉 WannaV エントリープラン server running on http://0.0.0.0:${PORT}`);
  });
};

startServer();
