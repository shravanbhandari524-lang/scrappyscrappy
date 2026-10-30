# Progress Summary

## Status
Current phase: Phase 2 Complete (Ready for Phase 3)

## Tasks
- [x] Phase 2 - Step A: Small fixes to existing crawler
  - [x] Add `text` field per page (cleaned visible content, capped at 20,000 chars)
  - [x] Speed up: replace fixed sleeps with `waitForLoadState('networkidle')` + short scroll pauses (~200ms)
  - [x] Measure and report new execution time on `quotes.toscrape.com/js`
- [x] Phase 2 - Step B: Refactor into reusable function
  - [x] `crawler.js` exports `crawl(options, { onProgress, signal })`
  - [x] Update `src/crawl.js` CLI to call `crawl()` with jobId "cli"
  - [x] Store screenshots at `storage/screenshots/<jobId>/<file>.png` with result URL `/screenshots/<jobId>/<file>.png`
- [x] Phase 2 - Step C: Stronger SSRF protection (`src/urlGuard.js`)
  - [x] DNS resolution + IP check (IPv4, IPv6, mapped IPv4, loopback, private, link-local, cloud metadata)
  - [x] `page.route('**/*')` route interception to check every request & redirect
  - [x] Robots.txt fetch & check per path
  - [x] 30s navigation timeout
- [x] Phase 2 - Step D: Job manager (`src/jobs.js`, in-memory)
  - [x] `createJob(options)` with URL-safe jobId
  - [x] Statuses: queued, running, completed, failed, cancelled
  - [x] Max 2 concurrent running jobs queue
  - [x] Hard job timeout (default 10 min) preserving partial results
  - [x] One context per job, browser crash recovery
- [x] Phase 2 - Step E: Express API & Server
  - [x] Install express and express-rate-limit
  - [x] `POST /api/crawl`, `GET /api/crawl/:jobId`, `GET /api/crawl/:jobId/results`, `DELETE /api/crawl/:jobId`
  - [x] `GET /screenshots/:jobId/:file`, `GET /api/health`
  - [x] Validation (maxDepth <= 10, maxPages <= 500), rate limiting (20 req/min/IP), sanitization
- [x] Phase 2 - Step F: Verification & Testing
  - [x] Test static site, JS site, redirect, failing URL
  - [x] Test SSRF blocklist (localhost, 127.0.0.1, 169.254.169.254, DNS private domain, redirect to localhost)
  - [x] Full curl workflow test (start, poll, results, screenshot, cancel, timeout)
- [x] Phase 2 - Step G: Documentation & Final Alignment
  - [x] Update `README.md` with CLI and API curl examples
  - [x] Update `architecture.md` and `prd.md` to reflect exact code and routes
  - [x] Set next phase in `summary.md` and report summary

## Log
- 2026-10-30 - Phase 1 completed: basic CLI crawler, Playwright setup, extraction, tests on example.com and quotes.toscrape.com/js.
- 2026-10-30 - Phase 2 Step A & B completed: added cleaned `text` field capped at 20,000 chars, replaced fixed sleep with dynamic load state, refactored `crawler.js` to export reusable `crawl()` taking onProgress & signal, switched screenshots to `storage/screenshots/<jobId>/` with public URL path `/screenshots/<jobId>/<file>.png`. CLI tested successfully.
- 2026-10-30 - Phase 2 Step C completed: implemented DNS resolution checks for IPv4/IPv6/mapped IPv4, route interception via `context.route` to abort disallowed redirects/requests, robots.txt path enforcement, and 30s navigation timeouts.
- 2026-10-30 - Phase 2 Step D & E completed: built in-memory job manager (`src/jobs.js`) with max 2 concurrency, hard 10 min timeout, cancel, per-job context and crash recovery. Built Express API (`src/app.js`, `src/server.js`, `src/config.js`, `src/routes/crawl.js`) with validation caps, rate limiting (20 req/min/IP), and secure screenshot static serving.
- 2026-10-30 - Phase 2 Step F completed: verified static site, JS site, redirect, 404 failure, SSRF blocks (localhost, 127.0.0.1, 169.254.169.254, localtest.me DNS check, redirect to localhost), cancellation, and hard timeout.
- 2026-10-30 - Phase 2 Step G completed: synced `architecture.md`, `prd.md`, `summary.md`, and `README.md`.

## Known issues / TODO
- None.

## Decisions
- Robots.txt parsing implemented natively in urlGuard without adding external dependencies.
- Screenshots storage organized under `storage/screenshots/<jobId>/` with public URL path `/screenshots/<jobId>/<file>.png`.
- Replaced separate `browser.js` and `screenshot.js` proposed in initial architecture draft with modular integration in `crawler.js` and `extract.js` to avoid redundant file layers while preserving clean separation.
