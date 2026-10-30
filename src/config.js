export const CONFIG = {
  PORT: parseInt(process.env.PORT, 10) || 3000,
  MAX_DEPTH_LIMIT: 10,
  DEFAULT_MAX_DEPTH: 3,
  MAX_PAGES_LIMIT: 500,
  DEFAULT_MAX_PAGES: 30,
  RATE_LIMIT_WINDOW_MS: 60 * 1000, // 1 minute
  RATE_LIMIT_MAX_REQUESTS: 20,     // 20 requests/minute per IP
  STORAGE_DIR: 'storage',
  HARD_JOB_TIMEOUT_MS: 10 * 60 * 1000 // 10 minutes
};
