import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { crawl } from '../src/crawler.js';

/**
 * Downloads a remote image URL to disk safely
 */
async function downloadFile(url, destPath) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return false;
    const stream = createWriteStream(destPath);
    await finished(Readable.fromWeb(res.body).pipe(stream));
    return true;
  } catch {
    return false;
  }
}

/**
 * Crawls a URL and saves images, screenshots, and result.json into the `assets/` directory.
 *
 * @param {string} targetUrl - URL to crawl
 * @param {object} options - Crawl options (maxPages, maxDepth, etc.)
 */
export async function crawlAndStoreAssets(targetUrl, options = {}) {
  const assetsDir = path.resolve(options.outputDir || 'assets');
  const imagesDir = path.join(assetsDir, 'images');
  const screenshotsDir = path.join(assetsDir, 'screenshots');

  // 1. Ensure folders exist
  await fs.mkdir(imagesDir, { recursive: true });
  await fs.mkdir(screenshotsDir, { recursive: true });

  console.log(`\n[DeepCrawl] Starting crawl on: ${targetUrl}`);
  console.log(`[DeepCrawl] Storing output in:   ${assetsDir}\n`);

  // 2. Run crawl
  const result = await crawl(
    {
      url: targetUrl,
      maxDepth: options.maxDepth ?? 1,
      maxPages: options.maxPages ?? 2,
      concurrency: options.concurrency ?? 2,
      screenshots: true,
      jobId: 'assets_job',
      storageDir: 'storage'
    },
    {
      onProgress: ({ pagesVisited }) => {
        console.log(`  -> Crawled ${pagesVisited} page(s)...`);
      }
    }
  );

  // 3. Save raw result JSON
  const jsonPath = path.join(assetsDir, 'result.json');
  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n[Assets] Saved result metadata to: ${jsonPath}`);

  // 4. Download extracted images
  let downloadedImagesCount = 0;
  console.log('[Assets] Downloading page images...');

  for (const page of result.pages) {
    for (let i = 0; i < (page.images || []).length; i++) {
      const img = page.images[i];
      if (!img.src || !img.src.startsWith('http')) continue;

      // Extract filename from URL or create a clean name
      const urlObj = new URL(img.src);
      let baseName = path.basename(urlObj.pathname);
      if (!baseName || !baseName.includes('.')) {
        baseName = `img_${downloadedImagesCount + 1}.jpg`;
      }
      const safeName = `${String(downloadedImagesCount + 1).padStart(3, '0')}_${baseName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const destFile = path.join(imagesDir, safeName);

      const success = await downloadFile(img.src, destFile);
      if (success) {
        downloadedImagesCount++;
        // Update local reference in result if desired
        img.localPath = path.relative(assetsDir, destFile);
      }
    }
  }

  // 5. Copy full-page screenshots into assets/screenshots/
  let screenshotCount = 0;
  for (const page of result.pages) {
    if (page.screenshot) {
      const srcScreenshotPath = path.resolve('storage', page.screenshot.replace(/^\//, ''));
      const destScreenshotName = path.basename(srcScreenshotPath);
      const destScreenshotPath = path.join(screenshotsDir, destScreenshotName);

      try {
        await fs.copyFile(srcScreenshotPath, destScreenshotPath);
        screenshotCount++;
        page.localScreenshotPath = path.relative(assetsDir, destScreenshotPath);
      } catch {
        // Screenshot file may not exist if navigation failed
      }
    }
  }

  // Update result.json with the local file paths
  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2), 'utf8');

  console.log('\n=======================================================');
  console.log(' Assets Download Complete:');
  console.log(`  - Output Folder:  ${assetsDir}`);
  console.log(`  - Metadata JSON:  ${jsonPath}`);
  console.log(`  - Images Saved:   ${downloadedImagesCount} in assets/images/`);
  console.log(`  - Screenshots:    ${screenshotCount} in assets/screenshots/`);
  console.log('=======================================================\n');

  return {
    assetsDir,
    imagesDir,
    screenshotsDir,
    imagesCount: downloadedImagesCount,
    screenshotCount,
    result
  };
}

// Allow running directly from command line: node scripts/save-assets.js <url>
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/save-assets.js')) {
  const urlArg = process.argv[2] || 'https://books.toscrape.com/';
  const pagesArg = parseInt(process.argv[3], 10) || 1;
  crawlAndStoreAssets(urlArg, { maxPages: pagesArg });
}
