# PRD: DeepCrawl

## Goal
User submits a URL via CLI or REST API. DeepCrawl opens it in headless Chromium, crawls internal links breadth-first up to configurable depth and page limits, extracts structured page content (including cleaned visible text, headings, meta tags, and links), captures full-page screenshots, enforces strict SSRF protections and robots.txt, and returns a hierarchical site tree in JSON format.

## In Scope (Implemented)
- **REST API**:
  - `POST /api/crawl` -> validates input and safety, starts job, returns `{ jobId }`
  - `GET /api/crawl/:jobId` -> returns current status, counts, and errors
  - `GET /api/crawl/:jobId/results` -> returns full crawl JSON (409 if still running)
  - `DELETE /api/crawl/:jobId` -> cancels a queued or running job
  - `GET /screenshots/:jobId/:file` -> securely serves screenshot images
  - `GET /api/health` -> checks server uptime and Chromium launch capability
- **CLI Crawler**:
  - `node src/crawl.js <url> [--depth 3] [--max-pages 30]`
  - Runs with `jobId: "cli"`, writes result to `output/result.json`, stores screenshots at `storage/screenshots/cli/`
- **Crawler & Extraction**:
  - JS rendering with Playwright Chromium
  - Auto-scroll to trigger lazy-loaded elements (capped at 10 scrolls)
  - Breadth-first internal link following (same-domain), deduplication, depth caps (<= 10), and page caps (<= 500)
  - Per-page extraction: `url`, `finalUrl`, `statusCode`, `title`, `description`, `headings` (h1-h3), `text` (cleaned visible content capped at 20,000 chars), `links` (internal/external), `depth`, `parentUrl`, `screenshot` URL, and `errors`
  - Hierarchical discovery `tree` output
- **Safety & SSRF Protection**:
  - `http` and `https` protocols only
  - DNS resolution blocking private, loopback, link-local, and cloud metadata IPs (IPv4, IPv6, mapped IPv4)
  - Playwright route interception (`context.route('**/*')`) revalidating all requests and redirect targets
  - Per-path `robots.txt` enforcement
  - Skip non-web schemes (`mailto:`, `tel:`, etc.) and downloads (`.pdf`, `.zip`, images, media)
  - Skip sensitive actions: URLs containing `logout`, `delete`, `checkout`, `payment`
  - Rate limiting (20 requests/minute per IP)
  - Hard per-job timeout (default 10 minutes) preserving partial crawl results
  - Concurrency limiter (max 2 concurrent running jobs)

## Out of Scope
Dashboard/UI, database, user authentication, mobile viewports, PDF parsing, rotating proxies, CAPTCHA bypass.

## Later (v3, optional)
LLM step (`useLLM` flag): model reads page forms + text and returns JSON of dummy values for safe forms (search/filter only). Never login, payment, contact, upload, or password forms. Capped calls per job.

## Request Body (`POST /api/crawl`)
```json
{
  "url": "https://example.com",
  "maxDepth": 3,
  "maxPages": 30,
  "screenshots": true,
  "scrollPage": true,
  "timeoutMs": 600000
}
```

## Success Criteria
- Crawls static sites and JavaScript-rendered dynamic pages correctly.
- A failing page does not stop the overall crawl.
- Requests to localhost, 127.0.0.1, 169.254.169.254, private IP ranges, or domains resolving to private IPs are rejected immediately.
- Requests redirecting to blocked IPs are intercepted and aborted.
- Full-page screenshots are saved on disk and referenced by URL paths.
