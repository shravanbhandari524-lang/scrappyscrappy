import crypto from 'node:crypto';
import { crawl } from './crawler.js';

const jobs = new Map();
const pendingQueue = [];
const MAX_CONCURRENT = 2;
let activeCount = 0;

/**
 * Creates and queues a new crawl job.
 */
export function createJob(options) {
  const jobId = crypto.randomBytes(8).toString('hex');
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 10 * 60 * 1000;

  const job = {
    jobId,
    options: {
      url: options.url,
      maxDepth: options.maxDepth,
      maxPages: options.maxPages,
      screenshots: options.screenshots !== false,
      scrollPage: options.scrollPage !== false,
      navigationTimeoutMs: options.navigationTimeoutMs || 30000
    },
    status: 'queued', // queued | running | completed | failed | cancelled
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
    job.finishedAt = new Date().toISOString();
    return job;
  }

  if (job.status === 'running') {
    job.status = 'cancelled';
    job.errors.push('Job cancelled by user');
    job.abortController.abort();
    // crawl() will abort and populate partial results in its finally block
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
      job.errors.push('Job hard timeout reached (10 min)');
      job.abortController.abort();
    }
  }, job.timeoutMs);

  (async () => {
    try {
      const result = await crawl(
        {
          ...job.options,
          jobId: job.jobId,
          storageDir: 'storage'
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

      if (job.status !== 'cancelled') {
        job.status = 'completed';
      }
    } catch (err) {
      job.errors.push(err.message);
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
    pagesVisited: job.pagesVisited,
    pending: job.pending,
    failed: job.failed,
    errors: job.errors,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  };
}
