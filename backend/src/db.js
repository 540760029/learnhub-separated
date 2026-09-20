/**
 * 数据访问层 —— 面向「驱动接口」而非某个具体数据库
 *
 * 本项目只跑 MySQL，驱动由 src/drivers.js 提供（mysql2）。
 *
 * 本层只做三件事：薄封装驱动、统一 JSON 字段解析、业务读写辅助。
 * 刻意不引 ORM —— 裸 SQL 更直观。
 *
 * 注意：SQL 按原生 MySQL 写。`key` 是 MySQL 保留字，settings 表的相关语句
 * 必须写成 `` `key` ``（反引号由业务层显式写出，不再依赖运行期正则改写）。
 */

export function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/** JSON 字段解析：数据库里存的是文本 */
export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function toJson(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/**
 * 生成 upsert 语句（通用写法）
 *
 * 用 UPDATE-then-INSERT 而不是 MySQL 的 ON DUPLICATE KEY UPDATE：
 * 「先试更新、影响行数为 0 再插入」语义更直白，也不依赖具体索引名，
 * 并发下由唯一约束兜底（见下面各处的 isDuplicate 分支）。
 */
export class Db {
  constructor(driver) {
    if (!driver) throw new Error('缺少数据库驱动');
    this.driver = driver;
  }

  get dialect() {
    return this.driver.dialect;
  }

  async all(sql, ...params) {
    return this.driver.prepare(sql).bind(...params).all();
  }

  async first(sql, ...params) {
    return this.driver.prepare(sql).bind(...params).first();
  }

  async run(sql, ...params) {
    return this.driver.prepare(sql).bind(...params).run();
  }

  prepare(sql) {
    return this.driver.prepare(sql);
  }

  /** 批量执行（驱动层用一个事务包住，保证要么全成要么全回滚） */
  async batch(statements) {
    return this.driver.batch(statements);
  }

  async execScript(sql) {
    return this.driver.execScript(sql);
  }

  /**
   * 幂等 upsert：先 UPDATE，没命中再 INSERT。
   * 并发下可能两个请求同时 UPDATE 失败并同时 INSERT，由唯一约束兜底，
   * 调用方可捕获后忽略（isDuplicate）。
   */
  async upsert({ table, keyColumns, values, updateColumns = null }) {
    const keys = Object.keys(values);
    const where = keyColumns.map((k) => `${k} = ?`).join(' AND ');
    const whereVals = keyColumns.map((k) => values[k]);
    const updatable = (updateColumns || keys.filter((k) => !keyColumns.includes(k)));

    if (updatable.length) {
      const setSql = updatable.map((c) => `${c} = ?`).join(', ');
      const r = await this.run(
        `UPDATE ${table} SET ${setSql} WHERE ${where}`,
        ...updatable.map((c) => values[c]), ...whereVals,
      );
      if (r.changes > 0) return { inserted: false, changes: r.changes };
    }

    const cols = keys.join(', ');
    const marks = keys.map(() => '?').join(', ');
    try {
      const r = await this.run(
        `INSERT INTO ${table} (${cols}) VALUES (${marks})`, ...keys.map((k) => values[k]),
      );
      return { inserted: true, lastRowId: r.lastRowId };
    } catch (err) {
      if (this.driver.isDuplicateError(err)) return { inserted: false, duplicate: true };
      throw err;
    }
  }

  isDuplicate(err) {
    return this.driver.isDuplicateError(err);
  }

  // ------------------------------------------------------------ 便捷查询
  async getUserById(id) {
    return this.first('SELECT * FROM users WHERE id = ?', id);
  }

  async getUserByEmail(email) {
    return this.first('SELECT * FROM users WHERE email = ?', String(email || '').toLowerCase());
  }

  async getCourse(id) {
    return this.first('SELECT * FROM courses WHERE id = ?', id);
  }

  async listCoursesOwned(teacherId) {
    return this.all('SELECT * FROM courses WHERE teacher_id = ? ORDER BY created_at DESC', teacherId);
  }

  async listCoursesAssisting(teacherId) {
    return this.all(
      `SELECT c.* FROM courses c
         JOIN course_teachers ct ON ct.course_id = c.id
        WHERE ct.teacher_id = ? AND c.teacher_id <> ?
        ORDER BY c.created_at DESC`,
      teacherId, teacherId,
    );
  }

  async listCoursesJoined(studentId) {
    return this.all(
      `SELECT c.* FROM courses c
         JOIN enrollments e ON e.course_id = c.id
        WHERE e.student_id = ?
        ORDER BY c.created_at DESC`,
      studentId,
    );
  }

  async isEnrolled(courseId, studentId) {
    const row = await this.first(
      'SELECT 1 AS ok FROM enrollments WHERE course_id = ? AND student_id = ?',
      courseId, studentId,
    );
    return !!row;
  }

  async isAssistingTeacher(courseId, teacherId) {
    const row = await this.first(
      'SELECT 1 AS ok FROM course_teachers WHERE course_id = ? AND teacher_id = ?',
      courseId, teacherId,
    );
    return !!row;
  }

  async studentsOf(courseId) {
    return this.all(
      `SELECT u.* FROM users u
         JOIN enrollments e ON e.student_id = u.id
        WHERE e.course_id = ?
        ORDER BY u.name`,
      courseId,
    );
  }

  async countStudents(courseId) {
    const row = await this.first('SELECT COUNT(*) AS n FROM enrollments WHERE course_id = ?', courseId);
    return row?.n ?? 0;
  }

  /** 课程维度计数，用于课程卡片 */
  async courseCounts(courseId) {
    const [kp, asg, quiz, stu] = await Promise.all([
      this.first('SELECT COUNT(*) AS n FROM knowledge_points WHERE course_id = ?', courseId),
      this.first('SELECT COUNT(*) AS n FROM assignments WHERE course_id = ?', courseId),
      this.first('SELECT COUNT(*) AS n FROM quiz_sets WHERE course_id = ?', courseId),
      this.countStudents(courseId),
    ]);
    return {
      kp_count: kp?.n ?? 0,
      assignment_count: asg?.n ?? 0,
      quiz_count: quiz?.n ?? 0,
      student_count: stu,
    };
  }

  // ------------------------------------------------------------ AI 额度
  async getUsage(userId) {
    const day = today();
    let row = await this.first('SELECT * FROM ai_usage WHERE user_id = ? AND day = ?', userId, day);
    if (!row) {
      try {
        await this.run(
          'INSERT INTO ai_usage (user_id, day, used, used_own_key, last_at) VALUES (?,?,0,0,?)',
          userId, day, nowIso(),
        );
      } catch (err) {
        if (!this.isDuplicate(err)) throw err;      // 并发下另一个请求刚插入，忽略
      }
      row = await this.first('SELECT * FROM ai_usage WHERE user_id = ? AND day = ?', userId, day);
    }
    return row;
  }

  async bumpUsage(userId, { ownKey }) {
    const day = today();
    const incUsed = ownKey ? 0 : 1;
    const incOwn = ownKey ? 1 : 0;
    // 先尝试累加；没有当天记录时再插一条（并发冲突忽略）
    const r = await this.run(
      `UPDATE ai_usage SET used = used + ?, used_own_key = used_own_key + ?, last_at = ?
        WHERE user_id = ? AND day = ?`,
      incUsed, incOwn, nowIso(), userId, day,
    );
    if (r.changes > 0) return;
    try {
      await this.run(
        'INSERT INTO ai_usage (user_id, day, used, used_own_key, last_at) VALUES (?,?,?,?,?)',
        userId, day, incUsed, incOwn, nowIso(),
      );
    } catch (err) {
      if (!this.isDuplicate(err)) throw err;
      // 竞态：别人刚建了当天记录，补一次累加
      await this.run(
        `UPDATE ai_usage SET used = used + ?, used_own_key = used_own_key + ?, last_at = ?
          WHERE user_id = ? AND day = ?`,
        incUsed, incOwn, nowIso(), userId, day,
      );
    }
  }

  async sumUsageToday() {
    const row = await this.first(
      'SELECT COALESCE(SUM(used + used_own_key), 0) AS n FROM ai_usage WHERE day = ?', today(),
    );
    return row?.n ?? 0;
  }

  // ------------------------------------------------------------ 平台配置
  async getSetting(key, fallback = null) {
    const row = await this.first('SELECT value FROM settings WHERE `key` = ?', key);
    return row && row.value !== null && row.value !== undefined ? row.value : fallback;
  }

  async setSetting(key, value) {
    const r = await this.run(
      'UPDATE settings SET value = ?, updated_at = ? WHERE `key` = ?', value, nowIso(), key,
    );
    if (r.changes > 0) return;
    try {
      await this.run(
        'INSERT INTO settings (`key`, value, updated_at) VALUES (?,?,?)', key, value, nowIso(),
      );
    } catch (err) {
      if (!this.isDuplicate(err)) throw err;
      await this.run(
        'UPDATE settings SET value = ?, updated_at = ? WHERE `key` = ?', value, nowIso(), key,
      );
    }
  }

  async getSettings(keys) {
    if (!keys.length) return {};
    const placeholders = keys.map(() => '?').join(',');
    const rows = await this.all(
      `SELECT \`key\`, value FROM settings WHERE \`key\` IN (${placeholders})`, ...keys,
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  // ------------------------------------------------------------ 薄弱点统计
  async bumpWeakStats(studentId, detail) {
    const byKp = new Map();
    for (const d of detail || []) {
      if (!d.kp_id) continue;
      const cur = byKp.get(d.kp_id) || { total: 0, wrong: 0 };
      cur.total += 1;
      if (!d.correct) cur.wrong += 1;
      byKp.set(d.kp_id, cur);
    }
    const stmts = [];
    for (const [kpId, v] of byKp) {
      // 同样用「先 UPDATE 再 INSERT」的通用写法，避免 ON CONFLICT / ON DUPLICATE 差异
      const r = await this.run(
        `UPDATE weak_stats SET total = total + ?, wrong = wrong + ?, updated_at = ?
          WHERE student_id = ? AND kp_id = ?`,
        v.total, v.wrong, nowIso(), studentId, kpId,
      );
      if (r.changes > 0) continue;
      stmts.push(this.prepare(
        'INSERT INTO weak_stats (student_id, kp_id, total, wrong, updated_at) VALUES (?,?,?,?,?)',
      ).bind(studentId, kpId, v.total, v.wrong, nowIso()));
    }
    if (stmts.length) {
      try {
        await this.batch(stmts);
      } catch (err) {
        if (!this.isDuplicate(err)) throw err;
        // 并发插入冲突：逐条重试为累加
        for (const [kpId, v] of byKp) {
          await this.run(
            `UPDATE weak_stats SET total = total + ?, wrong = wrong + ?, updated_at = ?
              WHERE student_id = ? AND kp_id = ?`,
            v.total, v.wrong, nowIso(), studentId, kpId,
          );
        }
      }
    }
  }
}

/** 生成课程邀请码（避开容易混淆的 0/O/1/I） */
export function randomJoinCode(len = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
