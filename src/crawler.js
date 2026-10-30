import { chromium } from 'playwright';
import {
  normalizeUrl,
  isSafeUrlAsync,
  isAllowedByRobotsTxt,
  isCrawlTrap,
  discoverSitemapUrls
} from './urlGuard.js';
import { scrollPage, extractPageData, captureScreenshot } from './extract.js';
import { planFormSubmissions, isFormSafe } from './llm.js';
import { CONFIG } from './config.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  const useLLM = options.useLLM === true;
  if (useLLM) {
    const hasKey = Boolean(process.env.OPENAI_API_KEY || CONFIG.OPENAI_API_KEY);
    const hasBase = Boolean(process.env.OPENAI_BASE_URL || CONFIG.OPENAI_BASE_URL);
    const isMock = process.env.LLM_MOCK === '1';
    if (!hasKey && !hasBase && !isMock) {
      throw new Error('OPENAI_API_KEY or OPENAI_BASE_URL must be configured when useLLM is enabled');
    }
  }

  const maxDepth = typeof options.maxDepth === 'number' ? Math.max(0, options.maxDepth) : 3;
  const maxPages = typeof options.maxPages === 'number' ? Math.max(1, options.maxPages) : 30;
  const concurrency = Math.min(5, Math.max(1, typeof options.concurrency === 'number' ? options.concurrency : 3));
  const maxScrolls = typeof options.maxScrolls === 'number' ? Math.max(0, options.maxScrolls) : 10;
  const enableScreenshots = options.screenshots !== false;
  const enableScroll = options.scrollPage !== false;
  const useSitemap = options.useSitemap !== false;
  const jobId = options.jobId || 'cli';
  const storageDir = options.storageDir || 'storage';
  const navTimeout = options.navigationTimeoutMs || 30000;
  const llmMaxCalls = typeof options.llmMaxCalls === 'number' ? options.llmMaxCalls : CONFIG.LLM_MAX_CALLS;
  const llmMaxSubmitsPerPage = typeof options.llmMaxSubmitsPerPage === 'number' ? options.llmMaxSubmitsPerPage : CONFIG.LLM_MAX_SUBMITS_PER_PAGE;

  let browser = null;
  let context = null;

  const jobErrors = [];
  let blockedRequestsCount = 0;
  let llmCallsCount = 0;
  let llmSubmitsCount = 0;

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

    // Revalidate every sub-request and redirect
    await context.route('**/*', async (route) => {
      try {
        const reqUrl = route.request().url();
        if (!reqUrl.startsWith('http://') && !reqUrl.startsWith('https://')) {
          blockedRequestsCount++;
          jobErrors.push(`Blocked request: ${reqUrl} (Disallowed protocol)`);
          return route.abort('blockedbyclient');
        }
        const safe = await isSafeUrlAsync(reqUrl);
        if (!safe.safe) {
          blockedRequestsCount++;
          jobErrors.push(`Blocked request: ${reqUrl} (${safe.reason})`);
          return route.abort('blockedbyclient');
        }
        return route.continue();
      } catch {
        blockedRequestsCount++;
        return route.abort('blockedbyclient');
      }
    });
  }

  await setupBrowserContext();

  const patternCounts = new Map();
  const queue = [{ url: normalizedStart, depth: 0, parentUrl: null, isPagination: false }];
  const enqueuedUrls = new Set([normalizedStart]);

  const initPatternCheck = isCrawlTrap(normalizedStart, patternCounts, 50);
  if (!initPatternCheck.trap && initPatternCheck.pattern) {
    patternCounts.set(initPatternCheck.pattern, 1);
  }

  // Sitemap seeding
  if (useSitemap) {
    try {
      const sitemapUrls = await discoverSitemapUrls(normalizedStart, 500);
      for (const sUrl of sitemapUrls) {
        if (!enqueuedUrls.has(sUrl)) {
          const trapCheck = isCrawlTrap(sUrl, patternCounts, 50);
          if (!trapCheck.trap && trapCheck.pattern) {
            patternCounts.set(trapCheck.pattern, (patternCounts.get(trapCheck.pattern) || 0) + 1);
            enqueuedUrls.add(sUrl);
            queue.push({
              url: sUrl,
              depth: 1,
              parentUrl: normalizedStart,
              isPagination: false
            });
          }
        }
      }
    } catch (smErr) {
      jobErrors.push(`Sitemap discovery error: ${smErr.message}`);
    }
  }

  const pages = [];
  let failedCount = 0;
  let maxDepthReached = 0;
  let stopReason = 'queueEmpty';
  let activeWorkers = 0;

  const wakeWaiters = [];
  function notifyWaiters() {
    while (wakeWaiters.length > 0) {
      const resolve = wakeWaiters.shift();
      resolve();
    }
  }

  function waitTurn() {
    return new Promise((resolve) => {
      wakeWaiters.push(resolve);
    });
  }

  async function processItem(current) {
    maxDepthReached = Math.max(maxDepthReached, current.depth);

    const pageErrors = [];
    const llmActions = [];
    let finalUrl = current.url;
    let statusCode = null;
    let title = '';
    let description = '';
    let headings = { h1: [], h2: [], h3: [] };
    let text = '';
    let images = [];
    let links = { internal: [], external: [] };
    let screenshot = null;

    // SSRF Check
    const safetyCheck = await isSafeUrlAsync(current.url);
    if (!safetyCheck.safe) {
      blockedRequestsCount++;
      const reasonMsg = `Blocked request: ${current.url} (${safetyCheck.reason})`;
      pageErrors.push(safetyCheck.reason);
      jobErrors.push(reasonMsg);
      failedCount++;
      pages.push({
        url: current.url,
        finalUrl,
        statusCode,
        title,
        description,
        headings,
        text,
        images,
        links,
        depth: current.depth,
        parentUrl: current.parentUrl,
        screenshot,
        errors: pageErrors,
        llmActions
      });
      onProgress?.({
        pagesVisited: pages.length,
        pending: queue.length,
        failed: failedCount,
        currentUrl: current.url,
        depth: current.depth
      });
      return;
    }

    // Robots.txt Check
    const robotsAllowed = await isAllowedByRobotsTxt(current.url);
    if (!robotsAllowed) {
      blockedRequestsCount++;
      const reasonMsg = `Robots.txt skip: ${current.url} (Disallowed by robots.txt)`;
      pageErrors.push('Disallowed by robots.txt');
      jobErrors.push(reasonMsg);
      failedCount++;
      pages.push({
        url: current.url,
        finalUrl,
        statusCode,
        title,
        description,
        headings,
        text,
        images,
        links,
        depth: current.depth,
        parentUrl: current.parentUrl,
        screenshot,
        errors: pageErrors,
        llmActions
      });
      onProgress?.({
        pagesVisited: pages.length,
        pending: queue.length,
        failed: failedCount,
        currentUrl: current.url,
        depth: current.depth
      });
      return;
    }

    let page = null;
    try {
      if (!browser || !browser.isConnected() || !context) {
        await setupBrowserContext();
      }
      page = await context.newPage();
    } catch (launchErr) {
      pageErrors.push(`Browser launch error: ${launchErr.message}`);
      await setupBrowserContext().catch(() => {});
    }

    if (page) {
      try {
        const response = await page.goto(current.url, {
          waitUntil: 'domcontentloaded',
          timeout: navTimeout
        });

        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

        finalUrl = normalizeUrl(page.url()) || page.url();
        statusCode = response ? response.status() : null;

        if (statusCode && statusCode >= 400) {
          pageErrors.push(`HTTP status ${statusCode}`);
        }

        const finalSafety = await isSafeUrlAsync(finalUrl);
        if (!finalSafety.safe) {
          blockedRequestsCount++;
          pageErrors.push(`Redirected to unsafe URL: ${finalSafety.reason}`);
          jobErrors.push(`Blocked request: ${finalUrl} (${finalSafety.reason})`);
        } else {
          // Scroll for lazy loading
          if (enableScroll) {
            await scrollPage(page, maxScrolls, 200);
          }

          // Extract DOM data
          let extracted = null;
          try {
            extracted = await extractPageData(page, finalUrl, normalizedStart);
            title = extracted.title;
            description = extracted.description;
            headings = extracted.headings;
            text = extracted.text;
            images = extracted.images;
            links = extracted.links;
          } catch (extErr) {
            pageErrors.push(`Extraction failed: ${extErr.message}`);
          }

          // Capture screenshot
          if (enableScreenshots) {
            try {
              screenshot = await captureScreenshot(page, finalUrl, pages.length + 1, jobId, storageDir);
            } catch (shotErr) {
              pageErrors.push(`Screenshot failed: ${shotErr.message}`);
            }
          }

          // Queue discovered internal links
          if (extracted && !signal?.aborted) {
            for (const nextUrl of links.internal) {
              if (enqueuedUrls.has(nextUrl)) continue;

              const isPagination = extracted.paginationLinks.has(nextUrl);
              const nextDepth = isPagination ? current.depth : current.depth + 1;

              if (nextDepth <= maxDepth) {
                const trapCheck = isCrawlTrap(nextUrl, patternCounts, 50);
                if (trapCheck.trap) {
                  jobErrors.push(`Crawl-trap skip: ${nextUrl} (${trapCheck.reason})`);
                  continue;
                }
                patternCounts.set(trapCheck.pattern, (patternCounts.get(trapCheck.pattern) || 0) + 1);
                enqueuedUrls.add(nextUrl);
                queue.push({
                  url: nextUrl,
                  depth: nextDepth,
                  parentUrl: current.url,
                  isPagination
                });
              }
            }
          }

          // LLM Form-Filling Step (if enabled and forms exist)
          if (useLLM && extracted?.forms?.length > 0 && llmCallsCount < llmMaxCalls && !signal?.aborted) {
            llmCallsCount++;
            try {
              const llmPlan = await planFormSubmissions({
                forms: extracted.forms,
                pageText: text,
                config: CONFIG
              });

              if (llmPlan.valid && Array.isArray(llmPlan.forms)) {
                let submitsThisPage = 0;
                for (const proposal of llmPlan.forms) {
                  const formDef = extracted.forms.find((f) => f.selector === proposal.selector);
                  if (!formDef) continue;

                  const safeCheck = isFormSafe(formDef);
                  if (!safeCheck.safe) {
                    llmActions.push({
                      formSelector: proposal.selector,
                      status: 'skipped',
                      reason: safeCheck.reason
                    });
                    continue;
                  }

                  if (!proposal.submit) {
                    llmActions.push({
                      formSelector: proposal.selector,
                      status: 'skipped',
                      reason: 'Model suggested not submitting'
                    });
                    continue;
                  }

                  if (submitsThisPage >= llmMaxSubmitsPerPage) {
                    llmActions.push({
                      formSelector: proposal.selector,
                      status: 'skipped',
                      reason: `Exceeded per-page submits limit (${llmMaxSubmitsPerPage})`
                    });
                    continue;
                  }

                  submitsThisPage++;
                  llmSubmitsCount++;

                  try {
                    // Fill form values
                    await page.evaluate(({ sel, vals }) => {
                      const form = document.querySelector(sel);
                      if (!form) return;
                      for (const [k, v] of Object.entries(vals)) {
                        const el = form.querySelector(`[name="${k}"], #${k}`);
                        if (el) {
                          el.value = v;
                          el.dispatchEvent(new Event('input', { bubbles: true }));
                          el.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                      }
                    }, { sel: proposal.selector, vals: proposal.values });

                    // Submit form
                    await Promise.all([
                      page.waitForURL((u) => u.href !== current.url, { timeout: 8000 }).catch(() => {}),
                      page.evaluate((sel) => {
                        const form = document.querySelector(sel);
                        const submitBtn = form?.querySelector('button[type="submit"], input[type="submit"]');
                        if (submitBtn) {
                          submitBtn.click();
                        } else if (form) {
                          form.submit();
                        }
                      }, proposal.selector).catch((e) => {
                        // Execution context destroyed indicates fast navigation
                        if (!e.message.includes('Execution context was destroyed')) {
                          throw e;
                        }
                      })
                    ]);

                    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});

                    const resultUrl = normalizeUrl(page.url()) || page.url();
                    const postSubmitSafety = await isSafeUrlAsync(resultUrl);

                    if (!postSubmitSafety.safe) {
                      blockedRequestsCount++;
                      jobErrors.push(`Blocked request after form submit: ${resultUrl} (${postSubmitSafety.reason})`);
                      llmActions.push({
                        formSelector: proposal.selector,
                        valuesUsed: proposal.values,
                        resultUrl,
                        status: 'blocked'
                      });
                    } else {
                      llmActions.push({
                        formSelector: proposal.selector,
                        valuesUsed: proposal.values,
                        resultUrl,
                        status: 'success'
                      });

                      // Extract resulting page as a child if new
                      if (!enqueuedUrls.has(resultUrl) && pages.length < maxPages && current.depth + 1 <= maxDepth) {
                        enqueuedUrls.add(resultUrl);
                        let childShot = null;
                        if (enableScreenshots) {
                          try {
                            childShot = await captureScreenshot(page, resultUrl, pages.length + 2, jobId, storageDir);
                          } catch {}
                        }
                        const childExtracted = await extractPageData(page, resultUrl, normalizedStart).catch(() => null);

                        pages.push({
                          url: resultUrl,
                          finalUrl: resultUrl,
                          statusCode: 200,
                          title: childExtracted?.title || '',
                          description: childExtracted?.description || '',
                          headings: childExtracted?.headings || { h1: [], h2: [], h3: [] },
                          text: childExtracted?.text || '',
                          images: childExtracted?.images || [],
                          links: childExtracted?.links || { internal: [], external: [] },
                          depth: current.depth + 1,
                          parentUrl: current.url,
                          screenshot: childShot,
                          errors: [],
                          llmActions: []
                        });
                      }
                    }
                  } catch (subErr) {
                    llmActions.push({
                      formSelector: proposal.selector,
                      valuesUsed: proposal.values,
                      status: 'error',
                      reason: subErr.message
                    });
                    pageErrors.push(`LLM submit error: ${subErr.message}`);
                  }
                }
              } else if (llmPlan.error) {
                pageErrors.push(`LLM error: ${llmPlan.error}`);
              }
            } catch (llmErr) {
              pageErrors.push(`LLM execution error: ${llmErr.message}`);
            }
          }
        }
      } catch (navErr) {
        pageErrors.push(navErr.message);
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
      images,
      links,
      depth: current.depth,
      parentUrl: current.parentUrl,
      screenshot,
      errors: pageErrors,
      llmActions
    });

    onProgress?.({
      pagesVisited: pages.length,
      pending: queue.length,
      failed: failedCount,
      currentUrl: current.url,
      depth: current.depth
    });
  }

  async function worker() {
    while (true) {
      if (signal?.aborted) {
        if (!stopReason || stopReason === 'queueEmpty') {
          stopReason = signal.reason === 'timeout' ? 'timeout' : 'cancelled';
        }
        break;
      }

      if (pages.length >= maxPages) {
        stopReason = 'maxPages';
        break;
      }

      // Check if starting another page would exceed maxPages
      if (pages.length + activeWorkers >= maxPages) {
        if (activeWorkers === 0) {
          stopReason = 'maxPages';
          break;
        }
        await Promise.race([waitTurn(), sleep(80)]);
        continue;
      }

      if (queue.length === 0) {
        if (activeWorkers === 0) {
          stopReason = 'queueEmpty';
          break;
        }
        await Promise.race([waitTurn(), sleep(80)]);
        continue;
      }

      const item = queue.shift();
      activeWorkers++;

      try {
        await processItem(item);
      } catch (err) {
        jobErrors.push(`Worker error: ${err.message}`);
      } finally {
        activeWorkers--;
        notifyWaiters();
      }
    }
  }

  try {
    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }

  if (signal?.aborted && (!stopReason || stopReason === 'queueEmpty')) {
    stopReason = signal.reason === 'timeout' ? 'timeout' : 'cancelled';
  }

  const partial = stopReason !== 'queueEmpty';
  const tree = buildTree(pages, normalizedStart);

  return {
    startUrl: normalizedStart,
    stopReason,
    partial,
    summary: {
      pagesVisited: pages.length,
      failed: failedCount,
      maxDepthReached,
      blockedRequests: blockedRequestsCount,
      llmCalls: llmCallsCount,
      llmSubmits: llmSubmitsCount
    },
    errors: jobErrors,
    pages,
    tree
  };
}

// Backwards-compatible alias
export const runCrawler = crawl;
