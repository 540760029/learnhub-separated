/**
 * 运行时配置
 *
 * 全部来自环境变量（本地开发放在 backend/.env，已 gitignore；
 * 服务器上用 systemd 的 Environment= 注入）。参见 .env.example。
 */

export const DEFAULT_SECRET = 'dev-only-change-me-in-production';

/** settings 表里的键名 */
export const SK = {
  platformProvider: 'platform_ai_provider',
  platformKeyEnc: 'platform_ai_api_key_enc',
  platformBaseUrl: 'platform_ai_base_url',
  platformModel: 'platform_ai_model',
  platformEnabled: 'platform_ai_enabled',
  dailyLimit: 'daily_ai_limit',
};

export function getConfig(env) {
  const e = env || {};
  const secret = String(e.LEARNHUB_SECRET || DEFAULT_SECRET);
  return {
    secret,
    usingDefaultSecret: secret === DEFAULT_SECRET,
    defaultProvider: String(e.LEARNHUB_DEFAULT_PROVIDER || 'deepseek'),
    platformApiKey: String(e.LEARNHUB_PLATFORM_API_KEY || '').trim(),
    dailyAiLimit: Number(e.LEARNHUB_DAILY_AI_LIMIT || 3),
    tokenTtl: Number(e.LEARNHUB_TOKEN_TTL || 7 * 24 * 3600),
    // 允许跨源访问前端。'*' 放行任意来源；也可写逗号分隔白名单，
    // 例如 http://localhost:5173,http://127.0.0.1:5173
    corsOrigin: String(e.LEARNHUB_CORS_ORIGIN ?? '*'),
  };
}
