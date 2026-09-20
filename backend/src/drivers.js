/**
 * 数据库驱动层 —— MySQL
 *
 * 后端固定「本地 Node + MySQL」一种运行方式，mysql2 是唯一的运行期依赖。
 *
 * 保留这一层薄驱动，是为了让业务代码（src/app.js、src/db.js）不直接耦合 mysql2，
 * 驱动接口固定为：all / first / run / batch / execScript / isDuplicateError / close。
 *
 * SQL 全部按原生 MySQL 方言写：`key` 是保留字，settings 表相关语句直接写成
 * `` `key` ``，不依赖任何运行期正则改写。
 */

class MysqlStatement {
  constructor(driver, sql, params = []) {
    this.driver = driver;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new MysqlStatement(this.driver, this.sql, params);
  }

  async all() {
    const [rows] = await this.driver.pool.query(this.sql, this.params);
    return Array.isArray(rows) ? rows : [];
  }

  async first() {
    const rows = await this.all();
    return rows.length ? rows[0] : null;
  }

  async run() {
    const [res] = await this.driver.pool.query(this.sql, this.params);
    return {
      changes: Number(res?.affectedRows ?? 0),
      lastRowId: res?.insertId != null ? Number(res.insertId) : null,
    };
  }
}

class MysqlDriver {
  /**
   * @param {object} pool mysql2/promise 连接池
   * 说明：所有自增主键统一通过 lastRowId 返回，业务层只认这个字段。
   */
  constructor(pool) {
    this.kind = 'mysql';
    this.dialect = 'mysql';
    this.pool = pool;
  }

  prepare(sql) {
    return new MysqlStatement(this, sql);
  }

  async batch(statements) {
    const conn = await this.pool.getConnection();
    const out = [];
    try {
      await conn.beginTransaction();
      for (const s of statements) {
        const [res] = await conn.query(s.sql, s.params);
        out.push({
          changes: Number(res?.affectedRows ?? 0),
          lastRowId: res?.insertId != null ? Number(res.insertId) : null,
        });
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
    return out;
  }

  /**
   * 执行迁移脚本：按分号切分逐条执行。
   * MySQL 不支持 CREATE INDEX IF NOT EXISTS（那是 MariaDB 扩展），
   * 所以这里容忍「索引/表已存在」类错误，保证脚本可重复执行。
   */
  async execScript(sql) {
    const statements = splitStatements(sql);
    let executed = 0;
    for (const s of statements) {
      try {
        await this.pool.query(s);
        executed += 1;
      } catch (err) {
        if (this.isDuplicateError(err)) continue;    // 索引/表已存在
        throw err;
      }
    }
    return executed;
  }

  isDuplicateError(err) {
    const code = err?.code || '';
    return code === 'ER_DUP_ENTRY' || code === 'ER_DUP_KEYNAME'
      || code === 'ER_TABLE_EXISTS_ERROR' || code === 'ER_MULTIPLE_PRI_KEY';
  }

  async close() {
    await this.pool.end();
  }
}

/** 连接 MySQL 并返回驱动（mysql2 是唯一的运行期依赖） */
export async function createMysqlDriver({
  host, port = 3306, user, password, database, connectionLimit = 5,
}) {
  const name = 'mysql2/promise';
  const mysql = await import(name);
  const pool = mysql.createPool({
    host, port, user, password, database,
    waitForConnections: true,
    connectionLimit,
    charset: 'utf8mb4',
    // 多语句交给 execScript 自己切分，避免注入面变大
    multipleStatements: false,
  });
  await pool.query('SELECT 1');      // 尽早暴露连接错误
  return new MysqlDriver(pool);
}

/** 解析 mysql://user:pass@host:port/db 形式的连接串 */
export function parseMysqlUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  };
}

/** 从环境变量连接：LEARNHUB_DB_URL 是唯一的数据库配置入口 */
export async function connectFromEnv(env = process.env) {
  const url = String(env.LEARNHUB_DB_URL || '').trim();
  if (!url) {
    throw new Error(
      '缺少 LEARNHUB_DB_URL。示例：mysql://learnhub:密码@127.0.0.1:3306/learnhub',
    );
  }
  return createMysqlDriver(parseMysqlUrl(url));
}

/**
 * 按分号切分多语句脚本（用于迁移）。
 * 简单但够用：schema 里没有存储过程 / 触发器等含分号的语句。
 */
export function splitStatements(sql) {
  return String(sql)
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
