export const CONFIG = {
  PORT: parseInt(process.env.PORT, 10) || 3000,
  API_KEY: process.env.API_KEY || null,
  JOB_TTL_MINUTES: parseFloat(process.env.JOB_TTL_MINUTES) || 60,
  MAX_DEPTH_LIMIT: 10,
  DEFAULT_MAX_DEPTH: 3,
  MAX_PAGES_LIMIT: 500,
  DEFAULT_MAX_PAGES: 30,
  DEFAULT_CONCURRENCY: 3,
  MAX_CONCURRENCY_LIMIT: 5,
  RATE_LIMIT_WINDOW_MS: 60 * 1000, // 1 minute
  RATE_LIMIT_MAX_REQUESTS: 20,     // 20 requests/minute per IP
  STORAGE_DIR: 'storage',
  HARD_JOB_TIMEOUT_MS: 10 * 60 * 1000, // 10 minutes
  MAX_JOBS_IN_MEMORY: 100,

  // LLM form-filling settings
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || '',
  LLM_MAX_CALLS: parseInt(process.env.LLM_MAX_CALLS, 10) || 30,
  LLM_MAX_SUBMITS_PER_PAGE: parseInt(process.env.LLM_MAX_SUBMITS_PER_PAGE, 10) || 2
};
