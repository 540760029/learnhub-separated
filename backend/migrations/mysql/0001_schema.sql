-- ============================================================
--  LearnHub · MySQL 建表脚本（唯一 schema 事实来源）
--
--  建库：  npm run db:create
--  建表：  npm run db:migrate      （幂等，可反复执行）
--  演示数据：npm run db:seed       （由 src/bootstrap.js 的 seedDemoData 写入，
--                                  本文件不再内嵌 INSERT，避免两处种子数据打架）
--
--  说明：本文件即事实来源，不由任何脚本生成，请直接改这里。
--        时间统一存 ISO8601 UTC 字符串。
--        注意 `key` 是 MySQL 保留字（见 settings 表），必须带反引号。
-- ============================================================

-- --------------------------------------------------------------------- 用户
CREATE TABLE IF NOT EXISTS users (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255)    NOT NULL UNIQUE,
  name LONGTEXT    NOT NULL,
  role VARCHAR(255)    NOT NULL DEFAULT 'student',   -- teacher | student
  is_admin        INT NOT NULL DEFAULT 0,           -- 平台管理员
  password_hash LONGTEXT    NOT NULL,
  school LONGTEXT,
  student_no LONGTEXT,
  is_active       INT NOT NULL DEFAULT 1,
  -- AI 配置（自带的 key 加密存储，绝不明文）
  ai_provider LONGTEXT,
  ai_api_key_enc LONGTEXT,
  ai_base_url LONGTEXT,
  ai_model LONGTEXT,
  created_at LONGTEXT    NOT NULL
);
CREATE INDEX idx_users_email   ON users(email);
CREATE INDEX idx_users_role    ON users(role);
CREATE INDEX idx_users_admin   ON users(is_admin);

-- --------------------------------------------------------------------- 课程
CREATE TABLE IF NOT EXISTS courses (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title LONGTEXT    NOT NULL,
  description LONGTEXT,
  cover_emoji VARCHAR(255)    NOT NULL DEFAULT '📘',
  join_code VARCHAR(255)    NOT NULL UNIQUE,
  teacher_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_published  INT NOT NULL DEFAULT 1,
  created_at LONGTEXT    NOT NULL
);
CREATE INDEX idx_courses_teacher ON courses(teacher_id);
CREATE INDEX idx_courses_code    ON courses(join_code);

-- 选课关系
CREATE TABLE IF NOT EXISTS enrollments (
  course_id  INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id INT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  created_at LONGTEXT    NOT NULL,
  PRIMARY KEY (course_id, student_id)
);

-- 协助教师
CREATE TABLE IF NOT EXISTS course_teachers (
  course_id  INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  teacher_id INT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  PRIMARY KEY (course_id, teacher_id)
);

-- --------------------------------------------------------------------- 知识点
-- scope: course  全班可见（教师发布）
--        teacher 仅教师可见（教师草稿）
--        private 仅创建者本人可见（学生笔记）
CREATE TABLE IF NOT EXISTS knowledge_points (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  course_id   INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title LONGTEXT    NOT NULL,
  content VARCHAR(255)    NOT NULL DEFAULT '',
  order_no    INT NOT NULL DEFAULT 0,
  scope VARCHAR(255)    NOT NULL DEFAULT 'course',
  created_by  INT REFERENCES users(id) ON DELETE SET NULL,
  source_file LONGTEXT,
  created_at LONGTEXT    NOT NULL
);
CREATE INDEX idx_kp_course ON knowledge_points(course_id);
CREATE INDEX idx_kp_scope  ON knowledge_points(scope);

-- --------------------------------------------------------------------- 作业
CREATE TABLE IF NOT EXISTS assignments (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  course_id  INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title LONGTEXT    NOT NULL,
  content VARCHAR(255)    NOT NULL DEFAULT '',
  due_at LONGTEXT,
  full_score DOUBLE    NOT NULL DEFAULT 100,
  created_at LONGTEXT    NOT NULL
);
CREATE INDEX idx_asg_course ON assignments(course_id);

CREATE TABLE IF NOT EXISTS submissions (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  assignment_id  INT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id     INT NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  content VARCHAR(255)    NOT NULL DEFAULT '',
  attachment_url LONGTEXT,
  score          DOUBLE,
  feedback LONGTEXT,
  submitted_at LONGTEXT    NOT NULL,
  graded_at LONGTEXT,
  UNIQUE (assignment_id, student_id)
);
CREATE INDEX idx_sub_asg ON submissions(assignment_id);
CREATE INDEX idx_sub_stu ON submissions(student_id);

-- --------------------------------------------------------------------- 试题
-- scope: course 全班可见 | teacher 仅教师可见 | private 仅创建者可见
CREATE TABLE IF NOT EXISTS quiz_sets (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  course_id    INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title LONGTEXT    NOT NULL,
  source VARCHAR(255)    NOT NULL DEFAULT 'manual',   -- manual | ai
  scope VARCHAR(255)    NOT NULL DEFAULT 'course',
  kp_ids LONGTEXT,                                -- JSON 数组
  created_by   INT REFERENCES users(id) ON DELETE SET NULL,
  is_published INT NOT NULL DEFAULT 1,
  created_at LONGTEXT    NOT NULL
);
CREATE INDEX idx_quiz_course ON quiz_sets(course_id);
CREATE INDEX idx_quiz_scope  ON quiz_sets(scope);

CREATE TABLE IF NOT EXISTS questions (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  quiz_set_id INT NOT NULL REFERENCES quiz_sets(id) ON DELETE CASCADE,
  qtype VARCHAR(255)    NOT NULL DEFAULT 'single',    -- single | multi | judge | short
  stem LONGTEXT    NOT NULL,
  options LONGTEXT,                                 -- JSON 数组
  answer VARCHAR(255)    NOT NULL DEFAULT '',
  analysis VARCHAR(255)    NOT NULL DEFAULT '',
  difficulty  INT NOT NULL DEFAULT 3,           -- 1~5
  kp_id       INT REFERENCES knowledge_points(id) ON DELETE SET NULL,
  order_no    INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_q_quiz ON questions(quiz_set_id);

CREATE TABLE IF NOT EXISTS attempts (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  quiz_set_id  INT NOT NULL REFERENCES quiz_sets(id) ON DELETE CASCADE,
  student_id   INT NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  answers LONGTEXT,                                -- JSON {questionId: answer}
  score        DOUBLE    NOT NULL DEFAULT 0,
  total        DOUBLE    NOT NULL DEFAULT 0,
  detail LONGTEXT,                                -- JSON 逐题对错
  duration_sec INT NOT NULL DEFAULT 0,
  submitted_at LONGTEXT    NOT NULL
);
CREATE INDEX idx_att_quiz ON attempts(quiz_set_id);
CREATE INDEX idx_att_stu  ON attempts(student_id);

-- --------------------------------------------------------------------- AI 额度
CREATE TABLE IF NOT EXISTS ai_usage (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  `day` VARCHAR(255)    NOT NULL,                    -- YYYY-MM-DD (UTC)
  used         INT NOT NULL DEFAULT 0,          -- 用平台/教师 key
  used_own_key INT NOT NULL DEFAULT 0,          -- 用自带 key
  last_at LONGTEXT    NOT NULL,
  UNIQUE (user_id, `day`)
);
CREATE INDEX idx_usage_user ON ai_usage(user_id, `day`);

-- --------------------------------------------------------------------- 薄弱点
CREATE TABLE IF NOT EXISTS weak_stats (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  student_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kp_id      INT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  total      INT NOT NULL DEFAULT 0,
  wrong      INT NOT NULL DEFAULT 0,
  updated_at LONGTEXT    NOT NULL,
  UNIQUE (student_id, kp_id)
);
CREATE INDEX idx_weak_stu ON weak_stats(student_id);

-- --------------------------------------------------------------------- 公告
CREATE TABLE IF NOT EXISTS announcements (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  course_id  INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  content VARCHAR(255)    NOT NULL,
  created_at LONGTEXT    NOT NULL
);
CREATE INDEX idx_ann_course ON announcements(course_id);

-- --------------------------------------------------------------------- 平台配置
CREATE TABLE IF NOT EXISTS settings (
  `key` VARCHAR(255) PRIMARY KEY,
  value LONGTEXT,
  updated_at LONGTEXT NOT NULL
);
