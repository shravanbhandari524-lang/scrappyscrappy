# Progress Summary

## Status
Current phase: Complete (Phase 4 completed & Live Groq LLM integration verified)

## Tasks
- [x] Phase 4 - Step A: Page images in the result
  - [x] Extract `<img>` (`src`, `alt`, `width`, `height`) + `og:image`
  - [x] Dedupe, cap at 100 per page, skip data: URIs > 200 chars
- [x] Phase 4 - Step B: One-shot download
  - [x] `GET /api/crawl/:jobId/download` streaming .zip via archiver with relative screenshot URLs
  - [x] CLI `--zip` flag creating zip archive
- [x] Phase 4 - Step C: LLM service (`src/llm.js`), OFF by default
  - [x] Configuration (`OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`, `LLM_MAX_CALLS`, `LLM_MAX_SUBMITS_PER_PAGE`, `LLM_MOCK`)
  - [x] Form extraction & strict response validation
  - [x] Safety rules (skip password, file, payment, login, contact, etc.)
  - [x] Resulting page crawl & `llmActions` recording + summary counters
- [x] Phase 4 - Step D: Tests & Verification
  - [x] Regression of earlier tests
  - [x] End-to-end test with images and zip download
  - [x] Unit tests for LLM validation & safety rules (LLM_MOCK)
  - [x] LLM end-to-end test on quotes.toscrape.com/search.aspx
  - [x] LLM_MAX_CALLS cap test
  - [x] Live Groq API integration test (`openai/gpt-oss-120b`) via CLI & API
- [x] Phase 4 - Step E: Docs & Final Cleanup
  - [x] Update `architecture.md`, `prd.md`, `summary.md`, and `README.md`

## Summary of Phase 4
All features in Phase 4 are fully operational and verified: image extraction with deduplication, streaming one-shot zip download containing relative screenshot paths, strict LLM form-filling safety gating, and anti-prompt injection shielding with budget controls. Live Groq LLM endpoint verified for both CLI and API server.

## Log
- 2026-10-30 - Phase 3 Step C: added stopReason, partial, summary.blockedRequests, timeout status reporting, merged blocked/robots errors into job errors array.
- 2026-10-30 - Phase 3 Step D: implemented TTL cleanup and 100 job limit, optional API_KEY header verification, created .env.example.
- 2026-10-30 - Phase 3 Step E: unit tests for crawl-trap patterns, concurrency 1 vs 3 bounds, books.toscrape.com (100 pages, stopReason maxPages, pagination followed), sitemap discovery on nodejs.org, TTL cleanup with screenshot purge, API key auth, short timeout (stopReason: timeout, partial: true).
- 2026-10-30 - Phase 3 Step F: updated architecture.md with new options, results schema, TTL, API key, and DNS rebinding limitation + mitigation; updated prd.md.
- 2026-10-30 - Phase 4 Step A completed: extracted page images (`src`, `alt`, `width`, `height`, `og:image`) capped at 100 and deduped.
- 2026-10-30 - Phase 4 Step B completed: implemented `GET /api/crawl/:jobId/download` with archiver and CLI `--zip` flag.
- 2026-10-30 - Phase 4 Step C completed: built `src/llm.js` with strict schema validation, hardcoded safety filter, prompt injection shielding, LLM_MOCK support, and integrated post-submit crawl with `llmActions` tracking.
- 2026-10-30 - Phase 4 Step D completed: verified unit test safety gates & LLM response validation, image extraction, zip downloads via CLI and API with relative screenshot links, quotes.toscrape LLM mock submission, and LLM call cap.
- 2026-10-30 - Phase 4 Step E completed: updated `architecture.md`, `prd.md`, `README.md`, and `summary.md` aligning code, routes, flags, and docs.
- 2026-10-30 - Phase 4 Live LLM: verified Groq integration (`openai/gpt-oss-120b`) on quotes.toscrape.com/search.aspx; both CLI and Express REST API completed form submission and recorded `llmActions`.

## History
- 2026-10-30 - Phase 1: basic CLI crawler, Playwright setup, extraction, tests on example.com and quotes.toscrape.com/js.
- 2026-10-30 - Phase 2 Step A & B: added text field (capped 20k), refactored reusable crawl(), screenshots at storage/screenshots/<jobId>/.
- 2026-10-30 - Phase 2 Step C: SSRF protection with DNS checks, route interception, robots.txt, 30s timeout.
- 2026-10-30 - Phase 2 Step D & E: in-memory job manager, Express REST API, rate limiter, screenshots serving.
- 2026-10-30 - Phase 2 Step F & G: tests verified, docs synced.
- 2026-10-30 - Phase 3 Step A: implemented domcontentloaded + 5s networkidle cap fallback, parallel page crawling within a job with concurrency 1-5, exact dedupe and bounds.
- 2026-10-30 - Phase 3 Step B: sitemap discovery (robots.txt and /sitemap.xml), depth-neutral pagination detection, parameter sorting & tracking params stripped, crawl trap pattern grouping (cap 50, len 2000, 10 segs), infinite scroll height monitoring.
