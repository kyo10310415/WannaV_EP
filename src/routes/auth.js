const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');

// ログイン（ユーザー名 or メールアドレス）
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body; // フロントは "email" フィールドを使用（ユーザー名を送る）

    const user = await User.findByUsername(email);
    if (!user) {
      return res.status(401).json({ error: 'ユーザー名またはパスワードが間違っています' });
    }

    const isValidPassword = await User.verifyPassword(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'ユーザー名またはパスワードが間違っています' });
    }

    await User.updateLastLogin(user.id);

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // 初回パスワード変更が必要かどうか
    const needsPasswordChange = !user.password_changed_at;

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        username: user.username,
        role: user.role
      },
      needsPasswordChange
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'ログインに失敗しました' });
  }
});

// パスワード変更（ログイン後の初回変更にも使用）
router.post('/change-password', async (req, res) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: '認証が必要です' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'パスワードは4文字以上で入力してください' });
    }

    await User.resetPassword(decoded.id, newPassword);
    res.json({ success: true, message: 'パスワードを変更しました' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'パスワード変更に失敗しました' });
  }
});

// ユーザー情報取得
router.get('/me', async (req, res) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: '認証が必要です' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });

    // needsPasswordChange をレスポンスに含める
    res.json({
      ...user,
      needsPasswordChange: !user.password_changed_at
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(401).json({ error: '認証に失敗しました' });
  }
});

module.exports = router;
