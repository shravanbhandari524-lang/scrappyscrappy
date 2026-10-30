import { chromium } from 'playwright';
import {
  normalizeUrl,
  isSafeUrlAsync,
  isAllowedByRobotsTxt
} from './urlGuard.js';
import { scrollPage, extractPageData, captureScreenshot } from './extract.js';

/**
 * Reconstructs the crawl hierarchy into a tree rooted at startUrl.
 */
export function buildTree(pages, startUrl) {
  if (!pages || pages.length === 0) {
    return { url: startUrl, children: [] };
  }

  const rootUrl = pages[0].url;
  const root = { url: rootUrl, children: [] };
  const nodeMap = new Map();
  nodeMap.set(rootUrl, root);

  for (let i = 1; i < pages.length; i++) {
    const page = pages[i];
    const node = { url: page.url, children: [] };
    nodeMap.set(page.url, node);

    const parentNode = page.parentUrl ? nodeMap.get(page.parentUrl) : null;
    if (parentNode) {
      parentNode.children.push(node);
    } else {
      root.children.push(node);
    }
  }

  return root;
}

/**
 * Core reusable crawl function.
 * 
 * @param {Object} options
 * @param {string} options.url - Start URL (also accepts options.startUrl)
 * @param {number} [options.maxDepth=3] - Maximum BFS depth
 * @param {number} [options.maxPages=30] - Maximum pages to crawl
 * @param {boolean} [options.screenshots=true] - Whether to capture screenshots
 * @param {boolean} [options.scrollPage=true] - Whether to auto-scroll for lazy-loading
 * @param {string} [options.jobId='cli'] - Identifier for the job
 * @param {string} [options.storageDir='storage'] - Base storage directory
 * @param {number} [options.navigationTimeoutMs=30000] - Navigation timeout
 * @param {Object} [callbacks]
 * @param {Function} [callbacks.onProgress] - Progress callback ({ pagesVisited, pending, failed, currentUrl, depth })
 * @param {AbortSignal} [callbacks.signal] - Cancellation/timeout signal
 */
export async function crawl(options = {}, { onProgress, signal } = {}) {
  const startRaw = options.url || options.startUrl;
  if (!startRaw) {
    throw new Error('Start URL is required');
  }

  const normalizedStart = normalizeUrl(startRaw);
  if (!normalizedStart) {
    throw new Error(`Invalid start URL: "${startRaw}"`);
  }

  const startCheck = await isSafeUrlAsync(normalizedStart);
  if (!startCheck.safe) {
    throw new Error(`Cannot crawl URL: ${startCheck.reason}`);
  }

  const maxDepth = typeof options.maxDepth === 'number' ? Math.max(0, options.maxDepth) : 3;
  const maxPages = typeof options.maxPages === 'number' ? Math.max(1, options.maxPages) : 30;
  const enableScreenshots = options.screenshots !== false;
  const enableScroll = options.scrollPage !== false;
  const jobId = options.jobId || 'cli';
  const storageDir = options.storageDir || 'storage';
  const navTimeout = options.navigationTimeoutMs || 30000;

  let browser = null;
  let context = null;

  async function setupBrowserContext() {
    if (context) {
      try { await context.close(); } catch {}
    }
    if (browser) {
      try { await browser.close(); } catch {}
    }

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 deepcrawl/1.0'
    });

    // Revalidate every request and redirect with route interception
    await context.route('**/*', async (route) => {
      try {
        const reqUrl = route.request().url();
        if (!reqUrl.startsWith('http://') && !reqUrl.startsWith('https://')) {
          return route.abort('blockedbyclient');
        }
        const safe = await isSafeUrlAsync(reqUrl);
        if (!safe.safe) {
          return route.abort('blockedbyclient');
        }
        return route.continue();
      } catch {
        return route.abort('blockedbyclient');
      }
    });
  }

  await setupBrowserContext();

  const queue = [{ url: normalizedStart, depth: 0, parentUrl: null }];
  const queuedUrls = new Set([normalizedStart]);
  const pages = [];
  let failedCount = 0;
  let maxDepthReached = 0;

  try {
    while (queue.length > 0 && pages.length < maxPages) {
      if (signal?.aborted) {
        break;
      }

      const current = queue.shift();
      maxDepthReached = Math.max(maxDepthReached, current.depth);

      const pageErrors = [];
      let finalUrl = current.url;
      let statusCode = null;
      let title = '';
      let description = '';
      let headings = { h1: [], h2: [], h3: [] };
      let text = '';
      let links = { internal: [], external: [] };
      let screenshot = null;

      // 1. SSRF check before requesting
      const safetyCheck = await isSafeUrlAsync(current.url);
      if (!safetyCheck.safe) {
        pageErrors.push(safetyCheck.reason);
        failedCount++;
        pages.push({
          url: current.url,
          finalUrl,
          statusCode,
          title,
          description,
          headings,
          text,
          links,
          depth: current.depth,
          parentUrl: current.parentUrl,
          screenshot,
          errors: pageErrors
        });
        onProgress?.({
          pagesVisited: pages.length,
          pending: queue.length,
          failed: failedCount,
          currentUrl: current.url,
          depth: current.depth
        });
        continue;
      }

      // 2. Robots.txt check
      const robotsAllowed = await isAllowedByRobotsTxt(current.url);
      if (!robotsAllowed) {
        pageErrors.push('Disallowed by robots.txt');
        failedCount++;
        pages.push({
          url: current.url,
          finalUrl,
          statusCode,
          title,
          description,
          headings,
          text,
          links,
          depth: current.depth,
          parentUrl: current.parentUrl,
          screenshot,
          errors: pageErrors
        });
        onProgress?.({
          pagesVisited: pages.length,
          pending: queue.length,
          failed: failedCount,
          currentUrl: current.url,
          depth: current.depth
        });
        continue;
      }

      let page = null;
      try {
        if (!browser || !browser.isConnected() || !context) {
          await setupBrowserContext();
        }
        page = await context.newPage();
      } catch (launchErr) {
        pageErrors.push(`Browser launch/context error: ${launchErr.message}`);
        await setupBrowserContext().catch(() => {});
      }

      if (page) {
        try {
          const response = await page.goto(current.url, {
            waitUntil: 'domcontentloaded',
            timeout: navTimeout
          });

          // Wait briefly for network activity to settle or load state
          await page.waitForLoadState('networkidle', { timeout: 1200 }).catch(() => {});

          finalUrl = normalizeUrl(page.url()) || page.url();
          statusCode = response ? response.status() : null;

          if (statusCode && statusCode >= 400) {
            pageErrors.push(`HTTP status ${statusCode}`);
          }

          // Check if redirect ended at an unsafe URL
          const finalSafety = await isSafeUrlAsync(finalUrl);
          if (!finalSafety.safe) {
            pageErrors.push(`Redirected to unsafe URL: ${finalSafety.reason}`);
          } else {
            // Scroll to trigger lazy loading if enabled
            if (enableScroll) {
              await scrollPage(page, 10, 200);
            }

            // Extract page data
            try {
              const extracted = await extractPageData(page, finalUrl, normalizedStart);
              title = extracted.title;
              description = extracted.description;
              headings = extracted.headings;
              text = extracted.text;
              links = extracted.links;
            } catch (extErr) {
              pageErrors.push(`Extraction failed: ${extErr.message}`);
            }

            // Capture screenshot if enabled
            if (enableScreenshots) {
              try {
                screenshot = await captureScreenshot(page, finalUrl, pages.length + 1, jobId, storageDir);
              } catch (shotErr) {
                pageErrors.push(`Screenshot failed: ${shotErr.message}`);
              }
            }

            // Queue internal links
            if (current.depth < maxDepth && !signal?.aborted) {
              for (const nextUrl of links.internal) {
                if (!queuedUrls.has(nextUrl)) {
                  queuedUrls.add(nextUrl);
                  queue.push({
                    url: nextUrl,
                    depth: current.depth + 1,
                    parentUrl: current.url
                  });
                }
              }
            }
          }
        } catch (navErr) {
          pageErrors.push(navErr.message);
          // If browser disconnected or crashed, reset it
          if (!browser.isConnected()) {
            await setupBrowserContext().catch(() => {});
          }
        } finally {
          try {
            await page.close();
          } catch {}
        }
      }

      if (pageErrors.length > 0) {
        failedCount++;
      }

      pages.push({
        url: current.url,
        finalUrl,
        statusCode,
        title,
        description,
        headings,
        text,
        links,
        depth: current.depth,
        parentUrl: current.parentUrl,
        screenshot,
        errors: pageErrors
      });

      onProgress?.({
        pagesVisited: pages.length,
        pending: queue.length,
        failed: failedCount,
        currentUrl: current.url,
        depth: current.depth
      });
    }
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }

  const tree = buildTree(pages, normalizedStart);

  return {
    startUrl: normalizedStart,
    summary: {
      pagesVisited: pages.length,
      failed: failedCount,
      maxDepthReached
    },
    pages,
    tree
  };
}

// Backwards-compatible alias
export const runCrawler = crawl;
