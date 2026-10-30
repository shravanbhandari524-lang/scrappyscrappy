import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeUrl, isSameDomain, shouldSkipUrl, sanitizeFilename } from './urlUtils.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scrolls the page down incrementally to trigger lazy loading (capped at maxScrolls).
 */
export async function scrollPage(page, maxScrolls = 10, delayMs = 200) {
  try {
    for (let i = 0; i < maxScrolls; i++) {
      const reachedBottom = await page.evaluate(() => {
        const doc = document.documentElement;
        const atBottom = window.innerHeight + window.scrollY >= (doc.scrollHeight || document.body.scrollHeight) - 10;
        window.scrollBy(0, window.innerHeight || 800);
        return atBottom;
      });
      await sleep(delayMs);
      if (reachedBottom) break;
    }
  } catch {
    // Best effort, ignore if page closed or frame detached
  }
}

/**
 * Extracts page title, meta description, headings, visible content text, and links.
 */
export async function extractPageData(page, currentUrl, startUrl) {
  const evaluated = await page.evaluate(() => {
    const title = (document.title || '').trim();

    const descMeta =
      document.querySelector('meta[name="description"]') ||
      document.querySelector('meta[property="og:description"]');
    const description = (descMeta ? descMeta.getAttribute('content') : '') || '';

    const getTexts = (selector) =>
      Array.from(document.querySelectorAll(selector))
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t.length > 0);

    const headings = {
      h1: getTexts('h1'),
      h2: getTexts('h2'),
      h3: getTexts('h3')
    };

    // Extract cleaned visible text from main content (capped at 20,000 chars)
    let contentRoot = document.querySelector('main') || document.querySelector('article') || document.body;
    let text = '';
    if (contentRoot) {
      const clone = contentRoot.cloneNode(true);
      const elementsToRemove = clone.querySelectorAll('script, style, noscript, svg, canvas, nav, header, footer');
      elementsToRemove.forEach((el) => el.remove());
      text = (clone.innerText || clone.textContent || '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n/g, '\n')
        .trim();
    }
    if (text.length > 20000) {
      text = text.slice(0, 20000);
    }

    const rawHrefs = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.getAttribute('href') || '')
      .filter((href) => href.trim().length > 0);

    return { title, description: description.trim(), headings, text, rawHrefs };
  });

  const internalSet = new Set();
  const externalSet = new Set();

  for (const rawHref of evaluated.rawHrefs) {
    const normalized = normalizeUrl(rawHref, currentUrl);
    if (!normalized) continue;
    if (shouldSkipUrl(normalized)) continue;

    if (isSameDomain(normalized, startUrl)) {
      internalSet.add(normalized);
    } else {
      externalSet.add(normalized);
    }
  }

  return {
    title: evaluated.title,
    description: evaluated.description,
    headings: evaluated.headings,
    text: evaluated.text,
    links: {
      internal: Array.from(internalSet),
      external: Array.from(externalSet)
    }
  };
}

/**
 * Captures full-page screenshot and saves it to storage/screenshots/<jobId>/<file>.png.
 * Returns URL path /screenshots/<jobId>/<file>.png.
 */
export async function captureScreenshot(page, url, pageIndex, jobId = 'cli', storageDir = 'storage') {
  const screenshotsDir = path.join(storageDir, 'screenshots', jobId);
  await fs.mkdir(screenshotsDir, { recursive: true });

  const filename = sanitizeFilename(url, pageIndex);
  const diskPath = path.resolve(path.join(screenshotsDir, filename));

  await page.screenshot({ path: diskPath, fullPage: true });
  return `/screenshots/${jobId}/${filename}`;
}
