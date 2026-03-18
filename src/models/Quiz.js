const db = require('../config/database');

class Quiz {
  static async createQuestion(lessonId, question, options, correctAnswer, orderIndex = 0) {
    const result = await db.query(
      `INSERT INTO quiz_questions (lesson_id, question, options, correct_answer, order_index)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [lessonId, question, JSON.stringify(options), correctAnswer, orderIndex]
    );
    return result.rows[0];
  }

  static async getQuestionsByLesson(lessonId) {
    const result = await db.query(
      'SELECT * FROM quiz_questions WHERE lesson_id = $1 ORDER BY order_index ASC',
      [lessonId]
    );
    return result.rows.map(row => ({
      ...row,
      options: typeof row.options === 'string' ? JSON.parse(row.options) : row.options
    }));
  }

  static async updateQuestion(id, question, options, correctAnswer) {
    const result = await db.query(
      `UPDATE quiz_questions 
       SET question = $1, options = $2, correct_answer = $3
       WHERE id = $4 RETURNING *`,
      [question, JSON.stringify(options), correctAnswer, id]
    );
    return result.rows[0];
  }

  static async deleteQuestion(id) {
    await db.query('DELETE FROM quiz_questions WHERE id = $1', [id]);
  }

  static async deleteByLesson(lessonId) {
    await db.query('DELETE FROM quiz_questions WHERE lesson_id = $1', [lessonId]);
  }

  static async verifyAnswers(lessonId, answers) {
    const questions = await this.getQuestionsByLesson(lessonId);
    
    if (questions.length === 0) {
      return { passed: true, score: 100, total: 0, correct: 0 };
    }

    let correct = 0;
    questions.forEach((q, index) => {
      if (answers[index] === q.correct_answer) {
        correct++;
      }
    });

    const score = Math.round((correct / questions.length) * 100);
    const passed = score === 100; // 全問正解が必要

    return {
      passed,
      score,
      total: questions.length,
      correct
    };
  }
}

module.exports = Quiz;
