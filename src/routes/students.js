const express = require('express');
const router = express.Router();
const { auth, checkRole } = require('../middleware/auth');
const StudentProfile = require('../models/StudentProfile');
const ExtensionReview = require('../models/ExtensionReview');
const SatisfactionSurvey = require('../models/SatisfactionSurvey');
const HandoverInfo = require('../models/HandoverInfo');
const ActivityLog = require('../models/ActivityLog');
const StudentGoal = require('../models/StudentGoal');
const LessonSchedule = require('../models/LessonSchedule');
const User = require('../models/User');
const db = require('../config/database');

// ====================================================
// 生徒プロフィール管理
// ====================================================

/**
 * GET /api/students
 * 生徒一覧（ステータス・プロフィール込み）
 */
router.get('/', auth, checkRole('管理者', 'クルー', 'セールス'), async (req, res) => {
  try {
    const { status, tutorId } = req.query;
    // クルーは自分の担当生徒のみ（管理者・セールスは全件）
    const filterTutorId = req.user.role === 'クルー' ? req.user.id : (tutorId || null);
    const students = await StudentProfile.getAll({
      status: status || null,
      tutorId: filterTutorId
    });
    res.json(students);
  } catch (error) {
    console.error('Get students error:', error);
    res.status(500).json({ error: '生徒一覧の取得に失敗しました' });
  }
});

/**
 * GET /api/students/:userId
 * 特定生徒のプロフィール詳細
 */
router.get('/:userId', auth, checkRole('管理者', 'クルー', 'セールス'), async (req, res) => {
  try {
    const profile = await StudentProfile.findByUserId(req.params.userId);
    if (!profile) {
      // プロフィール未作成でもユーザー情報を返す
      const user = await User.findById(req.params.userId);
      if (!user) return res.status(404).json({ error: '生徒が見つかりません' });
      return res.json({ user_id: user.id, student_name: user.name, student_username: user.username, status: null });
    }
    res.json(profile);
  } catch (error) {
    console.error('Get student profile error:', error);
    res.status(500).json({ error: '生徒情報の取得に失敗しました' });
  }
});

/**
 * PUT /api/students/:userId/profile
 * 生徒プロフィール更新（UPSERT）
 */
router.put('/:userId/profile', auth, checkRole('管理者', 'クルー', 'セールス'), async (req, res) => {
  try {
    const profile = await StudentProfile.upsert(req.params.userId, {
      ...req.body,
      statusChangedBy: req.user.id
    });

    await ActivityLog.log({
      userId: req.user.id,
      action: 'student_profile_update',
      targetType: 'student',
      targetId: parseInt(req.params.userId),
      detail: { changes: req.body },
      ipAddress: req.ip
    });

    res.json(profile);
  } catch (error) {
    console.error('Update student profile error:', error);
    res.status(500).json({ error: 'プロフィールの更新に失敗しました' });
  }
});

/**
 * PATCH /api/students/:userId/status
 * ステータスのみ変更
 */
router.patch('/:userId/status', auth, checkRole('管理者', 'クルー', 'セールス'), async (req, res) => {
  try {
    const { status, note } = req.body;
    const VALID_STATUSES = ['アクティブ', 'レッスン準備中', '休会', '退会', '強制退会'];
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: '無効なステータスです' });
    }

    const profile = await StudentProfile.updateStatus(req.params.userId, status, note, req.user.id);

    await ActivityLog.log({
      userId: req.user.id,
      action: 'student_status_change',
      targetType: 'student',
      targetId: parseInt(req.params.userId),
      detail: { newStatus: status, note },
      ipAddress: req.ip
    });

    res.json(profile);
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ error: 'ステータスの更新に失敗しました' });
  }
});

/**
 * PATCH /api/students/:userId/tutor
 * 担当Tutor変更
 */
router.patch('/:userId/tutor', auth, checkRole('管理者', 'セールス'), async (req, res) => {
  try {
    const { tutorId } = req.body;
    const profile = await StudentProfile.updateTutor(req.params.userId, tutorId);

    await ActivityLog.log({
      userId: req.user.id,
      action: 'student_tutor_change',
      targetType: 'student',
      targetId: parseInt(req.params.userId),
      detail: { newTutorId: tutorId },
      ipAddress: req.ip
    });

    res.json(profile);
  } catch (error) {
    console.error('Update tutor error:', error);
    res.status(500).json({ error: '担当Tutorの更新に失敗しました' });
  }
});

/**
 * GET /api/students/meta/expiring
 * 契約終了が近い生徒一覧（延長審査対象候補）
 */
router.get('/meta/expiring', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const students = await StudentProfile.getExpiringStudents(days);
    res.json(students);
  } catch (error) {
    console.error('Get expiring students error:', error);
    res.status(500).json({ error: '期限切れ間近の生徒取得に失敗しました' });
  }
});

/**
 * GET /api/students/meta/followup
 * フォロー対象者一覧
 */
router.get('/meta/followup', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const students = await StudentProfile.getFollowUpTargets(days);
    res.json(students);
  } catch (error) {
    console.error('Get followup targets error:', error);
    res.status(500).json({ error: 'フォロー対象者取得に失敗しました' });
  }
});

// ====================================================
// 延長審査管理
// ====================================================

/**
 * GET /api/students/extensions/list
 * 延長審査一覧
 */
router.get('/extensions/list', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const { status, tutorId, limit, offset } = req.query;
    const filterTutorId = req.user.role === 'クルー' ? req.user.id : (tutorId || null);
    const reviews = await ExtensionReview.getAll({
      status: status || null,
      tutorId: filterTutorId,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0
    });
    res.json(reviews);
  } catch (error) {
    console.error('Get extension reviews error:', error);
    res.status(500).json({ error: '延長審査一覧の取得に失敗しました' });
  }
});

/**
 * GET /api/students/extensions/active
 * 審査中の延長審査一覧
 */
router.get('/extensions/active', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const reviews = await ExtensionReview.getActiveReviews();
    res.json(reviews);
  } catch (error) {
    console.error('Get active reviews error:', error);
    res.status(500).json({ error: '審査中リストの取得に失敗しました' });
  }
});

/**
 * POST /api/students/:userId/extensions
 * 延長審査を開始
 */
router.post('/:userId/extensions', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const { triggerType, currentContractEndDate, notes } = req.body;
    const review = await ExtensionReview.create({
      studentUserId: req.params.userId,
      triggerType: triggerType || 'manual',
      currentContractEndDate,
      reviewerId: req.user.id,
      notes
    });

    await ActivityLog.log({
      userId: req.user.id,
      action: 'extension_review_start',
      targetType: 'student',
      targetId: parseInt(req.params.userId),
      detail: { reviewId: review.id },
      ipAddress: req.ip
    });

    res.status(201).json(review);
  } catch (error) {
    console.error('Create extension review error:', error);
    res.status(500).json({ error: '延長審査の開始に失敗しました' });
  }
});

/**
 * GET /api/students/:userId/extensions
 * 特定生徒の延長審査履歴
 */
router.get('/:userId/extensions', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const reviews = await ExtensionReview.getByStudentId(req.params.userId);
    res.json(reviews);
  } catch (error) {
    console.error('Get student extensions error:', error);
    res.status(500).json({ error: '延長審査履歴の取得に失敗しました' });
  }
});

/**
 * PATCH /api/students/extensions/:reviewId
 * 審査結果を記録
 */
router.patch('/extensions/:reviewId', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const { reviewStatus, result, resultReason, newContractEndDate } = req.body;
    const review = await ExtensionReview.updateResult(req.params.reviewId, {
      reviewStatus,
      result,
      resultReason,
      newContractEndDate,
      reviewerId: req.user.id
    });

    if (!review) return res.status(404).json({ error: '審査が見つかりません' });

    await ActivityLog.log({
      userId: req.user.id,
      action: 'extension_review_update',
      targetType: 'extension_review',
      targetId: parseInt(req.params.reviewId),
      detail: { result, reviewStatus, newContractEndDate },
      ipAddress: req.ip
    });

    res.json(review);
  } catch (error) {
    console.error('Update extension review error:', error);
    res.status(500).json({ error: '審査結果の更新に失敗しました' });
  }
});

// ====================================================
// 満足度管理
// ====================================================

/**
 * GET /api/students/surveys/list
 * 満足度アンケート一覧
 */
router.get('/surveys/list', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const { tutorId, minScore, maxScore, limit, offset } = req.query;
    const filterTutorId = req.user.role === 'クルー' ? req.user.id : (tutorId || null);
    const surveys = await SatisfactionSurvey.getAll({
      tutorId: filterTutorId,
      minScore: minScore ? parseInt(minScore) : undefined,
      maxScore: maxScore ? parseInt(maxScore) : undefined,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0
    });
    res.json(surveys);
  } catch (error) {
    console.error('Get surveys error:', error);
    res.status(500).json({ error: '満足度一覧の取得に失敗しました' });
  }
});

/**
 * GET /api/students/surveys/stats
 * 満足度統計
 */
router.get('/surveys/stats', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const filterTutorId = req.user.role === 'クルー' ? req.user.id : (req.query.tutorId || null);
    const stats = await SatisfactionSurvey.getStats({ tutorId: filterTutorId });
    res.json(stats);
  } catch (error) {
    console.error('Get survey stats error:', error);
    res.status(500).json({ error: '満足度統計の取得に失敗しました' });
  }
});

/**
 * POST /api/students/:userId/surveys
 * アンケートを登録
 */
router.post('/:userId/surveys', auth, checkRole('管理者', 'クルー', 'セールス'), async (req, res) => {
  try {
    const survey = await SatisfactionSurvey.create({
      ...req.body,
      studentUserId: req.params.userId,
      registeredBy: req.user.id
    });

    await ActivityLog.log({
      userId: req.user.id,
      action: 'survey_create',
      targetType: 'student',
      targetId: parseInt(req.params.userId),
      detail: { surveyId: survey.id, overallScore: survey.overall_score },
      ipAddress: req.ip
    });

    res.status(201).json(survey);
  } catch (error) {
    console.error('Create survey error:', error);
    res.status(500).json({ error: 'アンケートの登録に失敗しました' });
  }
});

/**
 * GET /api/students/:userId/surveys
 * 特定生徒のアンケート履歴
 */
router.get('/:userId/surveys', auth, checkRole('管理者', 'クルー', 'セールス'), async (req, res) => {
  try {
    const surveys = await SatisfactionSurvey.getByStudentId(req.params.userId);
    res.json(surveys);
  } catch (error) {
    console.error('Get student surveys error:', error);
    res.status(500).json({ error: 'アンケート履歴の取得に失敗しました' });
  }
});

/**
 * PATCH /api/students/surveys/:surveyId
 * アンケート更新
 */
router.patch('/surveys/:surveyId', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const survey = await SatisfactionSurvey.update(req.params.surveyId, req.body);
    if (!survey) return res.status(404).json({ error: 'アンケートが見つかりません' });
    res.json(survey);
  } catch (error) {
    console.error('Update survey error:', error);
    res.status(500).json({ error: 'アンケートの更新に失敗しました' });
  }
});

/**
 * DELETE /api/students/surveys/:surveyId
 * アンケート削除
 */
router.delete('/surveys/:surveyId', auth, checkRole('管理者'), async (req, res) => {
  try {
    await SatisfactionSurvey.delete(req.params.surveyId);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete survey error:', error);
    res.status(500).json({ error: 'アンケートの削除に失敗しました' });
  }
});

// ====================================================
// 引き継ぎ情報管理
// ====================================================

/**
 * GET /api/students/handovers/list
 * 引き継ぎ情報一覧
 */
router.get('/handovers/list', auth, checkRole('管理者', 'クルー', 'セールス'), async (req, res) => {
  try {
    const { status, salesId, tutorId, limit, offset } = req.query;
    let filterSalesId = null;
    let filterTutorId = null;

    if (req.user.role === 'セールス') {
      filterSalesId = req.user.id;
    } else if (req.user.role === 'クルー') {
      filterTutorId = req.user.id;
    } else {
      filterSalesId = salesId || null;
      filterTutorId = tutorId || null;
    }

    const handovers = await HandoverInfo.getAll({
      status: status || null,
      salesId: filterSalesId,
      tutorId: filterTutorId,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0
    });
    res.json(handovers);
  } catch (error) {
    console.error('Get handovers error:', error);
    res.status(500).json({ error: '引き継ぎ一覧の取得に失敗しました' });
  }
});

/**
 * GET /api/students/handovers/pending
 * 未確認の引き継ぎ（Tutor向け）
 */
router.get('/handovers/pending', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const tutorId = req.user.role === 'クルー' ? req.user.id : (req.query.tutorId || req.user.id);
    const handovers = await HandoverInfo.getPendingForTutor(tutorId);
    res.json(handovers);
  } catch (error) {
    console.error('Get pending handovers error:', error);
    res.status(500).json({ error: '未確認引き継ぎの取得に失敗しました' });
  }
});

/**
 * GET /api/students/:userId/handover
 * 特定生徒の引き継ぎ情報
 */
router.get('/:userId/handover', auth, checkRole('管理者', 'クルー', 'セールス'), async (req, res) => {
  try {
    const handover = await HandoverInfo.findByStudentId(req.params.userId);
    res.json(handover || {});
  } catch (error) {
    console.error('Get handover error:', error);
    res.status(500).json({ error: '引き継ぎ情報の取得に失敗しました' });
  }
});

/**
 * PUT /api/students/:userId/handover
 * 引き継ぎ情報の作成・更新
 */
router.put('/:userId/handover', auth, checkRole('管理者', 'クルー', 'セールス'), async (req, res) => {
  try {
    const data = {
      ...req.body,
      salesUserId: req.user.role === 'セールス' ? req.user.id : (req.body.salesUserId || null)
    };
    const handover = await HandoverInfo.upsert(req.params.userId, data);

    // student_profiles にも契約情報を同期
    if (handover.contract_plan || handover.contract_start_date || handover.lesson_start_date || handover.tutor_user_id) {
      await StudentProfile.upsert(req.params.userId, {
        contractPlan: handover.contract_plan,
        contractStartDate: handover.contract_start_date,
        contractEndDate: handover.contract_end_date,
        lessonStartDate: handover.lesson_start_date,
        assignedTutorId: handover.tutor_user_id
      });
    }

    await ActivityLog.log({
      userId: req.user.id,
      action: 'handover_upsert',
      targetType: 'student',
      targetId: parseInt(req.params.userId),
      detail: { handoverId: handover.id },
      ipAddress: req.ip
    });

    res.json(handover);
  } catch (error) {
    console.error('Upsert handover error:', error);
    res.status(500).json({ error: '引き継ぎ情報の保存に失敗しました' });
  }
});

/**
 * POST /api/students/:userId/handover/submit
 * 引き継ぎを提出（salesからTutorへ）
 */
router.post('/:userId/handover/submit', auth, checkRole('管理者', 'セールス'), async (req, res) => {
  try {
    const handover = await HandoverInfo.submit(req.params.userId);
    if (!handover) return res.status(404).json({ error: '引き継ぎ情報が見つかりません' });

    await ActivityLog.log({
      userId: req.user.id,
      action: 'handover_submit',
      targetType: 'student',
      targetId: parseInt(req.params.userId),
      ipAddress: req.ip
    });

    res.json(handover);
  } catch (error) {
    console.error('Submit handover error:', error);
    res.status(500).json({ error: '引き継ぎの提出に失敗しました' });
  }
});

/**
 * POST /api/students/:userId/handover/confirm
 * 引き継ぎを確認（Tutorが確認）
 */
router.post('/:userId/handover/confirm', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const handover = await HandoverInfo.confirm(req.params.userId, req.user.id);
    if (!handover) return res.status(404).json({ error: '引き継ぎ情報が見つかりません' });

    // ステータスをアクティブに変更
    await StudentProfile.updateStatus(req.params.userId, 'アクティブ', '引き継ぎ確認済み', req.user.id);

    await ActivityLog.log({
      userId: req.user.id,
      action: 'handover_confirm',
      targetType: 'student',
      targetId: parseInt(req.params.userId),
      ipAddress: req.ip
    });

    res.json(handover);
  } catch (error) {
    console.error('Confirm handover error:', error);
    res.status(500).json({ error: '引き継ぎの確認に失敗しました' });
  }
});

// ====================================================
// ログ管理
// ====================================================

/**
 * GET /api/students/logs/list
 * 操作ログ一覧（管理者のみ）
 */
router.get('/logs/list', auth, checkRole('管理者'), async (req, res) => {
  try {
    const { userId, action, targetType, limit, offset } = req.query;
    const logs = await ActivityLog.getAll({
      userId: userId ? parseInt(userId) : null,
      action: action || null,
      targetType: targetType || null,
      limit: parseInt(limit) || 100,
      offset: parseInt(offset) || 0
    });
    res.json(logs);
  } catch (error) {
    console.error('Get logs error:', error);
    res.status(500).json({ error: 'ログの取得に失敗しました' });
  }
});

// ====================================================
// Tutor一覧（担当割り当て用）
// ====================================================

/**
 * GET /api/students/meta/tutors
 * クルー（Tutor）一覧
 */
router.get('/meta/tutors', auth, checkRole('管理者', 'クルー', 'セールス'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, username FROM users WHERE role = 'クルー' ORDER BY name`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get tutors error:', error);
    res.status(500).json({ error: 'Tutor一覧の取得に失敗しました' });
  }
});

// ====================================================
// ステータス管理（正規退会・強制退会 含む5種）
// ====================================================

/**
 * GET /api/students/meta/status-options
 * 使用可能なステータス一覧
 */
router.get('/meta/status-options', auth, checkRole('管理者', 'クルー', 'セールス'), (req, res) => {
  res.json([
    { value: 'アクティブ',    label: 'アクティブ',    color: '#2ECC71', description: '通常受講中' },
    { value: 'レッスン準備中', label: 'レッスン準備中', color: '#34C8E8', description: '引き継ぎ前・準備段階' },
    { value: '休会',          label: '休会',          color: '#F39C12', description: '一時停止中' },
    { value: '正規退会',      label: '正規退会',      color: '#94B8D4', description: '正規の手続きで退会' },
    { value: '強制退会',      label: '強制退会',      color: '#E74C3C', description: '規約違反等による強制退会' },
  ]);
});

// ====================================================
// 目的・目標管理
// ====================================================

/**
 * GET /api/students/:userId/purpose
 * 生徒の目的（大目標）を取得
 */
router.get('/:userId/purpose', auth, checkRole('管理者', 'クルー', 'セールス'), async (req, res) => {
  try {
    const purpose = await StudentGoal.getPurpose(req.params.userId);
    res.json(purpose || {});
  } catch (error) {
    console.error('Get purpose error:', error);
    res.status(500).json({ error: '目的の取得に失敗しました' });
  }
});

/**
 * PUT /api/students/:userId/purpose
 * 目的を設定/更新
 */
router.put('/:userId/purpose', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const { purpose } = req.body;
    if (!purpose) return res.status(400).json({ error: '目的を入力してください' });

    const result = await StudentGoal.setPurpose(req.params.userId, {
      purpose,
      setBy: req.user.id
    });

    await ActivityLog.log({
      userId: req.user.id,
      action: 'goal_purpose_set',
      targetType: 'student',
      targetId: parseInt(req.params.userId),
      detail: { purpose: purpose.substring(0, 50) },
      ipAddress: req.ip
    });

    res.json(result);
  } catch (error) {
    console.error('Set purpose error:', error);
    res.status(500).json({ error: '目的の設定に失敗しました' });
  }
});

/**
 * GET /api/students/:userId/goals
 * 目標一覧
 */
router.get('/:userId/goals', auth, checkRole('管理者', 'クルー', 'セールス'), async (req, res) => {
  try {
    const { status } = req.query;
    const goals = await StudentGoal.getGoals(req.params.userId, { status });
    const summary = await StudentGoal.getProgressSummary(req.params.userId);
    res.json({ goals, summary });
  } catch (error) {
    console.error('Get goals error:', error);
    res.status(500).json({ error: '目標の取得に失敗しました' });
  }
});

/**
 * POST /api/students/:userId/goals
 * 目標を作成
 */
router.post('/:userId/goals', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const { goalTitle, goalDetail, goalType, targetDate, progressRate } = req.body;
    if (!goalTitle) return res.status(400).json({ error: '目標タイトルを入力してください' });

    const goal = await StudentGoal.createGoal(req.params.userId, {
      goalTitle, goalDetail, goalType, targetDate, progressRate,
      setBy: req.user.id
    });

    await ActivityLog.log({
      userId: req.user.id,
      action: 'goal_create',
      targetType: 'student',
      targetId: parseInt(req.params.userId),
      detail: { goalId: goal.id, goalTitle },
      ipAddress: req.ip
    });

    res.status(201).json(goal);
  } catch (error) {
    console.error('Create goal error:', error);
    res.status(500).json({ error: '目標の作成に失敗しました' });
  }
});

/**
 * PATCH /api/students/goals/:goalId
 * 目標を更新
 */
router.patch('/goals/:goalId', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const goal = await StudentGoal.updateGoal(req.params.goalId, req.body);
    if (!goal) return res.status(404).json({ error: '目標が見つかりません' });
    res.json(goal);
  } catch (error) {
    console.error('Update goal error:', error);
    res.status(500).json({ error: '目標の更新に失敗しました' });
  }
});

/**
 * PATCH /api/students/goals/:goalId/progress
 * 進捗度を更新
 */
router.patch('/goals/:goalId/progress', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const { progressRate, progressNote } = req.body;
    if (progressRate === undefined) return res.status(400).json({ error: 'progressRateが必要です' });

    const goal = await StudentGoal.updateProgress(req.params.goalId, {
      progressRate,
      progressNote,
      updatedBy: req.user.id
    });
    if (!goal) return res.status(404).json({ error: '目標が見つかりません' });

    await ActivityLog.log({
      userId: req.user.id,
      action: 'goal_progress_update',
      targetType: 'goal',
      targetId: parseInt(req.params.goalId),
      detail: { progressRate, progressNote },
      ipAddress: req.ip
    });

    res.json(goal);
  } catch (error) {
    console.error('Update goal progress error:', error);
    res.status(500).json({ error: '進捗度の更新に失敗しました' });
  }
});

/**
 * DELETE /api/students/goals/:goalId
 * 目標を削除
 */
router.delete('/goals/:goalId', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const goal = await StudentGoal.findById(req.params.goalId);
    if (!goal) return res.status(404).json({ error: '目標が見つかりません' });
    await StudentGoal.deleteGoal(req.params.goalId);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete goal error:', error);
    res.status(500).json({ error: '目標の削除に失敗しました' });
  }
});

/**
 * GET /api/students/goals/overview
 * 全生徒の目標進捗概況（管理者用）
 */
router.get('/goals/overview', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    let data;
    if (req.user.role === 'クルー') {
      data = await StudentGoal.getAllForTutor(req.user.id);
    } else {
      data = await StudentGoal.getAllSummary();
    }
    res.json(data);
  } catch (error) {
    console.error('Get goals overview error:', error);
    res.status(500).json({ error: '目標概況の取得に失敗しました' });
  }
});

// ====================================================
// 受講スケジュール管理
// ====================================================

/**
 * GET /api/students/:userId/schedule
 * 特定生徒のスケジュール一覧
 */
router.get('/:userId/schedule', auth, checkRole('管理者', 'クルー', 'セールス'), async (req, res) => {
  try {
    const { from, to, status } = req.query;
    // 進捗との同期を先に実行
    await LessonSchedule.syncWithProgress(req.params.userId);
    const schedule = await LessonSchedule.getByUser(req.params.userId, { from, to, status });
    res.json(schedule);
  } catch (error) {
    console.error('Get schedule error:', error);
    res.status(500).json({ error: 'スケジュールの取得に失敗しました' });
  }
});

/**
 * GET /api/students/:userId/schedule/week
 * 今週のスケジュール（生徒自身も参照可）
 */
router.get('/:userId/schedule/week', auth, async (req, res) => {
  try {
    // 自分自身か管理者・クルーのみアクセス可
    if (req.user.role === '生徒' && req.user.id !== parseInt(req.params.userId)) {
      return res.status(403).json({ error: 'アクセス権限がありません' });
    }
    await LessonSchedule.syncWithProgress(req.params.userId);
    const schedule = await LessonSchedule.getThisWeek(req.params.userId);
    res.json(schedule);
  } catch (error) {
    console.error('Get week schedule error:', error);
    res.status(500).json({ error: '今週のスケジュール取得に失敗しました' });
  }
});

/**
 * POST /api/students/:userId/schedule
 * スケジュールを1件追加
 */
router.post('/:userId/schedule', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const { lessonId, scheduledDate, dueDate, priority, tutorNote } = req.body;
    if (!lessonId || !scheduledDate) {
      return res.status(400).json({ error: 'lessonIdとscheduledDateは必須です' });
    }
    const item = await LessonSchedule.create({
      userId: req.params.userId,
      lessonId, scheduledDate, dueDate, priority, tutorNote,
      createdBy: req.user.id
    });

    await ActivityLog.log({
      userId: req.user.id,
      action: 'schedule_create',
      targetType: 'student',
      targetId: parseInt(req.params.userId),
      detail: { lessonId, scheduledDate },
      ipAddress: req.ip
    });

    res.status(201).json(item);
  } catch (error) {
    console.error('Create schedule error:', error);
    res.status(500).json({ error: 'スケジュールの追加に失敗しました' });
  }
});

/**
 * POST /api/students/:userId/schedule/from-template
 * テンプレートから一括スケジュール生成
 */
router.post('/:userId/schedule/from-template', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const { templateId, startDate } = req.body;
    if (!templateId || !startDate) {
      return res.status(400).json({ error: 'templateIdとstartDateは必須です' });
    }
    const items = await LessonSchedule.bulkCreateFromTemplate(
      req.params.userId, templateId, startDate, req.user.id
    );

    await ActivityLog.log({
      userId: req.user.id,
      action: 'schedule_bulk_create',
      targetType: 'student',
      targetId: parseInt(req.params.userId),
      detail: { templateId, startDate, count: items.length },
      ipAddress: req.ip
    });

    res.status(201).json({ created: items.length, items });
  } catch (error) {
    console.error('Bulk schedule error:', error);
    res.status(500).json({ error: 'スケジュール一括生成に失敗しました' });
  }
});

/**
 * PATCH /api/students/schedule/:scheduleId
 * スケジュール更新（日付変更・ステータス更新など）
 */
router.patch('/schedule/:scheduleId', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const item = await LessonSchedule.update(req.params.scheduleId, req.body);
    if (!item) return res.status(404).json({ error: 'スケジュールが見つかりません' });
    res.json(item);
  } catch (error) {
    console.error('Update schedule error:', error);
    res.status(500).json({ error: 'スケジュールの更新に失敗しました' });
  }
});

/**
 * DELETE /api/students/schedule/:scheduleId
 * スケジュール削除
 */
router.delete('/schedule/:scheduleId', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    await LessonSchedule.delete(req.params.scheduleId);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete schedule error:', error);
    res.status(500).json({ error: 'スケジュールの削除に失敗しました' });
  }
});

/**
 * GET /api/students/schedule/overview
 * 担当Tutorの全生徒スケジュール概況
 */
router.get('/schedule/overview', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const tutorId = req.user.role === 'クルー' ? req.user.id : (req.query.tutorId || null);
    if (!tutorId) return res.status(400).json({ error: 'tutorIdが必要です' });
    const overview = await LessonSchedule.getOverviewForTutor(tutorId);
    res.json(overview);
  } catch (error) {
    console.error('Get schedule overview error:', error);
    res.status(500).json({ error: 'スケジュール概況の取得に失敗しました' });
  }
});

// ====================================================
// スケジュールテンプレート管理
// ====================================================

/**
 * GET /api/students/schedule-templates
 * テンプレート一覧
 */
router.get('/schedule-templates', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const templates = await LessonSchedule.getTemplates();
    res.json(templates);
  } catch (error) {
    console.error('Get templates error:', error);
    res.status(500).json({ error: 'テンプレートの取得に失敗しました' });
  }
});

/**
 * POST /api/students/schedule-templates
 * テンプレート作成
 */
router.post('/schedule-templates', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const { name, description, contractPlan, items } = req.body;
    if (!name) return res.status(400).json({ error: 'テンプレート名を入力してください' });
    const template = await LessonSchedule.createTemplate({
      name, description, contractPlan, items: items || [],
      createdBy: req.user.id
    });
    res.status(201).json(template);
  } catch (error) {
    console.error('Create template error:', error);
    res.status(500).json({ error: 'テンプレートの作成に失敗しました' });
  }
});

/**
 * PATCH /api/students/schedule-templates/:templateId
 * テンプレート更新
 */
router.patch('/schedule-templates/:templateId', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const template = await LessonSchedule.updateTemplate(req.params.templateId, req.body);
    if (!template) return res.status(404).json({ error: 'テンプレートが見つかりません' });
    res.json(template);
  } catch (error) {
    console.error('Update template error:', error);
    res.status(500).json({ error: 'テンプレートの更新に失敗しました' });
  }
});

/**
 * DELETE /api/students/schedule-templates/:templateId
 * テンプレート削除（論理削除）
 */
router.delete('/schedule-templates/:templateId', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    await LessonSchedule.deleteTemplate(req.params.templateId);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete template error:', error);
    res.status(500).json({ error: 'テンプレートの削除に失敗しました' });
  }
});

// ====================================================
// 動画視聴 & 進捗の強化API
// ====================================================

/**
 * GET /api/students/:userId/progress-summary
 * 生徒の総合進捗サマリー（視聴進捗 + 目標進捗）
 */
router.get('/:userId/progress-summary', auth, checkRole('管理者', 'クルー', 'セールス'), async (req, res) => {
  try {
    const userId = req.params.userId;

    // 動画進捗
    const videoProgressRes = await db.query(`
      SELECT
        COUNT(DISTINCT l.id) AS total_lessons,
        COUNT(DISTINCT l.id) FILTER (WHERE up.completed = true) AS completed_lessons,
        COUNT(DISTINCT l.id) FILTER (WHERE up.watch_percent >= 50 AND up.completed = false) AS in_progress_lessons,
        ROUND(
          COUNT(DISTINCT l.id) FILTER (WHERE up.completed = true)::numeric
          / NULLIF(COUNT(DISTINCT l.id), 0) * 100, 1
        ) AS video_completion_rate,
        MAX(up.last_watched_at) AS last_activity,
        ROUND(AVG(up.watch_percent) FILTER (WHERE up.watch_percent > 0), 1) AS avg_watch_percent
      FROM lessons l
      LEFT JOIN user_progress up ON l.id = up.lesson_id AND up.user_id = $1
    `, [userId]);

    // 目標進捗
    const goalSummary = await StudentGoal.getProgressSummary(userId);

    // スケジュール遵守率
    const scheduleRes = await db.query(`
      SELECT
        COUNT(*) AS total_scheduled,
        COUNT(*) FILTER (WHERE status = 'completed') AS on_time_completed,
        COUNT(*) FILTER (
          WHERE due_date < CURRENT_DATE AND status NOT IN ('completed','skipped')
        ) AS overdue
      FROM lesson_schedules
      WHERE user_id = $1
        AND scheduled_date <= CURRENT_DATE
    `, [userId]);

    // 最新満足度
    const surveyRes = await db.query(`
      SELECT overall_score, survey_date
      FROM satisfaction_surveys
      WHERE student_user_id = $1
      ORDER BY survey_date DESC, created_at DESC
      LIMIT 1
    `, [userId]);

    res.json({
      video: videoProgressRes.rows[0],
      goals: goalSummary,
      schedule: scheduleRes.rows[0],
      latestSatisfaction: surveyRes.rows[0] || null
    });
  } catch (error) {
    console.error('Get progress summary error:', error);
    res.status(500).json({ error: '進捗サマリーの取得に失敗しました' });
  }
});

// ====================================================
// 延長審査 – ステータスとの連携強化
// ====================================================

/**
 * PATCH /api/students/:userId/status（既存を上書き拡張）
 * ステータス変更時に退会の場合は延長審査をすべて終了
 */
router.patch('/:userId/status-with-sync', auth, checkRole('管理者', 'クルー', 'セールス'), async (req, res) => {
  try {
    const { status, note } = req.body;
    const VALID_STATUSES = ['アクティブ', 'レッスン準備中', '休会', '正規退会', '強制退会'];
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `無効なステータスです。有効値: ${VALID_STATUSES.join(', ')}` });
    }

    const profile = await StudentProfile.updateStatus(req.params.userId, status, note, req.user.id);

    // 退会系は審査中の延長審査を自動クローズ
    if (['正規退会', '強制退会'].includes(status)) {
      await db.query(`
        UPDATE extension_reviews
        SET review_status = '延長なし',
            result = '否認',
            result_reason = 'ステータス変更により自動クローズ: ' || $1,
            review_end_date = CURRENT_DATE,
            updated_at = CURRENT_TIMESTAMP
        WHERE student_user_id = $2
          AND review_status IN ('審査中', '保留')
      `, [status, req.params.userId]);
    }

    await ActivityLog.log({
      userId: req.user.id,
      action: 'student_status_change',
      targetType: 'student',
      targetId: parseInt(req.params.userId),
      detail: { newStatus: status, note },
      ipAddress: req.ip
    });

    res.json(profile);
  } catch (error) {
    console.error('Status with sync error:', error);
    res.status(500).json({ error: 'ステータス更新に失敗しました' });
  }
});

// ====================================================
// 延長審査 – メモ履歴追加
// ====================================================

/**
 * POST /api/students/extensions/:reviewId/memo
 * 延長審査にメモを追加
 */
router.post('/extensions/:reviewId/memo', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const { memo } = req.body;
    if (!memo) return res.status(400).json({ error: 'メモを入力してください' });

    const result = await db.query(`
      UPDATE extension_reviews
      SET memo_history = COALESCE(memo_history, '[]'::jsonb) || $1::jsonb,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
    `, [
      JSON.stringify([{
        text: memo,
        author_id: req.user.id,
        created_at: new Date().toISOString()
      }]),
      req.params.reviewId
    ]);

    if (!result.rows.length) return res.status(404).json({ error: '審査が見つかりません' });

    await ActivityLog.log({
      userId: req.user.id,
      action: 'extension_memo_add',
      targetType: 'extension_review',
      targetId: parseInt(req.params.reviewId),
      detail: { memo: memo.substring(0, 50) },
      ipAddress: req.ip
    });

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Add memo error:', error);
    res.status(500).json({ error: 'メモの追加に失敗しました' });
  }
});

// ====================================================
// 総合ダッシュボード用API
// ====================================================

/**
 * GET /api/students/dashboard/summary
 * 管理者・クルー向けダッシュボードサマリー
 */
router.get('/dashboard/summary', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const tutorFilter = req.user.role === 'クルー'
      ? `AND sp.assigned_tutor_id = ${req.user.id}` : '';

    // 生徒ステータス集計
    const statusRes = await db.query(`
      SELECT
        sp.status,
        COUNT(*) AS count
      FROM users u
      JOIN student_profiles sp ON u.id = sp.user_id
      WHERE u.role = '生徒' ${tutorFilter}
      GROUP BY sp.status
    `);

    // 要注意生徒（7日未活動 or 目標遅延 or スケジュール遅延）
    const alertRes = await db.query(`
      SELECT
        COUNT(DISTINCT u.id) FILTER (
          WHERE MAX(up.last_watched_at) < CURRENT_TIMESTAMP - INTERVAL '7 days'
             OR MAX(up.last_watched_at) IS NULL
        ) AS inactive_7days,
        COUNT(DISTINCT u.id) FILTER (
          WHERE sp.contract_end_date IS NOT NULL
            AND sp.contract_end_date <= CURRENT_DATE + INTERVAL '30 days'
            AND sp.contract_end_date >= CURRENT_DATE
            AND sp.status = 'アクティブ'
        ) AS expiring_30days,
        COUNT(DISTINCT er.student_user_id) AS under_review
      FROM users u
      JOIN student_profiles sp ON u.id = sp.user_id
      LEFT JOIN user_progress up ON u.id = up.user_id
      LEFT JOIN extension_reviews er ON u.id = er.student_user_id
        AND er.review_status IN ('審査中', '保留')
      WHERE u.role = '生徒' ${tutorFilter}
      GROUP BY ()
    `);

    // 未確認引き継ぎ
    const handoverRes = await db.query(`
      SELECT COUNT(*) AS pending_handovers
      FROM handover_info h
      ${req.user.role === 'クルー' ? `WHERE h.tutor_user_id = ${req.user.id} AND h.status = 'submitted'` : `WHERE h.status = 'submitted'`}
    `);

    // 最近の満足度（直近30日）
    const surveyRes = await db.query(`
      SELECT ROUND(AVG(ss.overall_score), 2) AS avg_score, COUNT(*) AS survey_count
      FROM satisfaction_surveys ss
      LEFT JOIN student_profiles sp ON ss.student_user_id = sp.user_id
      WHERE ss.created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
      ${req.user.role === 'クルー' ? `AND sp.assigned_tutor_id = ${req.user.id}` : ''}
    `);

    res.json({
      statusCounts: statusRes.rows,
      alerts: alertRes.rows[0] || {},
      pendingHandovers: parseInt(handoverRes.rows[0]?.pending_handovers) || 0,
      recentSatisfaction: surveyRes.rows[0] || {}
    });
  } catch (error) {
    console.error('Get dashboard summary error:', error);
    res.status(500).json({ error: 'サマリーの取得に失敗しました' });
  }
});

module.exports = router;
