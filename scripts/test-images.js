#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { crawl } from '../src/crawler.js';

const targetUrl = process.argv[2] || 'https://books.toscrape.com/';
const maxPages = parseInt(process.argv[3], 10) || 2;

console.log('=======================================================');
console.log(' DeepCrawl Image Extraction & Visualizer Test');
console.log(` Target URL: ${targetUrl}`);
console.log(` Max Pages:  ${maxPages}`);
console.log('=======================================================\n');

try {
  const result = await crawl(
    {
      url: targetUrl,
      maxDepth: 1,
      maxPages,
      concurrency: 2,
      maxScrolls: 5,
      screenshots: true,
      jobId: 'cli',
      storageDir: 'storage'
    },
    {
      onProgress: ({ pagesVisited, pending }) => {
        console.log(`[Progress] Visited: ${pagesVisited}, Pending: ${pending}`);
      }
    }
  );

  console.log('\n=======================================================');
  console.log(' Crawl Finished! Summary:');
  console.log(` Pages Visited: ${result.summary.pagesVisited}`);
  console.log(` Failed Pages:  ${result.summary.failed}`);
  console.log('=======================================================\n');

  // Build an HTML visualizer so the user can easily view images and screenshots
  let galleryHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>DeepCrawl Image Gallery</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 2rem; }
    h1 { margin-bottom: 0.5rem; color: #38bdf8; }
    .subtitle { color: #94a3b8; margin-bottom: 2rem; }
    .page-card { background: #1e293b; border-radius: 12px; padding: 1.5rem; margin-bottom: 2.5rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
    .page-title { font-size: 1.25rem; font-weight: bold; color: #f1f5f9; margin-bottom: 0.25rem; }
    .page-url { color: #38bdf8; word-break: break-all; text-decoration: none; font-size: 0.9rem; }
    .section-title { font-size: 1.1rem; color: #cbd5e1; margin-top: 1.5rem; margin-bottom: 1rem; border-bottom: 1px solid #334155; padding-bottom: 0.5rem; }
    .screenshot-box img { max-width: 100%; max-height: 400px; border-radius: 8px; border: 1px solid #475569; object-fit: cover; }
    .images-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 1rem; }
    .img-item { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 0.75rem; display: flex; flex-direction: column; align-items: center; }
    .img-item img { max-width: 100%; height: 140px; object-fit: contain; border-radius: 4px; margin-bottom: 0.5rem; }
    .img-meta { font-size: 0.75rem; color: #94a3b8; text-align: center; word-break: break-word; width: 100%; }
    .badge { display: inline-block; background: #0284c7; color: white; padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.8rem; font-weight: bold; margin-left: 0.5rem; }
  </style>
</head>
<body>
  <h1>DeepCrawl Extracted Images Gallery</h1>
  <div class="subtitle">Target: <strong>${targetUrl}</strong> | Extracted at: ${new Date().toLocaleString()}</div>
`;

  let totalImagesFound = 0;

  for (const page of result.pages) {
    const images = page.images || [];
    totalImagesFound += images.length;
    const screenshotRelPath = page.screenshot ? path.join('..', 'storage', page.screenshot.replace(/^\//, '')) : '';

    console.log(`--- Page: ${page.url} ---`);
    console.log(`  Title:       ${page.title}`);
    console.log(`  Images:      ${images.length}`);
    console.log(`  Screenshot:  ${page.screenshot || 'None'}`);

    if (images.length > 0) {
      console.log('  Top 3 Images:');
      images.slice(0, 3).forEach((img, idx) => {
        console.log(`    ${idx + 1}. [${img.width}x${img.height}] ${img.src} (${img.alt || 'no alt'})`);
      });
    }
    console.log('');

    galleryHtml += `
  <div class="page-card">
    <div class="page-title">${page.title || 'Untitled Page'} <span class="badge">${images.length} images</span></div>
    <a class="page-url" href="${page.url}" target="_blank">${page.url}</a>

    ${screenshotRelPath ? `
    <div class="section-title">Full Page Screenshot</div>
    <div class="screenshot-box">
      <a href="${screenshotRelPath}" target="_blank">
        <img src="${screenshotRelPath}" alt="Page Screenshot" />
      </a>
    </div>` : ''}

    <div class="section-title">Extracted Page Images (${images.length})</div>
    <div class="images-grid">
      ${images.map(img => `
      <div class="img-item">
        <a href="${img.src}" target="_blank" title="${img.alt || ''}">
          <img src="${img.src}" alt="${img.alt || 'image'}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22><rect fill=%22%23334155%22 width=%22100%22 height=%22100%22/><text fill=%22%2394a3b8%22 x=%2250%%22 y=%2250%%22 text-anchor=%22middle%22 dy=%22.3em%22 font-size=%2212%22>Broken Link</text></svg>'" />
        </a>
        <div class="img-meta">
          <strong>${img.width || '?'} &times; ${img.height || '?'}</strong><br/>
          <span>${img.alt ? (img.alt.length > 30 ? img.alt.slice(0, 30) + '...' : img.alt) : '<em>No alt text</em>'}</span>
        </div>
      </div>
      `).join('')}
    </div>
  </div>`;
  }

  galleryHtml += `
</body>
</html>`;

  const galleryPath = path.resolve('output', 'gallery.html');
  await fs.writeFile(galleryPath, galleryHtml, 'utf8');

  console.log('=======================================================');
  console.log(` Total Images Extracted: ${totalImagesFound}`);
  console.log(` Visual Gallery Saved:   ${galleryPath}`);
  console.log(' Open output/gallery.html in your browser to view all images and screenshots!');
  console.log('=======================================================');
} catch (err) {
  console.error('Test run failed:', err);
  process.exit(1);
}
