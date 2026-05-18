# Changelog

All notable changes to `@automatelab/ai-seo-mcp` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-05-18

### Added

- **`audit_site` tool** — single-call aggregator that runs `audit_page` (homepage), `check_robots`, `check_sitemap`, and `audit_schema` in parallel, returning an `overall_grade` and `top_5_fixes`. Pairs with the new `audit_my_homepage` prompt.
- **`save_audit_report` tool** — renders an `audit_page` or `audit_site` result as a Markdown report and writes it to a workspace file (restricted to `MCP_WORKSPACE_ROOT`, defaults to cwd).
- **MCP prompts (5)** — `audit_my_homepage`, `find_citation_blockers`, `generate_llms_txt_for_domain`, `check_ai_crawler_access`, `score_my_citation_worthiness`. Hosts that surface prompts (Claude Desktop) get one-click entry points.
- **MCP resources (2)** — `ai-citation://signals` (the 13 citation signals with examples) and `ai-citation://crawlers` (catalog of AI crawler user-agents with robots.txt syntax).
- **In-memory LRU fetch cache** — back-to-back tools targeting the same URL now share a single fetch. 5-minute TTL, 50-entry default. Bypass via `DISABLE_CACHE=true`; tune with `FETCH_CACHE_MAX_ENTRIES` and `FETCH_CACHE_TTL_MS`.
- **SPA detection** — `audit_page` now emits a `content_quality` field (`static_html` | `ssr_likely` | `spa_empty`). When `spa_empty` (body text < 500 chars AND > 5 script tags), it surfaces a critical finding so users know the audit is degraded.
- **GitHub Action** — `action.yml` and an `ai-seo-audit` CLI for CI use. Audits a list of URLs on PR, fails the build on score regression, posts a workflow summary, and can write a Markdown report artifact.

### Notes

- Skips 0.2.0; this release bundles the full v0.2 + v0.3 backlog on top of the 0.1.x patch line (0.1.1 mcpName, 0.1.2 diff_pages + scorecard HTML, 0.1.3 repo rename).
- `audit_page` response shape is back-compatible — `content_quality` is additive.

## [0.1.3] - 2026-05-17

### Changed

- GitHub repository renamed to `ai-seo-mcp`. Package name (`@automatelab/ai-seo-mcp`) and all install commands unchanged.
- Updated `mcpName` to `io.github.AutomateLab-tech/ai-seo-mcp` in `package.json` and `server.json`.
- Updated homepage, repository URLs, User-Agent string, and scorecard footer link to the new repo URL.

## [0.1.2] - 2026-05-16

- `diff_pages` tool added; optional HTML scorecard for `audit_page`.

## [0.1.1] - 2026-05-15

### Added

- `mcpName` field in `package.json` for MCP Registry ownership verification.

## [0.1.0] - 2026-05-15

Initial public release.

### Added

- 13 tools covering AI-SEO auditing, rewriting, and crawler discovery:
  - `audit_page`, `audit_schema`, `audit_canonical`
  - `check_robots`, `check_sitemap`, `check_technical`
  - `score_ai_overview_eligibility`, `score_citation_worthiness`
  - `generate_llms_txt`, `validate_llms_txt`
  - `rewrite_for_aeo`, `rewrite_for_geo`
  - `extract_entities`
- Polite-fetch contract: `robots.txt` respected by default, honest `User-Agent`, host-level rate limiting, response-size cap.
- Configurable via five environment variables: `USER_AGENT`, `FETCH_TIMEOUT_MS`, `MAX_BYTES`, `RESPECT_ROBOTS`, `INTER_REQUEST_DELAY_MS`.
- Detection for 10+ AI crawler user-agents including `GPTBot`, `OAI-SearchBot`, `ClaudeBot`, `anthropic-ai`, `PerplexityBot`, `Perplexity-User`, `Google-Extended`, `Applebot-Extended`, `Bytespider`, `Meta-ExternalAgent`.
- MCP sampling support for rewrite tools, with graceful fallback to prompt-template output when the host client does not implement sampling.
- 16 vitest smoke tests against `automatelab.tech`, `example.com`, and `en.wikipedia.org`.

### Known limitations

- No JavaScript rendering. Pages that require JS to populate content will return incomplete audit results.
- Entity extraction is regex-based; false positives and misses are expected on non-English or highly technical text.
- No PyPI distribution in 0.1.0. Planned for 0.2.0.
- AI Overview eligibility scoring uses deterministic heuristics from published correlation studies, not live SERP queries.

[0.3.0]: https://github.com/AutomateLab-tech/ai-seo-mcp/releases/tag/v0.3.0
[0.1.3]: https://github.com/AutomateLab-tech/ai-seo-mcp/releases/tag/v0.1.3
[0.1.2]: https://github.com/AutomateLab-tech/ai-seo-mcp/releases/tag/v0.1.2
[0.1.1]: https://github.com/AutomateLab-tech/ai-seo-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/AutomateLab-tech/ai-seo-mcp/releases/tag/v0.1.0
