# Architecture

## Stack
Node.js (ES modules), Express 5, Playwright (Chromium), express-rate-limit. No external database; jobs live in memory. Screenshots stored on disk.

## Final Folder Structure
```
├── package.json
├── README.md
├── architecture.md
├── prd.md
├── summary.md
├── src/
│   ├── app.js               # Express application setup, rate limiter, middleware
│   ├── server.js            # Starts Express HTTP server
│   ├── config.js            # Configuration constants, limits, caps, and timeouts
│   ├── jobs.js              # In-memory job store, FIFO queue, concurrency limiter (max 2)
│   ├── crawler.js           # Reusable BFS crawl loop, Playwright lifecycle, crash recovery
│   ├── extract.js           # Page DOM data extraction (text, headings, meta) & screenshot capture
│   ├── urlGuard.js          # DNS resolution, SSRF protection, robots.txt, keyword/file filter
│   ├── urlUtils.js          # Alias re-exporting urlGuard for backwards compatibility
│   ├── crawl.js             # CLI entry point
│   └── routes/
│       └── crawl.js         # REST API endpoints and screenshot file server
├── storage/
│   └── screenshots/
│       ├── cli/             # CLI screenshots
│       └── <jobId>/         # API job screenshots
└── output/
    └── result.json          # CLI result output
```

## API Endpoint Table

| Method | Path | Request Body | Response Shape | Error Codes |
|---|---|---|---|---|
| `POST` | `/api/crawl` | `{ url, maxDepth?, maxPages?, screenshots?, scrollPage?, timeoutMs? }` | `{ jobId, status, url }` | `400` (missing URL, unsafe IP/hostname, caps exceeded: maxDepth > 10, maxPages > 500), `429` (rate limit) |
| `GET` | `/api/crawl/:jobId` | *None* | `{ jobId, status, pagesVisited, pending, failed, errors, startedAt, finishedAt }` | `400` (invalid jobId), `404` (not found), `429` |
| `GET` | `/api/crawl/:jobId/results` | *None* | Full crawl JSON (`{ startUrl, summary, pages, tree }`) | `400` (invalid jobId), `404` (not found), `409` (job not finished yet), `500` (job failed without result), `429` |
| `DELETE` | `/api/crawl/:jobId` | *None* | `{ message, jobId, status }` | `400` (invalid jobId), `404` (not found), `429` |
| `GET` | `/screenshots/:jobId/:file` | *None* | Image binary (`image/png`) | `400` (invalid parameters), `403` (path traversal attempt), `404` (file not found) |
| `GET` | `/api/health` | *None* | `{ status, service, chromium, uptime, timestamp }` | `503` (Chromium failed to launch), `429` |

## Job Lifecycle

```
[queued]
   │
   ▼ (capacity available, max 2 concurrent)
[running] ───────► (user cancellation) ────────► [cancelled]
   │
   ├─────────────► (hard timeout 10m) ─────────► [completed] (partial results kept)
   │
   ├─────────────► (all pages crawled) ────────► [completed]
   │
   └─────────────► (unrecoverable fatal error) ► [failed]
```

- **queued**: Job created and placed in the in-memory FIFO queue.
- **running**: Active crawl in progress. One dedicated browser context per job.
- **cancelled**: Triggered via `DELETE /api/crawl/:jobId`. Signals `AbortController` to stop page navigation and return partial results.
- **completed**: Finished successfully or reached depth/page caps or hard timeout. Partial results and screenshots are preserved.
- **failed**: Fatal start error (e.g., completely unreachable host or crash before any crawl).

## SSRF Protection Layers

1. **Pre-Flight Validation**:
   - URL scheme must be `http` or `https`.
   - Hostname check against `localhost`, `*.localhost`, and `metadata.google.internal`.
   - Direct IP check against IPv4 loopback (`127.0.0.0/8`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`), shared address (`100.64.0.0/10`), IPv6 loopback (`::1`), unique local (`fc00::/7`), link-local (`fe80::/10`), and IPv4-mapped IPv6 (`::ffff:...`).
2. **DNS Resolution Check**:
   - Resolves all IPv4 and IPv6 addresses via `dns.lookup({ all: true })`.
   - Rejects any domain resolving to private, loopback, link-local, or cloud-metadata IPs (e.g. `localtest.me` resolving to `127.0.0.1` or `::1`).
3. **Route Interception (`context.route('**/*')`)**:
   - Intercepts every outgoing browser request and redirect hop.
   - Any redirected request to private or loopback IPs is aborted with `blockedbyclient`.
4. **Post-Navigation Verification**:
   - Re-checks `page.url()` after redirects before extracting data or taking screenshots.
5. **Robots.txt Enforcement**:
   - Checks `/robots.txt` per origin before fetching paths and skips disallowed routes.

## Page Result JSON Shape

```json
{
  "startUrl": "https://example.com/",
  "summary": {
    "pagesVisited": 1,
    "failed": 0,
    "maxDepthReached": 0
  },
  "pages": [
    {
      "url": "https://example.com/",
      "finalUrl": "https://example.com/",
      "statusCode": 200,
      "title": "Example Domain",
      "description": "",
      "headings": {
        "h1": [],
        "h2": [],
        "h3": []
      },
      "text": "Cleaned visible text from main content (script/style/nav stripped, capped at 20,000 chars)",
      "links": {
        "internal": [],
        "external": ["https://iana.org/help/example-domains"]
      },
      "depth": 0,
      "parentUrl": null,
      "screenshot": "/screenshots/<jobId>/<sanitized-filename>.png",
      "errors": []
    }
  ],
  "tree": {
    "url": "https://example.com/",
    "children": []
  }
}
```
