import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { crawl } from './crawler.js';
import { CONFIG } from './config.js';

const jobs = new Map();
const pendingQueue = [];
const MAX_CONCURRENT = 2;
let activeCount = 0;

/**
 * Periodically cleans up expired finished jobs (TTL) and enforces max in-memory limit.
 */
export async function cleanupExpiredJobs() {
  const ttlMs = (CONFIG.JOB_TTL_MINUTES || 60) * 60 * 1000;
  const now = Date.now();

  // 1. Evict by TTL
  for (const [jobId, job] of jobs.entries()) {
    if (job.finishedAt) {
      const age = now - new Date(job.finishedAt).getTime();
      if (age >= ttlMs) {
        await deleteJobScreenshots(jobId);
        jobs.delete(jobId);
      }
    }
  }

  // 2. Evict oldest finished jobs if over capacity (max 100)
  if (jobs.size > CONFIG.MAX_JOBS_IN_MEMORY) {
    const finishedJobs = [];
    for (const job of jobs.values()) {
      if (job.finishedAt && (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')) {
        finishedJobs.push(job);
      }
    }
    finishedJobs.sort((a, b) => new Date(a.finishedAt).getTime() - new Date(b.finishedAt).getTime());

    while (jobs.size > CONFIG.MAX_JOBS_IN_MEMORY && finishedJobs.length > 0) {
      const oldest = finishedJobs.shift();
      await deleteJobScreenshots(oldest.jobId);
      jobs.delete(oldest.jobId);
    }
  }
}

async function deleteJobScreenshots(jobId) {
  try {
    const jobScreenshotsDir = path.resolve(CONFIG.STORAGE_DIR, 'screenshots', jobId);
    await fs.rm(jobScreenshotsDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// Background cleanup timer every 30s
setInterval(cleanupExpiredJobs, 30 * 1000).unref();

/**
 * Creates and queues a new crawl job.
 */
export function createJob(options) {
  cleanupExpiredJobs().catch(() => {});

  const jobId = crypto.randomBytes(8).toString('hex');
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : CONFIG.HARD_JOB_TIMEOUT_MS;

  const job = {
    jobId,
    options: {
      url: options.url,
      maxDepth: options.maxDepth,
      maxPages: options.maxPages,
      concurrency: options.concurrency,
      maxScrolls: options.maxScrolls,
      useSitemap: options.useSitemap !== false,
      useLLM: options.useLLM === true,
      screenshots: options.screenshots !== false,
      scrollPage: options.scrollPage !== false,
      navigationTimeoutMs: options.navigationTimeoutMs || 30000
    },
    status: 'queued', // queued | running | completed | failed | cancelled
    stopReason: null,
    partial: false,
    pagesVisited: 0,
    pending: 0,
    failed: 0,
    errors: [],
    startedAt: null,
    finishedAt: null,
    result: null,
    timeoutMs,
    timeoutId: null,
    abortController: new AbortController()
  };

  jobs.set(jobId, job);
  pendingQueue.push(job);

  processQueue();

  return job;
}

/**
 * Retrieves a job by ID.
 */
export function getJob(jobId) {
  cleanupExpiredJobs().catch(() => {});
  return jobs.get(jobId) || null;
}

/**
 * Cancels a running or queued job.
 */
export function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;

  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return job;
  }

  if (job.status === 'queued') {
    const idx = pendingQueue.indexOf(job);
    if (idx !== -1) {
      pendingQueue.splice(idx, 1);
    }
    job.status = 'cancelled';
    job.stopReason = 'cancelled';
    job.partial = true;
    job.finishedAt = new Date().toISOString();
    return job;
  }

  if (job.status === 'running') {
    job.status = 'cancelled';
    job.stopReason = 'cancelled';
    job.partial = true;
    job.errors.push('Job cancelled by user');
    job.abortController.abort('cancelled');
    return job;
  }

  return job;
}

/**
 * Processes the next job in the queue if capacity is available.
 */
function processQueue() {
  if (activeCount >= MAX_CONCURRENT || pendingQueue.length === 0) {
    return;
  }

  const job = pendingQueue.shift();
  if (!job || job.status === 'cancelled') {
    return processQueue();
  }

  activeCount++;
  job.status = 'running';
  job.startedAt = new Date().toISOString();

  // Hard job timeout
  job.timeoutId = setTimeout(() => {
    if (job.status === 'running') {
      job.errors.push('Job hard timeout reached');
      job.abortController.abort('timeout');
    }
  }, job.timeoutMs);

  (async () => {
    try {
      const result = await crawl(
        {
          ...job.options,
          jobId: job.jobId,
          storageDir: CONFIG.STORAGE_DIR
        },
        {
          signal: job.abortController.signal,
          onProgress: ({ pagesVisited, pending, failed }) => {
            job.pagesVisited = pagesVisited;
            job.pending = pending;
            job.failed = failed;
          }
        }
      );

      job.result = result;
      job.pagesVisited = result.summary.pagesVisited;
      job.failed = result.summary.failed;
      job.stopReason = result.stopReason;
      job.partial = result.partial;

      // Merge errors including blocked requests and robots.txt skips
      if (result.errors && Array.isArray(result.errors)) {
        for (const e of result.errors) {
          if (!job.errors.includes(e)) {
            job.errors.push(e);
          }
        }
      }

      if (job.status !== 'cancelled') {
        job.status = 'completed';
      }
    } catch (err) {
      job.errors.push(err.message);
      job.stopReason = 'error';
      job.partial = true;
      if (job.status !== 'cancelled') {
        job.status = 'failed';
      }
    } finally {
      if (job.timeoutId) {
        clearTimeout(job.timeoutId);
      }
      job.finishedAt = new Date().toISOString();
      activeCount--;
      processQueue();
    }
  })();
}

/**
 * Clean snapshot for status endpoints.
 */
export function getJobStatusResponse(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    status: job.status,
    stopReason: job.stopReason || job.result?.stopReason || null,
    partial: job.partial || job.result?.partial || false,
    pagesVisited: job.pagesVisited,
    pending: job.pending,
    failed: job.failed,
    errors: job.errors,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  };
}

// For unit tests
export function getAllJobs() {
  return jobs;
}
