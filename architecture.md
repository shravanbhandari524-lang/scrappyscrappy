# Architecture

## Stack
Node.js (ES modules), Express, Playwright (Chromium), express-rate-limit. No database; jobs live in memory. Screenshots on disk.

## Flow
Client -> POST /api/crawl -> validate URL -> create job -> run crawl in background -> client polls status -> fetches results.

## Crawl loop (BFS)
1. queue = [{url, depth 0, parent null}]; visited = Set
2. Pop item; skip if visited, depth > maxDepth, or pages >= maxPages
3. Validate URL (SSRF check) and robots.txt
4. page.goto (timeout 30s); revalidate final URL after redirects
5. Auto-scroll (capped), wait briefly
6. Extract data, take full-page screenshot
7. Normalize + filter links, push new ones to queue with depth+1
8. On error: record in page.errors, continue
9. Run N pages concurrently (default 3)

## Structure
src/
  server.js            start Express
  app.js               middleware + routes
  config.js            defaults and limits
  routes/crawl.js      API endpoints
  crawler.js           queue + crawl loop
  browser.js           launch/close Chromium, one context per job
  extract.js           page -> data object
  screenshot.js        scroll + capture + save
  urlGuard.js          normalize, SSRF/DNS checks, blocked-path filter
  jobs.js              in-memory job store
storage/screenshots/<jobId>/

## Security rules
- http/https only
- Resolve DNS, block private/loopback/link-local/metadata IPs
- Recheck on every redirect (Playwright route interception)
- Navigation timeout, job timeout, caps on depth/pages
- Sanitize filenames; return URLs, never server paths
- Do not return cookies/headers

## Page result shape
{ url, finalUrl, statusCode, title, description, headings, text, links:{internal,external}, depth, parentUrl, screenshot, loadTimeMs, errors }
