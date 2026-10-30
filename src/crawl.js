#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { crawl } from './crawler.js';

function parseCliArgs(argv) {
  const args = argv.slice(2);
  let url = null;
  let depth = 3;
  let maxPages = 30;
  let concurrency = 3;
  let maxScrolls = 10;
  let useSitemap = true;
  let useLLM = false;
  let makeZip = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--depth') {
      const next = args[++i];
      if (next !== undefined) depth = parseInt(next, 10);
    } else if (arg.startsWith('--depth=')) {
      depth = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--max-pages') {
      const next = args[++i];
      if (next !== undefined) maxPages = parseInt(next, 10);
    } else if (arg.startsWith('--max-pages=')) {
      maxPages = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--concurrency') {
      const next = args[++i];
      if (next !== undefined) concurrency = parseInt(next, 10);
    } else if (arg.startsWith('--concurrency=')) {
      concurrency = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--max-scrolls') {
      const next = args[++i];
      if (next !== undefined) maxScrolls = parseInt(next, 10);
    } else if (arg.startsWith('--max-scrolls=')) {
      maxScrolls = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--no-sitemap') {
      useSitemap = false;
    } else if (arg === '--llm') {
      useLLM = true;
    } else if (arg === '--zip') {
      makeZip = true;
    } else if (arg === '--help' || arg === '-h') {
      return { showHelp: true };
    } else if (!arg.startsWith('-') && !url) {
      url = arg;
    }
  }

  if (Number.isNaN(depth) || depth < 0) depth = 3;
  if (Number.isNaN(maxPages) || maxPages <= 0) maxPages = 30;
  if (Number.isNaN(concurrency) || concurrency < 1) concurrency = 3;
  if (concurrency > 5) concurrency = 5;

  return { url, depth, maxPages, concurrency, maxScrolls, useSitemap, useLLM, makeZip, showHelp: false };
}

function printUsage() {
  console.log(`
DeepCrawl - Simple CLI Web Crawler

Usage:
  node src/crawl.js <url> [--depth 3] [--max-pages 30] [--concurrency 3] [--zip] [--llm]

Options:
  --depth <number>         Maximum recursion depth for following internal links (default: 3)
  --max-pages <number>     Maximum number of pages to crawl (default: 30)
  --concurrency <number>   Parallel pages crawling within job (1-5, default: 3)
  --max-scrolls <number>   Maximum lazy-load scroll attempts (default: 10)
  --no-sitemap             Disable sitemap.xml seeding
  --llm                    Enable experimental LLM form-filling
  --zip                    Generate a standalone zip archive in output/
  --help, -h               Show this help message
`);
}

async function createZipArchive(result, zipPath) {
  return new Promise(async (resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    const relativeResult = JSON.parse(JSON.stringify(result));
    if (Array.isArray(relativeResult.pages)) {
      for (const page of relativeResult.pages) {
        if (page.screenshot && typeof page.screenshot === 'string') {
          const basename = path.basename(page.screenshot);
          page.screenshot = `screenshots/${basename}`;
        }
      }
    }

    archive.append(JSON.stringify(relativeResult, null, 2), { name: 'result.json' });

    const cliScreenshotsDir = path.resolve('storage', 'screenshots', 'cli');
    try {
      const files = await fs.readdir(cliScreenshotsDir);
      for (const file of files) {
        if (file.endsWith('.png')) {
          archive.file(path.join(cliScreenshotsDir, file), { name: `screenshots/${file}` });
        }
      }
    } catch {}

    archive.finalize();
  });
}

async function main() {
  const { url, depth, maxPages, concurrency, maxScrolls, useSitemap, useLLM, makeZip, showHelp } = parseCliArgs(process.argv);

  if (showHelp || !url) {
    printUsage();
    process.exit(url ? 0 : 1);
  }

  console.log('='.repeat(55));
  console.log(` Starting DeepCrawl CLI`);
  console.log(` Target:      ${url}`);
  console.log(` Max Depth:   ${depth}`);
  console.log(` Max Pages:   ${maxPages}`);
  console.log(` Concurrency: ${concurrency}`);
  console.log(` LLM Enabled: ${useLLM}`);
  console.log('='.repeat(55));

  const outputDir = 'output';
  await fs.mkdir(outputDir, { recursive: true });

  const startTime = Date.now();
  let result;

  const onProgress = ({ pagesVisited, pending, failed, currentUrl, depth: curDepth }) => {
    console.log(`[${pagesVisited}/${maxPages}] Depth ${curDepth}: ${currentUrl}`);
  };

  try {
    result = await crawl(
      {
        url,
        maxDepth: depth,
        maxPages,
        concurrency,
        maxScrolls,
        useSitemap,
        useLLM,
        jobId: 'cli',
        storageDir: 'storage',
        screenshots: true,
        scrollPage: true
      },
      { onProgress }
    );
  } catch (err) {
    console.error(`\n[FATAL ERROR] ${err.message}`);
    process.exit(1);
  }

  const resultPath = path.join(outputDir, 'result.json');
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2), 'utf-8');

  let zipPath = null;
  if (makeZip) {
    zipPath = path.join(outputDir, 'result.zip');
    await createZipArchive(result, zipPath);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n' + '='.repeat(55));
  console.log(' Crawl Finished!');
  console.log(` Elapsed time:      ${elapsed}s`);
  console.log(` Stop reason:       ${result.stopReason}`);
  console.log(` Partial:           ${result.partial}`);
  console.log(` Pages visited:     ${result.summary.pagesVisited}`);
  console.log(` Failed pages:      ${result.summary.failed}`);
  console.log(` Blocked requests:  ${result.summary.blockedRequests}`);
  console.log(` Max depth reached: ${result.summary.maxDepthReached}`);
  if (useLLM) {
    console.log(` LLM calls:         ${result.summary.llmCalls || 0}`);
    console.log(` LLM submits:       ${result.summary.llmSubmits || 0}`);
  }
  console.log(` Output JSON:       ${resultPath}`);
  if (zipPath) {
    console.log(` Zip archive:       ${zipPath}`);
  }
  console.log(` Screenshots:       storage/screenshots/cli/`);
  console.log('='.repeat(55) + '\n');
}

main().catch((err) => {
  console.error('[UNEXPECTED ERROR]', err);
  process.exit(1);
});
