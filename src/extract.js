import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeUrl, isSameDomain, shouldSkipUrl, sanitizeFilename } from './urlUtils.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scrolls the page incrementally until height stops growing or maxScrolls is reached.
 */
export async function scrollPage(page, maxScrolls = 10, delayMs = 200) {
  try {
    let lastHeight = 0;
    for (let i = 0; i < maxScrolls; i++) {
      const currentHeight = await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight || 800);
        return document.documentElement.scrollHeight || document.body.scrollHeight;
      });
      await sleep(delayMs);
      if (currentHeight === lastHeight) {
        break; // Height stopped growing
      }
      lastHeight = currentHeight;
    }
  } catch {
    // Best effort, ignore if page closed or frame detached
  }
}

/**
 * Extracts page title, meta description, headings, visible content text, links,
 * page images (up to 100), and visible forms for potential LLM interaction.
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

    // Extract links and detect pagination
    const rawLinks = Array.from(document.querySelectorAll('a[href]')).map((a) => {
      const href = a.getAttribute('href') || '';
      const rel = (a.getAttribute('rel') || '').toLowerCase();
      const rawText = (a.textContent || '').trim().toLowerCase();
      const ariaLabel = (a.getAttribute('aria-label') || '').toLowerCase();

      const isRelNext = rel.split(/\s+/).includes('next');
      const isNextText =
        rawText === 'next' ||
        rawText === '>' ||
        rawText === '»' ||
        rawText === '›' ||
        rawText === 'next page' ||
        ariaLabel.includes('next');
      const isPageNum = /^\d+$/.test(rawText);

      return {
        href,
        isPagination: isRelNext || isNextText || isPageNum
      };
    }).filter((item) => item.href.trim().length > 0);

    // Extract images (including og:image)
    const rawImages = [];
    const ogImg = document.querySelector('meta[property="og:image"]');
    if (ogImg && ogImg.getAttribute('content')) {
      rawImages.push({
        src: ogImg.getAttribute('content').trim(),
        alt: 'og:image',
        width: null,
        height: null
      });
    }

    const imgEls = Array.from(document.querySelectorAll('img'));
    for (const img of imgEls) {
      const src = img.currentSrc || img.getAttribute('src') || '';
      if (!src) continue;
      const alt = (img.getAttribute('alt') || '').trim();
      const width = img.naturalWidth || parseInt(img.getAttribute('width'), 10) || null;
      const height = img.naturalHeight || parseInt(img.getAttribute('height'), 10) || null;
      rawImages.push({ src: src.trim(), alt, width, height });
    }

    // Extract visible forms
    const rawForms = [];
    const formEls = Array.from(document.querySelectorAll('form'));
    formEls.forEach((form, idx) => {
      const style = window.getComputedStyle(form);
      if (style.display === 'none' || style.visibility === 'hidden') return;

      const selector = form.id
        ? `#${form.id}`
        : (form.name ? `form[name="${form.name}"]` : `form:nth-of-type(${idx + 1})`);
      const method = (form.getAttribute('method') || 'GET').toUpperCase();
      const action = form.getAttribute('action') || '';

      const fields = [];
      const inputEls = Array.from(form.querySelectorAll('input, select, textarea'));
      for (const el of inputEls) {
        const tag = el.tagName.toLowerCase();
        let type = (el.getAttribute('type') || (tag === 'textarea' ? 'textarea' : (tag === 'select' ? 'select' : 'text'))).toLowerCase();
        if (type === 'hidden') continue;

        const name = el.getAttribute('name') || el.id || '';
        if (!name) continue;

        const placeholder = el.getAttribute('placeholder') || '';
        const required = el.hasAttribute('required');

        let label = '';
        if (el.id) {
          const lEl = document.querySelector(`label[for="${el.id}"]`);
          if (lEl) label = lEl.textContent.trim();
        }
        if (!label) {
          const parentL = el.closest('label');
          if (parentL) label = parentL.textContent.replace(el.textContent, '').trim();
        }
        if (!label && el.getAttribute('aria-label')) {
          label = el.getAttribute('aria-label');
        }

        let options = undefined;
        if (tag === 'select') {
          options = Array.from(el.querySelectorAll('option'))
            .map((o) => (o.value || o.textContent).trim())
            .filter(Boolean);
        }

        fields.push({
          name,
          type,
          label,
          placeholder,
          options,
          required
        });
      }

      if (fields.length > 0) {
        rawForms.push({
          selector,
          method,
          action,
          fields
        });
      }
    });

    return { title, description: description.trim(), headings, text, rawLinks, rawImages, rawForms };
  });

  const internalSet = new Set();
  const externalSet = new Set();
  const paginationSet = new Set();

  for (const item of evaluated.rawLinks) {
    const normalized = normalizeUrl(item.href, currentUrl);
    if (!normalized) continue;
    if (shouldSkipUrl(normalized)) continue;

    if (isSameDomain(normalized, startUrl)) {
      internalSet.add(normalized);
      if (item.isPagination) {
        paginationSet.add(normalized);
      }
    } else {
      externalSet.add(normalized);
    }
  }

  // Dedupe and filter images (cap at 100, skip data URIs > 200 chars)
  const images = [];
  const seenImageSrcs = new Set();

  for (const img of evaluated.rawImages) {
    if (images.length >= 100) break;

    let resolvedSrc = null;
    if (img.src.startsWith('data:')) {
      if (img.src.length > 200) continue;
      resolvedSrc = img.src;
    } else {
      try {
        resolvedSrc = new URL(img.src, currentUrl).href;
      } catch {
        continue;
      }
    }

    if (seenImageSrcs.has(resolvedSrc)) continue;
    seenImageSrcs.add(resolvedSrc);

    images.push({
      src: resolvedSrc,
      alt: img.alt || '',
      width: typeof img.width === 'number' && !Number.isNaN(img.width) ? img.width : null,
      height: typeof img.height === 'number' && !Number.isNaN(img.height) ? img.height : null
    });
  }

  return {
    title: evaluated.title,
    description: evaluated.description,
    headings: evaluated.headings,
    text: evaluated.text,
    links: {
      internal: Array.from(internalSet),
      external: Array.from(externalSet)
    },
    images,
    forms: evaluated.rawForms,
    paginationLinks: paginationSet
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
