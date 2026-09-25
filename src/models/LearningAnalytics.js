const db = require('../config/database');

const rate = (numerator, denominator) => denominator ? Math.round(numerator / denominator * 10000) / 100 : null;
function summarize(lessons) {
  const videos = lessons.filter(l => l.content_type === 'video');
  const quizzes = lessons.filter(l => l.has_quiz);
  const attempted = quizzes.filter(l => l.quiz_attempts > 0);
  const attempts = attempted.reduce((sum, l) => sum + l.quiz_attempts, 0);
  const retries = attempted.reduce((sum, l) => sum + Math.max(l.quiz_attempts - 1, 0), 0);
  const completeHistory = attempted.every(l => l.quiz_failed_attempts != null);
  const failed = completeHistory ? attempted.reduce((sum, l) => sum + l.quiz_failed_attempts, 0) : null;
  const passed = quizzes.filter(l => l.quiz_passed).length;
  const completed = lessons.filter(l => l.completed).length;
  const accessible = lessons.filter(l => l.can_access).length;
  return {
    total: lessons.length, completed, completion_rate: rate(completed, lessons.length),
    accessible, unlock_rate: rate(accessible, lessons.length),
    video_total: videos.length, videos_opened: videos.filter(l => l.view_count > 0).length,
    video_views: videos.reduce((sum, l) => sum + l.view_count, 0),
    videos_watched: videos.filter(l => l.watch_percent >= 95).length,
    quiz_total: quizzes.length, quiz_attempted: attempted.length,
    quiz_attempt_rate: rate(attempted.length, quizzes.length), quiz_attempts: attempts,
    quiz_passed: passed, quiz_final_pass_rate: rate(passed, quizzes.length),
    quiz_failed_attempts: failed,
    quiz_attempt_pass_rate: failed == null ? null : rate(attempts - failed, attempts),
    average_attempts: attempted.length ? attempts / attempted.length : null,
    average_retries: attempted.length ? retries / attempted.length : null,
  };
}

function buildAnalytics(rows, requiredIds = []) {
  const courses = [];
  const priorLessonsComplete = new Map();
  for (const row of rows) {
    let course = courses.find(c => c.id === row.course_id);
    if (!course) {
      course = { id: row.course_id, title: row.course_title, sequential: row.sequential_unlock,
        special: row.is_special_content, required: requiredIds.includes(row.course_id), lessons: [] };
      courses.push(course);
    }
    const previousComplete = priorLessonsComplete.get(row.course_id) ?? true;
    const canAccess = !course.sequential || previousComplete;
    priorLessonsComplete.set(row.course_id, previousComplete &&
      row.completed && (!row.has_quiz || row.quiz_passed));
    course.lessons.push({ ...row, can_access: Boolean(canAccess),
      watch_complete: row.content_type === 'video' && row.watch_percent >= 95,
      quiz_retries: Math.max(row.quiz_attempts - 1, 0) });
  }
  for (const course of courses) {
    course.kpi = summarize(course.lessons);
    course.next_locked_lesson = course.lessons.find(l => !l.can_access)?.id ?? null;
  }
  return { courses, required_configured: requiredIds.length > 0,
    required: summarize(courses.filter(c => c.required && !c.special).flatMap(c => c.lessons)),
    overall: summarize(courses.filter(c => !c.special).flatMap(c => c.lessons)) };
}

class LearningAnalytics {
  static async forStudent(userId) {
    const result = await db.query(`
      SELECT l.id, l.title, l.course_id, c.title AS course_title,
        c.sequential_unlock, c.is_special_content, COALESCE(l.content_type, 'video') AS content_type,
        EXISTS (SELECT 1 FROM quiz_questions q WHERE q.lesson_id = l.id) AS has_quiz,
        COALESCE(p.view_count, 0) AS view_count, COALESCE(p.watch_percent, 0) AS watch_percent,
        COALESCE(p.completed, false) AS completed, COALESCE(p.quiz_passed, false) AS quiz_passed,
        COALESCE(p.quiz_attempts, 0) AS quiz_attempts, p.quiz_failed_attempts
      FROM lessons l JOIN courses c ON c.id = l.course_id
      LEFT JOIN user_progress p ON p.lesson_id = l.id AND p.user_id = $1
      ORDER BY c.order_index, c.id, l.order_index, l.id
    `, [userId]);
    const ids = String(process.env.REQUIRED_COURSE_IDS || '').split(',').map(Number)
      .filter(n => Number.isInteger(n) && n > 0);
    return buildAnalytics(result.rows, ids);
  }
}
module.exports = { LearningAnalytics, summarize, buildAnalytics };
