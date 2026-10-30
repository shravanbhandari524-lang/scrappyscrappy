# DeepCrawl

A high-performance, hardened web crawler and REST API service built with Node.js (ES modules), Playwright, and Express. DeepCrawl crawls websites breadth-first in headless Chromium with intra-job parallel workers, waits for client-side JavaScript rendering, scrolls to trigger lazy loading, captures full-page screenshots, enforces strict SSRF protections, seeds queues from sitemaps, navigates pagination depth-neutrally, mitigates crawl traps, optionally performs safe LLM form-filling, supports one-shot zip archive exports, and exports structured page metadata with honest termination metrics.

Use it either via the **CLI tool** or as an **API server**.

---

## Prerequisites & Installation

- **Node.js**: v20+ or v22+
- **Playwright Chromium**: installed via npx

1. **Install Node dependencies:**
   ```bash
   npm install
   ```

2. **Download Chromium browser for Playwright:**
   ```bash
   npx playwright install chromium
   ```

3. **Configure Environment (Optional):**
   ```bash
   cp .env.example .env
   ```
   *Edit `.env` to configure `PORT`, `API_KEY`, or LLM credentials.*

---

## CLI Usage

Run the crawler directly from the command line:

```bash
node src/crawl.js <url> [options]
```

### CLI Options

| Flag | Default | Description |
|---|---|---|
| `--depth <n>` | `3` | Maximum crawl depth (0-based) |
| `--max-pages <n>` | `30` | Maximum pages to crawl per run |
| `--concurrency <n>` | `3` | Parallel page workers within the job (1-5) |
| `--max-scrolls <n>` | `10` | Maximum lazy-loading scroll iterations (0 to disable) |
| `--no-sitemap` | `false` | Disable sitemap.xml and robots.txt sitemap seeding |
| `--zip` | `false` | Package results and screenshots into `output/result.zip` |
| `--llm` | `false` | Enable LLM form-filling (requires `OPENAI_API_KEY` or `LLM_MOCK=1`) |

### CLI Examples

Crawl a static website:
```bash
node src/crawl.js https://example.com
```

Crawl a JavaScript-rendered app with concurrency 3 and package into a zip archive:
```bash
node src/crawl.js https://quotes.toscrape.com/js/ --depth 2 --max-pages 15 --concurrency 3 --zip
```

Crawl with LLM form-filling enabled (discovers search/filter results):
```bash
node src/crawl.js https://quotes.toscrape.com/search.aspx --llm
```

- Results are written to: `output/result.json`
- Screenshots are saved to: `storage/screenshots/cli/`
- Zip archive (if `--zip` is passed): `output/result.zip`

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
| `GET` | `/api/crawl/:jobId` | Check job status, stopReason, and crawl counts |
| `GET` | `/api/crawl/:jobId/results` | Fetch full JSON results (returns `409 Conflict` if still running) |
| `GET` | `/api/crawl/:jobId/download` | Stream `.zip` of `result.json` and `screenshots/` (returns `409` if running) |
| `DELETE` | `/api/crawl/:jobId` | Cancel a running or queued crawl job |
| `GET` | `/screenshots/:jobId/:file` | Serve screenshot image (`image/png`) |
| `GET` | `/api/health` | Health check (checks uptime & Chromium launch capability; public probe) |

*If `API_KEY` is configured in the environment, all `/api/*` and `/screenshots/*` endpoints require the `x-api-key` header.*

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
    "url": "https://books.toscrape.com/",
    "maxDepth": 3,
    "maxPages": 20,
    "concurrency": 3,
    "maxScrolls": 10,
    "useSitemap": true,
    "screenshots": true,
    "scrollPage": true,
    "useLLM": false
  }'
```
Response:
```json
{
  "jobId": "a1b2c3d4e5f60718",
  "status": "running",
  "url": "https://books.toscrape.com/"
}
```

#### 3. Poll Job Status
```bash
curl -s http://localhost:3000/api/crawl/<jobId>
```
Response:
```json
{
  "jobId": "a1b2c3d4e5f60718",
  "status": "completed",
  "stopReason": "maxPages",
  "partial": true,
  "pagesVisited": 20,
  "pending": 0,
  "failed": 0,
  "errors": [],
  "startedAt": "2026-10-30T15:00:00.000Z",
  "finishedAt": "2026-10-30T15:01:15.000Z"
}
```

#### 4. Fetch Full Results
```bash
curl -s http://localhost:3000/api/crawl/<jobId>/results
```

#### 5. Download Results & Screenshots as Zip
```bash
curl -s http://localhost:3000/api/crawl/<jobId>/download -o result.zip
```
*The downloaded archive contains `result.json` (where screenshot links are formatted as relative paths `screenshots/<file>.png`) and a `screenshots/` directory.*

#### 6. Cancel a Job
```bash
curl -s -X DELETE http://localhost:3000/api/crawl/<jobId>
```

---

## LLM Form-Filling Service (`src/llm.js`)

DeepCrawl includes an optional LLM service that discovers visible HTML forms and fills safe search or filter queries to explore deeper site states.

- **Disabled by default**: Pass `"useLLM": true` in the API payload or `--llm` on the CLI to enable.
- **Strict Hardcoded Safety Gate**: DeepCrawl automatically rejects any form related to authentication, account creation, payments, file uploads, contact, or feedback. The following types of forms are strictly skipped:
  - Passwords, file inputs, hidden security tokens
  - Login, sign in, sign up, register, logout
  - Checkout, billing, credit card, payment
  - Delete, remove, destroy, cancel
  - Subscribe, newsletter, email opt-in
  - Contact us, inquiry, feedback, comments, reviews
- **Untrusted Prompt Shielding**: Page text is wrapped inside `<PAGE_CONTENT>` tags with explicit model instructions to treat page text strictly as untrusted data and ignore any system prompt injection attempts.
- **Validation**: LLM responses are parsed with strict schema validation (`response_format: { type: "json_object" }`). Any response proposing nonexistent selectors, non-string values, or invalid actions is discarded.
- **Budget Caps**: Controlled by `LLM_MAX_CALLS` (default 30) per job and `LLM_MAX_SUBMITS_PER_PAGE` (default 2).
- **Privacy & Local Models**: When enabled, page text and form metadata are sent to the configured provider. To keep all data strictly on your local machine, point `OPENAI_BASE_URL` to a local OpenAI-compatible endpoint (such as Ollama, LocalAI, or LM Studio) without sending data to third parties.
- **Mock Mode**: Set `LLM_MOCK=1` in your environment to test form-filling flows locally without any external LLM API calls or API keys.

---

## Output Format (`result.json`)

```json
{
  "startUrl": "https://books.toscrape.com/",
  "stopReason": "maxPages",
  "partial": true,
  "summary": {
    "pagesVisited": 20,
    "failed": 0,
    "maxDepthReached": 2,
    "blockedRequests": 0,
    "llmCalls": 0,
    "llmSubmits": 0
  },
  "errors": [],
  "pages": [
    {
      "url": "http://books.toscrape.com/catalogue/page-1.html",
      "finalUrl": "http://books.toscrape.com/catalogue/page-1.html",
      "statusCode": 200,
      "title": "All products | Books to Scrape - Sandbox",
      "description": "",
      "headings": {
        "h1": ["All products"],
        "h2": [],
        "h3": []
      },
      "text": "Cleaned visible text from main content (capped at 20,000 chars)",
      "images": [
        {
          "src": "http://books.toscrape.com/media/cache/2c/da/2cdad67c44b002e7ead0cc35693c0e8b.jpg",
          "alt": "A Light in the Attic",
          "width": 1000,
          "height": 1000
        }
      ],
      "links": {
        "internal": ["http://books.toscrape.com/catalogue/page-2.html"],
        "external": []
      },
      "depth": 0,
      "parentUrl": null,
      "screenshot": "/screenshots/<jobId>/001_books_toscrape_com.png",
      "errors": [],
      "llmActions": []
    }
  ],
  "tree": {
    "url": "http://books.toscrape.com/catalogue/page-1.html",
    "children": []
  }
}
```

---

## Security & Anti-Trap Protections

1. **Protocol Filtering**: Strictly allows `http` and `https`.
2. **DNS & IP Validation**: Resolves DNS records prior to crawling and blocks loopback, private IPv4/IPv6, link-local, and cloud metadata addresses (`localhost`, `127.0.0.1`, `10.x`, `172.16-31.x`, `192.168.x`, `169.254.x`, `localtest.me`, `::1`, `::ffff:...`).
3. **Route Interception**: Uses `context.route('**/*')` to check and abort requests or redirects resolving to forbidden targets.
4. **Robots.txt & Sitemaps**: Respects `/robots.txt` disallows and seeds initial URLs from sitemaps (capped at 500 URLs).
5. **Crawl-Trap Defense**: Groups URLs by normalized patterns (`{n}` digits, ignored query values) capped at 50 pages; rejects URLs > 2000 chars or > 10 path segments.
6. **Depth-Neutral Pagination**: Automatically detects pagination links (`rel="next"`, `next`, `>`, numbers) so the crawl depth budget is not exhausted prematurely.
7. **Job TTL & Eviction**: Auto-evicts finished jobs and purges disk screenshots after `JOB_TTL_MINUTES` (default 60m), capping in-memory jobs to 100.
