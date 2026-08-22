const express = require('express');
const router = express.Router();
const { auth, checkRole } = require('../middleware/auth');
const CharacterSelection = require('../models/CharacterSelection');
const ActivityLog = require('../models/ActivityLog');
const {
  getCatalogue,
  getAllowedImage,
  streamThumbnail,
  streamImage,
  toPublicImage,
  imagePath,
} = require('../utils/googleDriveCharacters');

function serializeSelection(selection) {
  if (!selection) return null;
  return {
    id: selection.id,
    studentUserId: selection.student_user_id,
    studentNumber: selection.student_number || null,
    studentName: selection.student_name || null,
    fileId: selection.drive_file_id,
    fileName: selection.drive_file_name,
    category: selection.category,
    status: selection.status,
    selectedAt: selection.selected_at,
    confirmedAt: selection.confirmed_at,
    imageUrl: imagePath(selection.drive_file_id),
  };
}

function handleDriveError(error, res, message) {
  console.error(message, error.response?.data || error.message);
  const configurationError = error.message?.includes('サービスアカウント')
    || error.message?.includes('GOOGLE_');
  return res.status(configurationError ? 503 : 500).json({
    error: configurationError
      ? 'Google Drive連携の設定が不完全です'
      : message,
  });
}

// 画像はGoogle Driveの許可フォルダ内に存在するIDだけを配信する。
// <img>タグから利用できるよう、このルート自体にはBearer認証を要求しない。
router.get('/images/:fileId', async (req, res) => {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(req.params.fileId)) {
      return res.status(400).end();
    }
    let thumbnail = null;
    if (req.query.full !== '1') {
      try {
        thumbnail = await streamThumbnail(req.params.fileId);
      } catch (thumbnailError) {
        console.warn('Character thumbnail fallback:', thumbnailError.response?.status || thumbnailError.message);
      }
    }
    if (thumbnail) {
      res.set('Content-Type', thumbnail.response.headers['content-type']
        || thumbnail.image.mimeType
        || 'image/png');
      res.set('Cache-Control', 'public, max-age=300');
      thumbnail.response.data.pipe(res);
      return;
    }

    const streamed = await streamImage(req.params.fileId);
    if (!streamed) return res.status(404).end();
    res.set('Content-Type', streamed.image.mimeType || 'image/png');
    res.set('Cache-Control', 'public, max-age=300');
    streamed.response.data.pipe(res);
  } catch (error) {
    console.error('Character image error:', error.response?.data || error.message);
    res.status(error.response?.status === 404 ? 404 : 502).end();
  }
});

router.use(auth);

/**
 * GET /api/characters/me
 * 生徒本人の選択状況を返す。
 */
router.get('/me', checkRole('生徒'), async (req, res) => {
  try {
    const selection = await CharacterSelection.findByStudent(req.user.id);
    res.json({
      canSelect: !selection,
      selection: serializeSelection(selection),
    });
  } catch (error) {
    console.error('Get own character selection error:', error);
    res.status(500).json({ error: 'キャラクター選択状況の取得に失敗しました' });
  }
});

/**
 * GET /api/characters/available
 * 他の生徒が予約済みの画像を除いた選択肢を返す。
 */
router.get('/available', checkRole('生徒'), async (req, res) => {
  try {
    const existing = await CharacterSelection.findByStudent(req.user.id);
    if (existing) {
      return res.status(409).json({
        error: 'キャラクターは既に選択済みです',
        selection: serializeSelection(existing),
      });
    }

    const [catalogue, reservedIds] = await Promise.all([
      getCatalogue(),
      CharacterSelection.getReservedFileIds(),
    ]);
    const reserved = new Set(reservedIds);
    const available = catalogue.images
      .filter(image => !reserved.has(image.fileId))
      .map(toPublicImage);

    res.json({
      images: {
        女性: available.filter(image => image.category === '女性'),
        男性: available.filter(image => image.category === '男性'),
      },
      total: available.length,
    });
  } catch (error) {
    return handleDriveError(error, res, 'キャラクター画像の取得に失敗しました');
  }
});

/**
 * POST /api/characters/select
 * 生徒が画像を仮確定し、他の生徒から選択できない状態にする。
 */
router.post('/select', checkRole('生徒'), async (req, res) => {
  try {
    const fileId = String(req.body.fileId || '').trim();
    if (!fileId) return res.status(400).json({ error: '画像を選択してください' });

    const image = await getAllowedImage(fileId);
    if (!image) return res.status(404).json({ error: '選択可能な画像が見つかりません' });

    const selection = await CharacterSelection.createPending({
      studentUserId: req.user.id,
      fileId: image.fileId,
      fileName: image.fileName,
      category: image.category,
    });

    await ActivityLog.log({
      userId: req.user.id,
      action: 'character_select',
      targetType: 'character_selection',
      targetId: selection.id,
      detail: { fileId: image.fileId, fileName: image.fileName, category: image.category },
      ipAddress: req.ip,
    });

    res.status(201).json({
      message: 'キャラクターを選択しました。管理者の確定をお待ちください。',
      selection: serializeSelection(selection),
    });
  } catch (error) {
    if (error.code === '23505') {
      const existing = await CharacterSelection.findByStudent(req.user.id).catch(() => null);
      return res.status(409).json({
        error: existing
          ? 'キャラクターは既に選択済みです'
          : 'この画像は他の生徒が選択しました。別の画像を選んでください',
        selection: serializeSelection(existing),
      });
    }
    return handleDriveError(error, res, 'キャラクターの選択に失敗しました');
  }
});

/**
 * GET /api/characters/admin?status=pending|confirmed
 */
router.get('/admin', checkRole('管理者', 'セールス'), async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    if (!['pending', 'confirmed'].includes(status)) {
      return res.status(400).json({ error: '無効なステータスです' });
    }
    const selections = await CharacterSelection.getAll(status);
    res.json({ selections: selections.map(serializeSelection) });
  } catch (error) {
    console.error('Get character selections error:', error);
    res.status(500).json({ error: 'キャラクター選択一覧の取得に失敗しました' });
  }
});

/**
 * PATCH /api/characters/admin/:id/confirm
 */
router.patch('/admin/:id/confirm', checkRole('管理者', 'セールス'), async (req, res) => {
  try {
    const selection = await CharacterSelection.confirm(req.params.id, req.user.id);
    if (!selection) {
      return res.status(404).json({ error: '確定待ちのキャラクター選択が見つかりません' });
    }

    await ActivityLog.log({
      userId: req.user.id,
      action: 'character_confirm',
      targetType: 'character_selection',
      targetId: selection.id,
      detail: { studentUserId: selection.student_user_id, fileId: selection.drive_file_id },
      ipAddress: req.ip,
    });
    res.json({ message: 'キャラクターを確定しました', selection: serializeSelection(selection) });
  } catch (error) {
    console.error('Confirm character selection error:', error);
    res.status(500).json({ error: 'キャラクターの確定に失敗しました' });
  }
});

/**
 * DELETE /api/characters/admin/:id
 * 選択中・確定済みのどちらもキャンセルし、画像を再度選択可能にする。
 */
router.delete('/admin/:id', checkRole('管理者', 'セールス'), async (req, res) => {
  try {
    const selection = await CharacterSelection.cancel(req.params.id);
    if (!selection) return res.status(404).json({ error: 'キャラクター選択が見つかりません' });

    await ActivityLog.log({
      userId: req.user.id,
      action: 'character_cancel',
      targetType: 'character_selection',
      targetId: selection.id,
      detail: {
        studentUserId: selection.student_user_id,
        fileId: selection.drive_file_id,
        previousStatus: selection.status,
      },
      ipAddress: req.ip,
    });
    res.json({ message: 'キャラクター選択をキャンセルしました' });
  } catch (error) {
    console.error('Cancel character selection error:', error);
    res.status(500).json({ error: 'キャラクター選択のキャンセルに失敗しました' });
  }
});

module.exports = router;
