# PRD: DeepCrawl (simple version)

## Goal
User submits a URL. Service opens it in Chromium, crawls internal links as deep as allowed, takes a full-page screenshot of each page, and returns JSON.

## In scope (v1)
- POST /api/crawl -> starts job, returns jobId
- GET /api/crawl/:jobId -> status + counts
- GET /api/crawl/:jobId/results -> full JSON
- GET /screenshots/:jobId/:file -> image
- GET /api/health
- JS rendering, auto-scroll for lazy load
- Same-domain recursive crawl, dedupe, maxDepth, maxPages
- Per-page extraction: url, finalUrl, status, title, description, headings, text, internal/external links, depth, parentUrl, screenshot URL, errors
- Basic safety: http/https only, block private/local IPs (incl. redirects), timeouts, rate limit, skip logout/delete/payment links, respect robots.txt

## Out of scope (v1)
Dashboard/UI, database, auth, mobile screenshots, PDF handling, proxies, CAPTCHA/auth bypass.

## Later (v2, optional)
LLM step (useLLM flag): model reads page forms + text and returns JSON of dummy values for safe forms (search/filter only). Never login, payment, contact, upload, or password forms. Capped calls per job.

## Request body
{ "url": "...", "maxDepth": 5, "maxPages": 50, "sameDomain": true, "screenshots": true, "scrollPage": true }

## Success criteria
- Crawls a static site, a JS-rendered site, and an infinite-scroll page correctly
- One failing page does not stop the crawl
- localhost / 127.0.0.1 / 169.254.169.254 requests are rejected
- Every successful page has a screenshot
