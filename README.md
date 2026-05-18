# @automatelab/ai-seo-mcp

> AI Citation Toolkit for the Model Context Protocol

[![npm version](https://img.shields.io/npm/v/@automatelab/ai-seo-mcp.svg)](https://www.npmjs.com/package/@automatelab/ai-seo-mcp)
[![license](https://img.shields.io/npm/l/@automatelab/ai-seo-mcp.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@automatelab/ai-seo-mcp.svg)](https://nodejs.org)

**Audit why AI systems do or do not cite your pages.** MCP server. No API keys.

Works inside Claude, Cursor, Windsurf, Codex, and any MCP client that speaks stdio.

---

## What it checks

- **AI crawler access** - GPTBot, OAI-SearchBot, ClaudeBot, and PerplexityBot allowed or blocked in `robots.txt`
- **`llms.txt`** - present, spec-compliant, links alive
- **Structured answer extraction** - FAQ headings, BLUF paragraphs, answer-ready blocks
- **[[schema]] completeness** - FAQPage, Article, Organization, Person; flags deprecated patterns
- **Entity clarity** - named entity density and `sameAs` coverage that help AI systems identify the subject
- **Citation formatting** - canonical URL hygiene, `og:url`, `hreflang`, noindex traps
- **Sitemap freshness** - `lastmod` signals that tell crawlers the page is current

---

## Run an audit. Get a list of citation-blockers, ranked.

> **You:** Run an AI-SEO audit on `https://automatelab.tech/how-to-connect-zapier-to-notion`.

Result (truncated):

```json
{
  "url": "https://automatelab.tech/how-to-connect-zapier-to-notion",
  "score": 61,
  "grade": "C",
  "dimension_scores": {
    "schema": 45, "technical": 80, "structure": 40,
    "robots": 90, "freshness": 85, "authority": 40,
    "entity_density": 21, "sitemap": 100
  },
  "findings": [
    {
      "severity": "critical",
      "category": "structure",
      "message": "No FAQ structure found (no FAQPage schema or H3 question headings).",
      "fix": "Add FAQ H3 headings ending in '?' with answer paragraphs, and a FAQPage JSON-LD block.",
      "estimated_impact": "high"
    },
    {
      "severity": "warning",
      "category": "authority",
      "message": "Low authority signals - missing Organization or author Person schema.",
      "fix": "Add Organization JSON-LD and Article.author as a Person node with sameAs links.",
      "estimated_impact": "high"
    }
  ]
}
```

Each finding names the exact fix. No opaque scores, no guesswork.

---

## Install

```bash
npx -y @automatelab/ai-seo-mcp
```

Requires Node 20 or later.

### Claude Desktop

Add to `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "ai-seo": {
      "command": "npx",
      "args": ["-y", "@automatelab/ai-seo-mcp"]
    }
  }
}
```

Restart Claude Desktop. Any MCP client that supports stdio transport works - same `command` / `args` pattern.

### Optional: headless rendering for SPAs

By default `audit_page` reads raw HTML — fast, but misses content on React/Vue/Angular SPAs. Pass `render: "headless"` to spin up Chromium and audit the rendered DOM (adds 3-10s per audit).

One-time install:

```bash
npm install playwright-core
npx playwright install chromium
```

Then call `audit_page` with `render: "headless"`. Use static for everything else — most marketing sites and docs render fine without it.

---

## Further reading

- [automatelab.tech](https://automatelab.tech/products/mcp/ai-seo/) - teardowns and case studies

---

<details>
<summary>All 14 tools</summary>

| Tool | Purpose |
|------|---------|
| `audit_page` | Composite AI-SEO audit with 8-dimension scoring (schema, technical, structure, robots, freshness, authority, entity density, sitemap). |
| `audit_schema` | Validate JSON-LD against Schema.org rules and AI-citation best practice. Flags deprecated patterns. |
| `audit_canonical` | Canonical link integrity, trailing-slash hygiene, `og:url` consistency. |
| `check_robots` | Parse `robots.txt` and report per-crawler allow/disallow for all known AI crawlers. Surfaces the GPTBot-blocked-but-OAI-SearchBot-allowed trap. |
| `check_sitemap` | Validate XML sitemaps: presence, URL count, `lastmod` freshness, image/video extensions. |
| `check_technical` | HEAD tag audit: canonical, OpenGraph, Twitter Card, hreflang, HTTPS, noindex, title hygiene. |
| `score_ai_overview_eligibility` | Score a page's probability of appearing in Google AI Overviews using current correlation factors. |
| `generate_llms_txt` | Generate `llms.txt` and optionally `llms-full.txt` from a domain's sitemap. |
| `validate_llms_txt` | Lint an existing `llms.txt` for spec compliance and broken links. |
| `score_citation_worthiness` | Score how citable a page or text block is for Perplexity, ChatGPT, Google AI Overviews, and Claude. |
| `rewrite_for_aeo` | Rewrite content for Answer Engine Optimization (BLUF structure, FAQ format, schema additions). |
| `rewrite_for_geo` | Rewrite content for Generative Engine Optimization (entity definitions, comparison tables, synthesis-ready structure). |
| `extract_entities` | Extract named entities, `sameAs` links, and citation-density score from a page's content and structured data. |
| `diff_pages` | Compare two URLs for AI citation-worthiness: side-by-side dimension scores, gap analysis, and prioritized fix recommendations for url_a. |

Environment variables: see [ENV.md](./ENV.md).

</details>

---

## Contributing

Bug reports, feature ideas, and PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Security

To report a vulnerability, see [SECURITY.md](./SECURITY.md).

## License

MIT - see [LICENSE](./LICENSE).

Built by [automatelab.tech](https://automatelab.tech)
