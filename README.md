# DeepCrawl

A high-performance, hardened web crawler and REST API service built with Node.js (ES modules), Playwright, and Express. DeepCrawl crawls websites breadth-first in headless Chromium, waits for client-side JavaScript rendering, scrolls to trigger lazy loading, captures full-page screenshots, enforces strict SSRF protections and robots.txt, and exports structured page metadata with a hierarchical site tree.

Use it either via the **CLI tool** or as an **API server**.

---

## Installation

1. **Install Node dependencies:**
   ```bash
   npm install
   ```

2. **Download Chromium browser for Playwright:**
   ```bash
   npx playwright install chromium
   ```

---

## CLI Usage

Run the crawler directly from the command line:

```bash
node src/crawl.js <url> [--depth 3] [--max-pages 30]
```

### CLI Examples

Crawl a static website:
```bash
node src/crawl.js https://example.com
```

Crawl a JavaScript-rendered single-page app up to depth 2 and max 15 pages:
```bash
node src/crawl.js https://quotes.toscrape.com/js/ --depth 2 --max-pages 15
```

- Results are written to: `output/result.json`
- Screenshots are saved to: `storage/screenshots/cli/`

---

## API Server Usage

### Start the Server

```bash
# Start server (default: port 3000)
npm run server

# Or run directly:
node src/server.js
```

### API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/crawl` | Start a new asynchronous crawl job |
| `GET` | `/api/crawl/:jobId` | Check job status and crawl counts |
| `GET` | `/api/crawl/:jobId/results` | Fetch full JSON results (returns `409` if still running) |
| `DELETE` | `/api/crawl/:jobId` | Cancel a running or queued crawl job |
| `GET` | `/screenshots/:jobId/:file` | Serve screenshot image (`image/png`) |
| `GET` | `/api/health` | Health check (checks uptime & Chromium launch capability) |

---

### Curl Examples

#### 1. Check Service Health
```bash
curl -s http://localhost:3000/api/health
```

#### 2. Start a Crawl Job
```bash
curl -s -X POST http://localhost:3000/api/crawl \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://quotes.toscrape.com/js/",
    "maxDepth": 2,
    "maxPages": 10,
    "screenshots": true,
    "scrollPage": true
  }'
```
*Response (`201 Created`):*
```json
{
  "jobId": "eae94d5cc109a345",
  "status": "running",
  "url": "https://quotes.toscrape.com/js/"
}
```

#### 3. Poll Job Status
```bash
curl -s http://localhost:3000/api/crawl/eae94d5cc109a345
```
*Response (`200 OK`):*
```json
{
  "jobId": "eae94d5cc109a345",
  "status": "completed",
  "pagesVisited": 4,
  "pending": 0,
  "failed": 0,
  "errors": [],
  "startedAt": "2026-10-30T13:31:52.559Z",
  "finishedAt": "2026-10-30T13:32:07.750Z"
}
```

#### 4. Fetch Full Results
```bash
curl -s http://localhost:3000/api/crawl/eae94d5cc109a345/results
```

#### 5. Cancel a Job
```bash
curl -s -X DELETE http://localhost:3000/api/crawl/eae94d5cc109a345
```

#### 6. View a Screenshot
```bash
curl -I http://localhost:3000/screenshots/eae94d5cc109a345/001_quotes_toscrape_com_js.png
```

---

## Output Format (`result.json`)

```json
{
  "startUrl": "https://quotes.toscrape.com/js",
  "summary": {
    "pagesVisited": 4,
    "failed": 0,
    "maxDepthReached": 1
  },
  "pages": [
    {
      "url": "https://quotes.toscrape.com/js",
      "finalUrl": "http://quotes.toscrape.com/js",
      "statusCode": 200,
      "title": "Quotes to Scrape",
      "description": "",
      "headings": {
        "h1": ["Quotes to Scrape"],
        "h2": [],
        "h3": []
      },
      "text": "Cleaned visible text from main content (capped at 20,000 chars)",
      "links": {
        "internal": [
          "http://quotes.toscrape.com/",
          "http://quotes.toscrape.com/login"
        ],
        "external": [
          "https://www.goodreads.com/quotes"
        ]
      },
      "depth": 0,
      "parentUrl": null,
      "screenshot": "/screenshots/cli/001_quotes_toscrape_com_js.png",
      "errors": []
    }
  ],
  "tree": {
    "url": "https://quotes.toscrape.com/js",
    "children": [
      {
        "url": "http://quotes.toscrape.com/",
        "children": []
      }
    ]
  }
}
```

---

## Security & SSRF Protection

1. **Protocol Filtering**: Strictly allows `http` and `https`.
2. **DNS & IP Validation**: Resolves DNS records prior to crawling and blocks loopback, private IPv4/IPv6, link-local, and cloud metadata addresses (`localhost`, `127.0.0.1`, `10.x`, `172.16-31.x`, `192.168.x`, `169.254.x`, `localtest.me`, `::1`, `::ffff:...`).
3. **Route Interception**: Uses `context.route('**/*')` to check and abort requests or redirects resolving to forbidden targets.
4. **Robots.txt**: Automatically fetches and respects `/robots.txt` paths for every crawled domain.
5. **Rate Limiting**: Rate-limited at 20 requests per minute per IP via `express-rate-limit`.
6. **Path Traversal Protection**: Screenshot filenames and job IDs are sanitized using strict alphanumeric regex.
