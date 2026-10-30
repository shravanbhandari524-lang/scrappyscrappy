import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { ZipArchive } from 'archiver';
import { createJob, getJob, cancelJob, getJobStatusResponse } from '../jobs.js';
import { isSafeUrlAsync, isBasicSafeUrl } from '../urlGuard.js';
import { CONFIG } from '../config.js';

const router = Router();

const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const SAFE_FILENAME_REGEX = /^[a-zA-Z0-9_.-]+\.png$/;

/**
 * Health check: verify service up and Chromium can launch.
 */
router.get('/health', async (req, res) => {
  let chromiumOk = false;
  let chromiumError = null;

  try {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    await browser.close();
    chromiumOk = true;
  } catch (err) {
    chromiumError = err.message;
  }

  res.status(chromiumOk ? 200 : 503).json({
    status: chromiumOk ? 'ok' : 'degraded',
    service: 'deepcrawl',
    chromium: chromiumOk,
    ...(chromiumError && { error: chromiumError }),
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /api/crawl
 * Start a new crawl job.
 */
router.post('/crawl', async (req, res) => {
  const {
    url,
    maxDepth,
    maxPages,
    concurrency,
    maxScrolls,
    useSitemap,
    useLLM,
    screenshots,
    scrollPage,
    timeoutMs
  } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Valid "url" string is required' });
  }

  // Pre-validate safety
  const basic = isBasicSafeUrl(url);
  if (!basic.safe) {
    return res.status(400).json({ error: basic.reason });
  }

  const asyncCheck = await isSafeUrlAsync(url);
  if (!asyncCheck.safe) {
    return res.status(400).json({ error: asyncCheck.reason });
  }

  // LLM configuration check
  if (useLLM === true) {
    const hasKey = Boolean(process.env.OPENAI_API_KEY || CONFIG.OPENAI_API_KEY);
    const hasBase = Boolean(process.env.OPENAI_BASE_URL || CONFIG.OPENAI_BASE_URL);
    const isMock = process.env.LLM_MOCK === '1';
    if (!hasKey && !hasBase && !isMock) {
      return res.status(400).json({
        error: 'OPENAI_API_KEY or OPENAI_BASE_URL must be configured when useLLM is enabled'
      });
    }
  }

  // Validate caps
  let parsedDepth = CONFIG.DEFAULT_MAX_DEPTH;
  if (maxDepth !== undefined) {
    const d = parseInt(maxDepth, 10);
    if (Number.isNaN(d) || d < 0) {
      return res.status(400).json({ error: '"maxDepth" must be a non-negative integer' });
    }
    if (d > CONFIG.MAX_DEPTH_LIMIT) {
      return res.status(400).json({
        error: `"maxDepth" exceeds maximum allowed limit of ${CONFIG.MAX_DEPTH_LIMIT}`
      });
    }
    parsedDepth = d;
  }

  let parsedPages = CONFIG.DEFAULT_MAX_PAGES;
  if (maxPages !== undefined) {
    const p = parseInt(maxPages, 10);
    if (Number.isNaN(p) || p <= 0) {
      return res.status(400).json({ error: '"maxPages" must be a positive integer' });
    }
    if (p > CONFIG.MAX_PAGES_LIMIT) {
      return res.status(400).json({
        error: `"maxPages" exceeds maximum allowed limit of ${CONFIG.MAX_PAGES_LIMIT}`
      });
    }
    parsedPages = p;
  }

  let parsedConcurrency = CONFIG.DEFAULT_CONCURRENCY;
  if (concurrency !== undefined) {
    const c = parseInt(concurrency, 10);
    if (Number.isNaN(c) || c < 1) {
      return res.status(400).json({ error: '"concurrency" must be an integer between 1 and 5' });
    }
    parsedConcurrency = Math.min(CONFIG.MAX_CONCURRENCY_LIMIT, Math.max(1, c));
  }

  let parsedScrolls = 10;
  if (maxScrolls !== undefined) {
    const s = parseInt(maxScrolls, 10);
    if (!Number.isNaN(s) && s >= 0) {
      parsedScrolls = s;
    }
  }

  const job = createJob({
    url,
    maxDepth: parsedDepth,
    maxPages: parsedPages,
    concurrency: parsedConcurrency,
    maxScrolls: parsedScrolls,
    useSitemap: useSitemap !== false,
    useLLM: useLLM === true,
    screenshots: screenshots !== false,
    scrollPage: scrollPage !== false,
    timeoutMs: timeoutMs || CONFIG.HARD_JOB_TIMEOUT_MS
  });

  return res.status(201).json({
    jobId: job.jobId,
    status: job.status,
    url: job.options.url
  });
});

/**
 * GET /api/crawl/:jobId
 * Get job status and metrics.
 */
router.get('/crawl/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!SAFE_ID_REGEX.test(jobId)) {
    return res.status(400).json({ error: 'Invalid jobId format' });
  }

  const job = getJob(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  return res.json(getJobStatusResponse(job));
});

/**
 * GET /api/crawl/:jobId/results
 * Get full crawl results JSON.
 */
router.get('/crawl/:jobId/results', (req, res) => {
  const { jobId } = req.params;
  if (!SAFE_ID_REGEX.test(jobId)) {
    return res.status(400).json({ error: 'Invalid jobId format' });
  }

  const job = getJob(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status === 'queued' || job.status === 'running') {
    return res.status(409).json({
      error: 'Job not finished yet',
      status: job.status,
      pagesVisited: job.pagesVisited
    });
  }

  if (job.result) {
    return res.json(job.result);
  }

  return res.status(500).json({
    error: 'Job failed without result',
    status: job.status,
    errors: job.errors
  });
});

/**
 * GET /api/crawl/:jobId/download
 * Returns a .zip containing result.json (with relative screenshot paths) and screenshots/ folder.
 */
router.get('/crawl/:jobId/download', async (req, res) => {
  const { jobId } = req.params;
  if (!SAFE_ID_REGEX.test(jobId)) {
    return res.status(400).json({ error: 'Invalid jobId format' });
  }

  const job = getJob(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status === 'queued' || job.status === 'running') {
    return res.status(409).json({
      error: 'Job not finished yet',
      status: job.status
    });
  }

  if (!job.result) {
    return res.status(500).json({ error: 'Job has no results to download' });
  }

  res.attachment(`${jobId}_crawl.zip`);

  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('error', (err) => {
    console.error('[Archiver Error]', err);
    if (!res.headersSent) res.status(500).end();
  });
  archive.pipe(res);

  // Transform result to use relative screenshot links: screenshots/<file>.png
  const relativeResult = JSON.parse(JSON.stringify(job.result));
  if (Array.isArray(relativeResult.pages)) {
    for (const page of relativeResult.pages) {
      if (page.screenshot && typeof page.screenshot === 'string') {
        const basename = path.basename(page.screenshot);
        page.screenshot = `screenshots/${basename}`;
      }
    }
  }

  archive.append(JSON.stringify(relativeResult, null, 2), { name: 'result.json' });

  const jobScreenshotsDir = path.resolve(CONFIG.STORAGE_DIR, 'screenshots', jobId);
  try {
    const files = await fs.readdir(jobScreenshotsDir);
    for (const file of files) {
      if (file.endsWith('.png')) {
        archive.file(path.join(jobScreenshotsDir, file), { name: `screenshots/${file}` });
      }
    }
  } catch {
    // Ignore missing directory if screenshots disabled
  }

  await archive.finalize();
});

/**
 * DELETE /api/crawl/:jobId
 * Cancel running or queued job.
 */
router.delete('/crawl/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!SAFE_ID_REGEX.test(jobId)) {
    return res.status(400).json({ error: 'Invalid jobId format' });
  }

  const job = getJob(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const cancelled = cancelJob(jobId);
  return res.json({
    message: 'Job cancellation requested',
    jobId,
    status: cancelled.status
  });
});

/**
 * GET /screenshots/:jobId/:file
 * Serve image with validated names and directory traversal protection.
 */
export async function serveScreenshot(req, res) {
  const { jobId, file } = req.params;

  if (!SAFE_ID_REGEX.test(jobId)) {
    return res.status(400).json({ error: 'Invalid jobId' });
  }
  if (!SAFE_FILENAME_REGEX.test(file)) {
    return res.status(400).json({ error: 'Invalid screenshot filename' });
  }

  const baseStorage = path.resolve(CONFIG.STORAGE_DIR, 'screenshots');
  const targetFile = path.resolve(baseStorage, jobId, file);

  if (!targetFile.startsWith(baseStorage)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    await fs.access(targetFile);
    return res.sendFile(targetFile);
  } catch {
    return res.status(404).json({ error: 'Screenshot not found' });
  }
}

export default router;
