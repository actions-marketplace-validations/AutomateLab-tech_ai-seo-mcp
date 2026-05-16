#!/usr/bin/env node
// AI-SEO MCP Server - entrypoint.
// All logging goes to stderr. stdout is reserved for JSON-RPC transport.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { auditPage, auditPageInputSchema } from "./tools/audit-page.js";
import { auditSchema } from "./tools/audit-schema.js";
import { auditCanonical, auditCanonicalInputSchema } from "./tools/audit-canonical.js";
import { checkRobots, checkRobotsInputSchema } from "./tools/check-robots.js";
import { checkSitemap, checkSitemapInputSchema } from "./tools/check-sitemap.js";
import { checkTechnical, checkTechnicalInputSchema } from "./tools/check-technical.js";
import { scoreAiOverviewEligibility, scoreAiOverviewEligibilityInputSchema } from "./tools/score-ai-overview-eligibility.js";
import { generateLlmsTxtTool, generateLlmsTxtInputSchema } from "./tools/generate-llms-txt.js";
import { validateLlmsTxt } from "./tools/validate-llms-txt.js";
import { scoreCitationWorthiness } from "./tools/score-citation-worthiness.js";
import { rewriteForAeo } from "./tools/rewrite-for-aeo.js";
import { rewriteForGeo } from "./tools/rewrite-for-geo.js";
import { extractEntities } from "./tools/extract-entities.js";
import { diffPages, diffPagesInputSchema } from "./tools/diff-pages.js";
import type { ToolError } from "./types.js";
import { ToolFetchError } from "./lib/fetch.js";

const server = new McpServer({
  name: "@automatelab/ai-seo-mcp",
  version: "0.1.2",
});

/** Serialize a ToolError to MCP error content. */
function toolError(err: ToolError): { content: [{ type: "text"; text: string }]; isError: true } {
  return {
    content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
    isError: true,
  };
}

type ToolResponse = { content: [{ type: "text"; text: string }]; isError?: boolean };

/** Wrap a tool handler to catch errors and return structured ToolError responses. */
function wrapHandler<T>(handler: () => Promise<T>): Promise<ToolResponse> {
  return handler()
    .then((result): ToolResponse => ({
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    }))
    .catch((err: unknown): ToolResponse => {
      if (err instanceof ToolFetchError) {
        return toolError(err.toolError);
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error("[error]", message);
      return toolError({ type: "fetch_error", url: "", message });
    });
}

// --- Tool 1: audit_page ---
server.tool(
  "audit_page",
  [
    "Full AI-SEO audit of a single URL: returns categorized findings (info/warning/error) with severity, fix instructions, and a 0-100 composite score plus per-dimension subscores.",
    "Read-only. Fetches the URL once and runs every sub-audit (schema, robots, technical, sitemap, AI-Overview eligibility) against the response. No writes, no third-party APIs, no auth required, no rate limits beyond polite per-host throttling.",
    "Deterministic, rule-based scoring; no LLM calls. Same URL + same input flags returns the same score.",
    "When to use: the default entry point for `audit any page`. Use this instead of calling check_technical / audit_schema / check_robots / check_sitemap / score_ai_overview_eligibility individually unless you specifically need only one dimension - this tool composes all of them.",
  ].join("\n\n"),
  auditPageInputSchema.shape,
  async (input) => wrapHandler(() => auditPage(input))
);

// --- Tool 2: audit_schema ---
server.tool(
  "audit_schema",
  [
    "Validate JSON-LD structured data against Schema.org rules and AI-citation best practices. Accepts either a URL (fetched) or a raw JSON string (parsed directly).",
    "Read-only when given `url` (one HTTP GET). Zero network when given `schema_json`. No writes.",
    "Deterministic, rule-based; no LLM. Validates required/recommended properties, @context correctness, sameAs links, and AI-search-friendly patterns.",
    "When to use: focused JSON-LD audits, or to validate a schema block you're about to ship. For a full page audit that includes schema + everything else, use `audit_page` instead.",
    "Either `url` or `schema_json` must be provided (not both). If both are provided, `schema_json` wins and no fetch happens.",
  ].join("\n\n"),
  {
    url: z
      .string()
      .url()
      .optional()
      .describe("Public URL to fetch and audit. Either this OR `schema_json` is required. Read-only HTTP GET."),
    schema_json: z
      .string()
      .optional()
      .describe("Raw JSON-LD as a string (the contents of a `<script type=\"application/ld+json\">` block). Use this to validate a schema block offline without fetching a URL. Either this OR `url` is required."),
    respect_robots: z
      .boolean()
      .optional()
      .default(true)
      .describe("If true (default), respect robots.txt before fetching `url`. Ignored when `schema_json` is used."),
  },
  async (input) => {
    if (!input.url && !input.schema_json) {
      return toolError({ type: "invalid_url", message: "One of url or schema_json is required" });
    }
    return wrapHandler(() => auditSchema(input as Parameters<typeof auditSchema>[0]));
  }
);

// --- Tool 3: audit_canonical ---
server.tool(
  "audit_canonical",
  [
    "Audit a page's canonical link integrity: presence, self-reference, cross-domain mismatches, trailing-slash hygiene, and og:url consistency.",
    "Read-only. One HTTP GET to fetch the HEAD section.",
    "Deterministic, rule-based; no LLM.",
    "When to use: a focused canonical-only audit (e.g. debugging a duplicate-content issue). For a full HEAD audit including OpenGraph, hreflang, noindex, title, use `check_technical`. For everything-on-a-page, use `audit_page`.",
  ].join("\n\n"),
  auditCanonicalInputSchema.shape,
  async (input) => wrapHandler(() => auditCanonical(input))
);

// --- Tool 4: check_robots ---
server.tool(
  "check_robots",
  [
    "Fetch and parse a domain's robots.txt; report per-crawler allow/disallow posture for every known AI training crawler (GPTBot, CCBot, Anthropic-AI, Google-Extended, etc.), AI search crawlers (ChatGPT-User, PerplexityBot, OAI-SearchBot), and user-triggered fetchers.",
    "Read-only. One HTTP GET to /robots.txt. No auth, no rate limits applied.",
    "Deterministic, rule-based; no LLM. Returns structured findings with per-crawler status.",
    "When to use: figuring out which AI crawlers a site blocks vs allows. Combine with `check_sitemap` for a full pre-crawl audit. Distinct from `audit_page` which evaluates a single URL; this evaluates a whole-domain policy.",
  ].join("\n\n"),
  checkRobotsInputSchema.shape,
  async (input) => wrapHandler(() => checkRobots(input))
);

// --- Tool 5: check_sitemap ---
server.tool(
  "check_sitemap",
  [
    "Validate a domain's XML sitemap: presence, accessibility, URL count, lastmod freshness, sitemap-index handling, and image/video sitemap extensions.",
    "Read-only. Issues N+1 HTTP GETs: one for robots.txt + sitemap, then up to `max_urls_to_check` HEADs against sampled URLs.",
    "Deterministic, rule-based; no LLM.",
    "When to use: site-wide indexing audits. Pair with `check_robots` for a full pre-crawl picture. For per-page checks, use `audit_page` or `check_technical` instead.",
  ].join("\n\n"),
  checkSitemapInputSchema.shape,
  async (input) => wrapHandler(() => checkSitemap(input))
);

// --- Tool 6: check_technical ---
server.tool(
  "check_technical",
  [
    "Audit a page's HEAD section for technical signals relevant to AI crawlers: HTTPS, canonical, OpenGraph, Twitter Card, hreflang, noindex, and title-vs-H1 hygiene.",
    "Read-only. One HTTP GET, inspects HEAD only (body is not parsed).",
    "Deterministic, rule-based; no LLM.",
    "When to use: when you specifically need HEAD-tag audit findings. For the full page including schema and AI-Overview scoring, use `audit_page`. For canonical-only, use `audit_canonical`.",
  ].join("\n\n"),
  checkTechnicalInputSchema.shape,
  async (input) => wrapHandler(() => checkTechnical(input))
);

// --- Tool 7: score_ai_overview_eligibility ---
server.tool(
  "score_ai_overview_eligibility",
  [
    "Score a page's probability of appearing in Google AI Overviews. Returns an overall 0-100 score plus six factor subscores: semantic completeness, structured data, E-E-A-T signals, entity density, freshness, and technical hygiene.",
    "Read-only. One HTTP GET.",
    "Deterministic, rule-based scoring derived from published 2025-2026 AI-Overview correlation studies. No LLM calls. Same URL returns the same score on repeated runs.",
    "When to use: AI-Overview-specific prioritization. For a multi-dimensional audit that includes this scoring plus everything else, use `audit_page`. For citation-worthiness of a specific text passage (rather than a URL ranking probability), use `score_citation_worthiness`.",
  ].join("\n\n"),
  scoreAiOverviewEligibilityInputSchema.shape,
  async (input) => wrapHandler(() => scoreAiOverviewEligibility(input))
);

// --- Tool 8: generate_llms_txt ---
server.tool(
  "generate_llms_txt",
  [
    "Generate a spec-compliant llms.txt (and optionally llms-full.txt) for a domain by reading its sitemap, sampling up to `max_pages` pages, and synthesizing a grouped, sectioned summary.",
    "Read-only. Issues one HTTP GET for the sitemap then one per sampled page.",
    "Deterministic; no LLM. Output is the file content as a string - this tool does NOT write to disk or upload anywhere. The caller is responsible for hosting the resulting file at `https://<domain>/llms.txt`.",
    "When to use: bootstrapping llms.txt for a site you own. To check an existing llms.txt, use `validate_llms_txt` instead.",
  ].join("\n\n"),
  generateLlmsTxtInputSchema.shape,
  async (input) => wrapHandler(() => generateLlmsTxtTool(input))
);

// --- Tool 9: validate_llms_txt ---
server.tool(
  "validate_llms_txt",
  [
    "Validate an existing llms.txt or llms-full.txt against the spec: structure, section ordering, link format, and (optionally) broken-link detection.",
    "Read-only. One HTTP GET when given `url`; zero network when given `content`. Optional link-check issues HEAD requests against each link if `check_links` is true.",
    "Deterministic; no LLM.",
    "When to use: auditing an llms.txt you already have. To generate one from scratch, use `generate_llms_txt`.",
    "Either `url` or `content` must be provided.",
  ].join("\n\n"),
  {
    url: z
      .string()
      .url()
      .optional()
      .describe("Public URL of an existing llms.txt or llms-full.txt to validate (e.g. `https://example.com/llms.txt`). Either this OR `content` is required."),
    content: z
      .string()
      .optional()
      .describe("Raw llms.txt content as a string. Use this to validate a file offline without fetching. Either this OR `url` is required."),
    check_links: z
      .boolean()
      .optional()
      .default(true)
      .describe("If true (default), HEAD each linked URL to detect broken links. Set false to skip link checks for faster, network-light validation of just the structural rules."),
  },
  async (input) => {
    if (!input.url && !input.content) {
      return toolError({ type: "invalid_url", message: "One of url or content is required" });
    }
    return wrapHandler(() => validateLlmsTxt(input as Parameters<typeof validateLlmsTxt>[0]));
  }
);

// --- Tool 10: score_citation_worthiness ---
server.tool(
  "score_citation_worthiness",
  [
    "Score how citable a page or text block is for AI engines (ChatGPT, Claude, Perplexity, Google AI Overviews). Evaluates BLUF (bottom-line-up-front) opening, FAQ patterns, statistic density, entity clarity, and answer-shape fit for the optional `target_query`.",
    "Read-only when given `url` (one HTTP GET). Zero network when given `text`. No writes.",
    "Deterministic, rule-based; no LLM calls. Returns reproducible scores.",
    "When to use: pre-publish content QA, or to triage which existing pages are worth optimizing for AI citation first. Distinct from `score_ai_overview_eligibility` which scores Google-AI-Overview ranking probability for a URL; this scores the inherent citability of a text passage regardless of host.",
    "Either `url` or `text` must be provided.",
  ].join("\n\n"),
  {
    url: z
      .string()
      .url()
      .optional()
      .describe("Public URL to fetch and score. Either this OR `text` is required."),
    text: z
      .string()
      .optional()
      .describe("Raw text/markdown/HTML to score directly without fetching. Either this OR `url` is required."),
    target_query: z
      .string()
      .optional()
      .describe("Optional target search query the content is supposed to answer (e.g. `how to fix CORS errors in Next.js`). When provided, scoring weights answer-shape fit and query-term coverage. Omit if you want a query-agnostic citability score."),
    respect_robots: z
      .boolean()
      .optional()
      .default(true)
      .describe("If true (default), respect robots.txt when fetching `url`. Ignored when `text` is used."),
  },
  async (input) => {
    if (!input.url && !input.text) {
      return toolError({ type: "invalid_url", message: "One of url or text is required" });
    }
    return wrapHandler(() => scoreCitationWorthiness(input as Parameters<typeof scoreCitationWorthiness>[0]));
  }
);

// --- Tool 11: rewrite_for_aeo ---
server.tool(
  "rewrite_for_aeo",
  [
    "Rewrite a content block for Answer Engine Optimization. Adds a BLUF opening, FAQ structure, schema additions, and concise question-shaped headings tuned for ChatGPT / Perplexity / Google AI Overviews.",
    "Read-only when given `url` (one HTTP GET). Zero network when given `text`. The tool does NOT write back to the URL - it only returns the rewritten content as a string. No side effects on the source.",
    "This tool delegates the actual rewrite to the calling LLM via MCP sampling - it does not call any external API itself. The MCP host's model produces the rewrite. Same input may produce different output across runs (model-dependent).",
    "When to use: optimizing content for direct-answer surfaces (definitions, how-tos, FAQs). For Generative Engine Optimization (entity-rich, comparison-ready synthesis), use `rewrite_for_geo` instead.",
    "Either `url` or `text` must be provided. `target_query` is required.",
  ].join("\n\n"),
  {
    url: z
      .string()
      .url()
      .optional()
      .describe("Public URL whose content should be fetched and rewritten. Either this OR `text` is required."),
    text: z
      .string()
      .optional()
      .describe("Raw content (markdown or HTML) to rewrite directly. Either this OR `url` is required."),
    target_query: z
      .string()
      .describe("The user query the rewrite should answer (e.g. `what is RAG`, `how to deploy Ghost to Docker`). Required - drives heading shape and BLUF wording."),
    format: z
      .enum(["article", "faq", "howto", "comparison"])
      .default("article")
      .describe("Output shape. `article` for prose-with-headings. `faq` for Q&A list. `howto` for numbered-step procedural content with HowTo schema hints. `comparison` for X-vs-Y tables. Default `article`."),
    max_words: z
      .number()
      .int()
      .min(100)
      .max(5000)
      .optional()
      .default(1500)
      .describe("Soft word budget for the rewrite. Default 1500. Range 100-5000. The rewrite tries to stay under this; very small budgets may force truncation."),
    respect_robots: z
      .boolean()
      .optional()
      .default(true)
      .describe("If true (default), respect robots.txt when fetching `url`. Ignored when `text` is used."),
  },
  async (input) => {
    if (!input.url && !input.text) {
      return toolError({ type: "invalid_url", message: "One of url or text is required" });
    }
    return wrapHandler(() =>
      rewriteForAeo(input as Parameters<typeof rewriteForAeo>[0], undefined, undefined, server)
    );
  }
);

// --- Tool 12: rewrite_for_geo ---
server.tool(
  "rewrite_for_geo",
  [
    "Rewrite a content block for Generative Engine Optimization: entity-rich, comparison-ready, synthesis-friendly. Tuned for surfaces that summarize across sources (Perplexity, Google AI Mode, Claude search).",
    "Read-only on input. Does NOT write back to the source URL - returns the rewritten content as a string.",
    "This tool delegates the actual rewrite to the calling LLM via MCP sampling - it does not call any external API itself. The MCP host's model produces the rewrite. Output may vary across runs (model-dependent).",
    "When to use: optimizing for synthesis-style answers across multiple sources. For direct-answer (BLUF + FAQ) optimization on a single page, use `rewrite_for_aeo` instead.",
    "Either `url` or `text` must be provided. `target_query` is required.",
  ].join("\n\n"),
  {
    url: z
      .string()
      .url()
      .optional()
      .describe("Public URL whose content should be fetched and rewritten. Either this OR `text` is required."),
    text: z
      .string()
      .optional()
      .describe("Raw content to rewrite directly. Either this OR `url` is required."),
    target_query: z
      .string()
      .describe("The user query the rewrite should answer. Required - drives entity selection and comparison framing."),
    add_comparison_table: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, inject an explicit X-vs-Y comparison table into the rewrite (useful for `X vs Y` queries). Default false."),
    max_words: z
      .number()
      .int()
      .min(100)
      .max(5000)
      .optional()
      .default(1500)
      .describe("Soft word budget. Default 1500. Range 100-5000."),
    respect_robots: z
      .boolean()
      .optional()
      .default(true)
      .describe("If true (default), respect robots.txt when fetching `url`. Ignored when `text` is used."),
  },
  async (input) => {
    if (!input.url && !input.text) {
      return toolError({ type: "invalid_url", message: "One of url or text is required" });
    }
    return wrapHandler(() =>
      rewriteForGeo(input as Parameters<typeof rewriteForGeo>[0], undefined, undefined, server)
    );
  }
);

// --- Tool 13: extract_entities ---
server.tool(
  "extract_entities",
  [
    "Extract named entities, linked concepts, and sameAs graph nodes from a page's content and structured data. Combines body-text NER heuristics with JSON-LD `@type` / `sameAs` walking.",
    "Read-only when given `url` (one HTTP GET). Zero network when given `text`.",
    "Deterministic, rule-based; no LLM. Output is a list of entities with type, confidence, and any sameAs URIs found in structured data.",
    "When to use: building an entity map for schema generation, or auditing whether a page's entities match its target topic. To validate the JSON-LD itself, use `audit_schema`.",
    "Either `url` or `text` must be provided.",
  ].join("\n\n"),
  {
    url: z
      .string()
      .url()
      .optional()
      .describe("Public URL to fetch and analyze. Either this OR `text` is required."),
    text: z
      .string()
      .optional()
      .describe("Raw text/HTML to analyze directly. Either this OR `url` is required."),
    respect_robots: z
      .boolean()
      .optional()
      .default(true)
      .describe("If true (default), respect robots.txt when fetching `url`. Ignored when `text` is used."),
  },
  async (input) => {
    if (!input.url && !input.text) {
      return toolError({ type: "invalid_url", message: "One of url or text is required" });
    }
    return wrapHandler(() => extractEntities(input as Parameters<typeof extractEntities>[0]));
  }
);

// --- Tool 14: diff_pages ---
server.tool(
  "diff_pages",
  [
    "Compare two URLs for AI citation-worthiness and return a structured breakdown of which page is more likely to be cited and why. Typical use: your page (url_a) vs a competitor's page (url_b).",
    "Read-only. Runs audit_page on both URLs in parallel (2 HTTP fetches per URL), then diffs dimension_scores and findings. No new fetch logic beyond what audit_page already does.",
    "Deterministic, rule-based; no LLM calls. Same two URLs return the same comparison on repeated runs.",
    "When to use: competitive gap analysis - understand exactly which dimensions (schema, structure, robots, entity density, freshness, technical, authority, sitemap) put a competitor ahead, and get prioritized fix_recommendations_for_a to close the gap. For a single-URL audit, use audit_page. For overall scoring of one page, use score_citation_worthiness.",
    "Capped at 2 URLs per call. Heuristic verdict - does not claim to know what AI assistants actually cite; verdict matches audit_page's existing rubric.",
  ].join("\n\n"),
  diffPagesInputSchema.shape,
  async (input) => wrapHandler(() => diffPages(input))
);

// --- Start server ---
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ai-seo-mcp] Server started on stdio transport");
}

main().catch((err: unknown) => {
  console.error("[ai-seo-mcp] Fatal error:", err);
  process.exit(1);
});
