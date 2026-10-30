# Architecture

## Stack
Node.js (ES modules), Express 5, Playwright (Chromium), express-rate-limit, archiver, openai. No external database; jobs live in memory. Screenshots and archives stored on disk.

## Final Folder Structure
```
├── package.json
├── README.md
├── architecture.md
├── prd.md
├── summary.md
├── .env.example
├── .gitignore
├── src/
│   ├── app.js               # Express application setup, optional API key auth, rate limiter
│   ├── server.js            # Starts Express HTTP server
│   ├── config.js            # Configuration constants, limits, caps, TTL, timeouts, LLM settings
│   ├── jobs.js              # In-memory job store, FIFO queue, concurrency limiter (max 2), TTL cleanup
│   ├── crawler.js           # Reusable parallel BFS crawl loop, Playwright lifecycle, LLM submissions
│   ├── extract.js           # Page DOM extraction (text, headings, meta, pagination, images, forms) & screenshots
│   ├── llm.js               # LLM integration, prompt injection shielding, hardcoded safety filter, schema validator
│   ├── urlGuard.js          # DNS resolution, SSRF protection, sitemaps, robots.txt, crawl-trap filter
│   ├── urlUtils.js          # Alias re-exporting urlGuard for backwards compatibility
│   ├── crawl.js             # CLI entry point
│   └── routes/
│       └── crawl.js         # REST API endpoints, zip download streaming, and screenshot file server
├── storage/
│   └── screenshots/
│       ├── cli/             # CLI screenshots
│       └── <jobId>/         # API job screenshots
└── output/
    ├── result.json          # CLI result output
    └── result.zip           # CLI zip archive output (with --zip)
```

## API Endpoint Table

| Method | Path | Request Body | Response Shape | Error Codes |
|---|---|---|---|---|
| `POST` | `/api/crawl` | `{ url, maxDepth?, maxPages?, concurrency?, maxScrolls?, useSitemap?, useLLM?, screenshots?, scrollPage?, timeoutMs? }` | `{ jobId, status, url }` | `400` (missing URL, unsafe IP/hostname, caps exceeded: maxDepth > 10, maxPages > 500, concurrency outside 1-5, missing key when useLLM=true), `401` (missing/invalid `x-api-key`), `429` (rate limit) |
| `GET` | `/api/crawl/:jobId` | *None* | `{ jobId, status, stopReason, partial, pagesVisited, pending, failed, errors, startedAt, finishedAt }` | `400` (invalid jobId), `401` (unauthorized), `404` (not found), `429` |
| `GET` | `/api/crawl/:jobId/results` | *None* | Full crawl JSON (`{ startUrl, stopReason, partial, summary, errors, pages, tree }`) | `400` (invalid jobId), `401` (unauthorized), `404` (not found), `409` (job not finished yet), `500` (job failed without result), `429` |
| `GET` | `/api/crawl/:jobId/download` | *None* | Binary zip archive stream (`application/zip`) containing `result.json` and `screenshots/` | `400` (invalid jobId), `401` (unauthorized), `404` (not found), `409` (job not finished yet), `500` (error), `429` |
| `DELETE` | `/api/crawl/:jobId` | *None* | `{ message, jobId, status }` | `400` (invalid jobId), `401` (unauthorized), `404` (not found), `429` |
| `GET` | `/screenshots/:jobId/:file` | *None* | Image binary (`image/png`) | `400` (invalid parameters), `401` (unauthorized), `403` (path traversal attempt), `404` (file not found) |
| `GET` | `/api/health` | *None* | `{ status, service, chromium, uptime, timestamp }` | `503` (Chromium failed to launch), `429` *(Always public, requires no API key)* |

## Job Lifecycle

```
[queued]
   │
   ▼ (capacity available, max 2 concurrent jobs)
[running] ───────► (user cancellation) ────────► [cancelled] (stopReason: "cancelled", partial: true)
   │
   ├─────────────► (hard timeout 10m) ─────────► [completed] (stopReason: "timeout", partial: true)
   │
   ├─────────────► (all pages / maxPages) ─────► [completed] (stopReason: "queueEmpty" | "maxPages")
   │
   └─────────────► (unrecoverable fatal error) ► [failed]    (stopReason: "error", partial: true)
```

- **queued**: Job placed in FIFO queue.
- **running**: Active crawl in progress. One dedicated browser context per job, crawling up to `concurrency` (1-5) pages in parallel.
- **cancelled**: Triggered via `DELETE /api/crawl/:jobId`. Signals `AbortController` to stop page navigation and retain partial results.
- **completed**: Finished successfully, reached depth/page caps, or hit hard timeout. Partial results and screenshots are preserved.
- **failed**: Fatal startup error or crash before any crawl could occur.

## Housekeeping & Access Control

- **Job TTL & Eviction**:
  - Finished jobs and their screenshot folders are cleaned up after `JOB_TTL_MINUTES` (default 60 minutes).
  - An in-memory cap retains at most 100 jobs, automatically evicting the oldest finished jobs and purging disk screenshots.
- **Optional API Key**:
  - If `API_KEY` is configured via environment variable, all `/api/*` (except `/api/health`) and `/screenshots/*` endpoints require header `x-api-key`.
  - `/api/health` remains public for uptime probes.

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
   - Any redirected request to private or loopback IPs is aborted with `blockedbyclient` and recorded in `blockedRequests`.
4. **Post-Navigation & Post-Submit Verification**:
   - Re-checks `page.url()` after redirects and after form submissions before extracting data or taking screenshots.
5. **Robots.txt & Sitemap Discovery**:
   - Checks `/robots.txt` per origin before fetching paths and skips disallowed routes.
   - Seeds crawl queue with URLs discovered from robots.txt `Sitemap:` directives and `/sitemap.xml`.
6. **Crawl-Trap Protection**:
   - Computes path patterns (digits replaced with `{n}`, query values normalized to `{v}`).
   - Limits URLs to 50 pages per pattern.
   - Drops URLs with length > 2000 characters or > 10 path segments.

## LLM Form-Filling Service (`src/llm.js`)

- **Optional & Off by Default**: Enabled via `useLLM: true` or `--llm`.
- **Untrusted Prompt Shielding**: Page text is wrapped inside `<PAGE_CONTENT>` and explicitly tagged as untrusted; the model is instructed to ignore any instructions inside it.
- **Strict Response Validation**: Uses `response_format: { type: "json_object" }`. Discards any response containing unknown selectors, unknown field names, non-string values, or invalid choices.
- **Hardcoded Safety Filter (Code Decides, Not the Model)**:
  - Form fields and actions are scanned against forbidden keywords: `password`, `login`, `signup`, `checkout`, `payment`, `card`, `cvv`, `billing`, `delete`, `account`, `subscribe`, `contact`, `message`, `comment`, `captcha`, `upload`, `file`.
  - Forms with `password` or `file` inputs are unconditionally refused.
  - Submits only safe search, filter, sort, and pagination forms with dummy values (e.g. `"test"`).
- **Execution & Discovery**:
  - Resulting pages are subjected to SSRF checks and extracted as child pages in the crawl tree.
  - Tracked per page in `llmActions: [ { formSelector, valuesUsed, resultUrl, status } ]`.
  - Governed by caps: `LLM_MAX_CALLS` per job (default 30) and `LLM_MAX_SUBMITS_PER_PAGE` (default 2).
  - Mock mode supported via `LLM_MOCK=1` for testing without API keys.

## Page Result JSON Shape

```json
{
  "startUrl": "https://books.toscrape.com/",
  "stopReason": "maxPages",
  "partial": true,
  "summary": {
    "pagesVisited": 2,
    "failed": 0,
    "maxDepthReached": 1,
    "blockedRequests": 0,
    "llmCalls": 0,
    "llmSubmits": 0
  },
  "errors": [],
  "pages": [
    {
      "url": "https://books.toscrape.com/",
      "finalUrl": "https://books.toscrape.com/",
      "statusCode": 200,
      "title": "All products | Books to Scrape - Sandbox",
      "description": "",
      "headings": {
        "h1": ["All products"],
        "h2": [],
        "h3": []
      },
      "text": "Cleaned visible text from main content (script/style/nav stripped, capped at 20,000 chars)",
      "images": [
        {
          "src": "https://books.toscrape.com/media/cache/2c/da/2cdad67c44b002e7ead0cc35693c0e8b.jpg",
          "alt": "A Light in the Attic",
          "width": 125,
          "height": 155
        }
      ],
      "links": {
        "internal": ["https://books.toscrape.com/catalogue/page-2.html"],
        "external": []
      },
      "depth": 0,
      "parentUrl": null,
      "screenshot": "/screenshots/<jobId>/<sanitized-filename>.png",
      "errors": [],
      "llmActions": []
    }
  ],
  "tree": {
    "url": "https://books.toscrape.com/",
    "children": []
  }
}
```

## Known Limitations

- **DNS Rebinding**: In headless Chromium, DNS is resolved by the browser process independently from Node's pre-flight DNS lookup (`dns.lookup`). Although Playwright route interception (`context.route`) validates the protocol, hostname, and synchronous IP strings on every request, an attacker controlling a malicious authoritative DNS server could theoretically return an allowed public IP on initial lookup and switch to an internal IP (e.g. `127.0.0.1` or `169.254.169.254`) on a subsequent browser connection.
- **Recommended Production Mitigation**: Run the service within an isolated container or Kubernetes pod with an egress network policy / firewall (e.g. iptables, AWS Security Groups, or cloud VPC egress rules) that completely drops outbound traffic destined for loopback (`127.0.0.0/8`), private RFC1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`), and cloud metadata IP endpoints (`169.254.169.254`, `metadata.google.internal`).
