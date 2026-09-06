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
      options: typeof row.options === 'string' ? JSON.parse(row.options) : row.options,
      correctAnswer: row.correct_answer,
      orderIndex: row.order_index,
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

  static async replaceByLesson(lessonId, questions) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM quiz_questions WHERE lesson_id = $1', [lessonId]);

      const created = [];
      for (const item of questions) {
        const result = await client.query(
          `INSERT INTO quiz_questions (lesson_id, question, options, correct_answer, order_index)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [lessonId, item.question, JSON.stringify(item.options), item.correctAnswer, item.orderIndex]
        );
        created.push(result.rows[0]);
      }

      // クイズを追加した時点で、未合格の完了記録は次レッスンの解放条件から外す。
      if (questions.length > 0) {
        await client.query(`
          UPDATE user_progress
          SET completed = false,
              completed_at = NULL
          WHERE lesson_id = $1
            AND COALESCE(quiz_passed, false) = false
        `, [lessonId]);
      }

      await client.query('COMMIT');
      return created;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
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
    const passed = score >= 80; // 80%以上で合格

    return {
      passed,
      score,
      total: questions.length,
      correct
    };
  }
}

module.exports = Quiz;
