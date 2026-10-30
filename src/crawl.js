#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { crawl } from './crawler.js';

function parseCliArgs(argv) {
  const args = argv.slice(2);
  let url = null;
  let depth = 3;
  let maxPages = 30;

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
    } else if (arg === '--help' || arg === '-h') {
      return { showHelp: true };
    } else if (!arg.startsWith('-') && !url) {
      url = arg;
    }
  }

  if (Number.isNaN(depth) || depth < 0) depth = 3;
  if (Number.isNaN(maxPages) || maxPages <= 0) maxPages = 30;

  return { url, depth, maxPages, showHelp: false };
}

function printUsage() {
  console.log(`
DeepCrawl - Simple CLI Web Crawler

Usage:
  node src/crawl.js <url> [--depth 3] [--max-pages 30]

Options:
  --depth <number>       Maximum recursion depth for following internal links (default: 3)
  --max-pages <number>   Maximum number of pages to crawl (default: 30)
  --help, -h             Show this help message
`);
}

async function main() {
  const { url, depth, maxPages, showHelp } = parseCliArgs(process.argv);

  if (showHelp || !url) {
    printUsage();
    process.exit(url ? 0 : 1);
  }

  console.log('='.repeat(55));
  console.log(` Starting DeepCrawl CLI`);
  console.log(` Target:    ${url}`);
  console.log(` Max Depth: ${depth}`);
  console.log(` Max Pages: ${maxPages}`);
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

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n' + '='.repeat(55));
  console.log(' Crawl Finished!');
  console.log(` Elapsed time:      ${elapsed}s`);
  console.log(` Pages visited:     ${result.summary.pagesVisited}`);
  console.log(` Failed pages:      ${result.summary.failed}`);
  console.log(` Max depth reached: ${result.summary.maxDepthReached}`);
  console.log(` Output JSON:       ${resultPath}`);
  console.log(` Screenshots:       storage/screenshots/cli/`);
  console.log('='.repeat(55) + '\n');
}

main().catch((err) => {
  console.error('[UNEXPECTED ERROR]', err);
  process.exit(1);
});
