# PRD: DeepCrawl

## Goal
User submits a URL via CLI or REST API. DeepCrawl opens it in headless Chromium, crawls internal links breadth-first in parallel up to configurable depth and page limits, extracts structured page content (including cleaned visible text, headings, meta tags, links, and images), captures full-page screenshots, enforces strict SSRF protections and robots.txt, mitigates crawl traps, optionally performs safe LLM form-filling, supports zip archive downloads, and returns a hierarchical site tree with honest termination metadata in JSON format.

## In Scope (Implemented)
- **REST API**:
  - `POST /api/crawl`: validates input and caps, starts asynchronous job, returns `{ jobId }`.
  - `GET /api/crawl/:jobId`: returns status, stopReason, partial flag, counts, and errors.
  - `GET /api/crawl/:jobId/results`: returns full crawl JSON (409 if still running).
  - `GET /api/crawl/:jobId/download`: streams a `.zip` containing `result.json` (with relative screenshot links) and `screenshots/` directory.
  - `DELETE /api/crawl/:jobId`: cancels a queued or running job.
  - `GET /screenshots/:jobId/:file`: securely serves screenshot images.
  - `GET /api/health`: checks server uptime and Chromium launch capability (public probe).
  - Optional API key authentication via `API_KEY` env var and `x-api-key` header.
  - Rate limiting (20 requests/minute per IP).
  - Job TTL auto-cleanup after `JOB_TTL_MINUTES` (default 60m) and in-memory cap of 100 jobs.
- **CLI Crawler**:
  - `node src/crawl.js <url> [--depth 3] [--max-pages 30] [--concurrency 3] [--max-scrolls 10] [--no-sitemap] [--zip] [--llm]`
  - Runs with `jobId: "cli"`, writes result to `output/result.json`, stores screenshots at `storage/screenshots/cli/`, and generates `output/result.zip` when `--zip` is passed.
- **Crawler & Extraction**:
  - JS rendering with Playwright Chromium.
  - Parallel page crawling within a job (`concurrency` 1–5, default 3) sharing one browser context.
  - Infinite scroll monitoring page height until growth halts (capped at `maxScrolls`, default 10).
  - Breadth-first internal link following (same-domain), exact deduplication, depth caps (<= 10), and page caps (<= 500).
  - Depth-neutral pagination detection (`rel="next"`, `next`, `>`, page numbers) avoiding depth budget starvation.
  - Sitemap discovery from robots.txt `Sitemap:` directives and `/sitemap.xml` (capped at 500 URLs).
  - Per-page extraction: `url`, `finalUrl`, `statusCode`, `title`, `description`, `headings` (h1-h3), `text` (cleaned visible content capped at 20,000 chars), `images` (absolute `src`, `alt`, `width`, `height`, `og:image`, capped at 100), `links` (internal/external), `depth`, `parentUrl`, `screenshot` URL, and `errors`.
  - Hierarchical discovery `tree` output.
- **LLM Form-Filling Service (`useLLM`, Off by Default)**:
  - Discovers visible HTML forms on each crawled page.
  - Untrusted prompt shielding (page text tagged as data, injection ignored).
  - Hardcoded safety filter: strictly rejects forms for login, signup, checkout, payment, card, billing, delete, subscribe, contact, comments, password, or file uploads.
  - Only submits safe search, filter, sort, or pagination lookups with dummy values.
  - Resulting pages are checked against SSRF and linked as child pages in the discovery tree.
  - Tracked in `llmActions: [ { formSelector, valuesUsed, resultUrl, status } ]`.
  - Governed by caps: `LLM_MAX_CALLS` (default 30) and `LLM_MAX_SUBMITS_PER_PAGE` (default 2).
  - Mock mode supported via `LLM_MOCK=1`.
- **Honest Result Reporting**:
  - `stopReason`: `queueEmpty`, `maxPages`, `timeout`, `cancelled`, or `error`.
  - `partial`: boolean flag indicating whether the crawl finished completely or stopped early.
  - `summary.blockedRequests`: count of blocked SSRF and robots.txt requests.
  - `summary.llmCalls` & `summary.llmSubmits`: count of LLM queries and form submissions.
  - `job.errors`: collects blocked requests, robots skips, and crawl-trap skips with exact URLs and reasons.
- **Safety, Anti-Trap & SSRF Protection**:
  - `http` and `https` protocols only.
  - DNS resolution blocking private, loopback, link-local, and cloud metadata IPs (IPv4, IPv6, mapped IPv4).
  - Playwright route interception (`context.route('**/*')`) revalidating all requests and redirect targets.
  - Per-path `robots.txt` enforcement.
  - Skip non-web schemes (`mailto:`, `tel:`, etc.) and downloads (`.pdf`, `.zip`, images, media).
  - Skip sensitive actions: URLs containing `logout`, `delete`, `checkout`, `payment`.
  - URL normalization: drops tracking parameters (`utm_*`, `fbclid`, `gclid`, `_ga`, `_gl`), sorts query parameters alphabetically.
  - Crawl-trap protection: patterns group digits to `{n}`, ignores query values, caps each pattern at 50 pages; drops URLs > 2000 chars or > 10 path segments.
  - Hard per-job timeout (default 10 minutes) preserving partial crawl results.
  - Concurrency limiter (max 2 concurrent running jobs).

## Out of Scope
Dashboard/UI, persistent SQL/NoSQL database, user authentication database, mobile viewports, PDF parsing, rotating proxies, CAPTCHA bypass.

## Request Body (`POST /api/crawl`)
```json
{
  "url": "https://books.toscrape.com/",
  "maxDepth": 5,
  "maxPages": 100,
  "concurrency": 3,
  "maxScrolls": 10,
  "useSitemap": true,
  "useLLM": false,
  "screenshots": true,
  "scrollPage": true,
  "timeoutMs": 600000
}
```

## Success Criteria
- Crawls static sites and JavaScript-rendered dynamic pages correctly.
- A failing page does not stop the overall crawl.
- Strict concurrency control: total visited pages never exceeds `maxPages` and URLs are never visited twice.
- Safe LLM form-filling discovers additional pages without touching sensitive forms.
- Zip download delivers complete bundled results and images with portable relative paths.
