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
import { scoreAgenticBrowsingTool } from "./tools/score-agentic-browsing.js";
import { rewriteForAeo } from "./tools/rewrite-for-aeo.js";
import { rewriteForGeo } from "./tools/rewrite-for-geo.js";
import { extractEntities } from "./tools/extract-entities.js";
import { testCitation } from "./tools/test-citation.js";
import { diffPages, diffPagesInputSchema } from "./tools/diff-pages.js";
import { auditSite, auditSiteInputSchema } from "./tools/audit-site.js";
import { auditSitemap, auditSitemapInputSchema } from "./tools/audit-sitemap.js";
import { saveAuditReport, saveAuditReportInputSchema } from "./tools/save-audit-report.js";
import {
  auditPageOutputShape,
  auditSchemaOutputShape,
  auditCanonicalOutputShape,
  auditSiteOutputShape,
  auditSitemapOutputShape,
  checkRobotsOutputShape,
  checkSitemapOutputShape,
  checkTechnicalOutputShape,
  scoreAiOverviewOutputShape,
  scoreCitationOutputShape,
  scoreAgenticBrowsingOutputShape,
  generateLlmsTxtOutputShape,
  validateLlmsTxtOutputShape,
  rewriteOutputShape,
  extractEntitiesOutputShape,
  testCitationOutputShape,
  diffPagesOutputShape,
  saveReportOutputShape,
} from "./output-schemas.js";
import type { ToolError } from "./types.js";
import { ToolFetchError } from "./lib/fetch.js";

const server = new McpServer({
  name: "@automatelab/ai-seo-mcp",
  version: "0.4.1",
});

type ToolResponse = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Serialize a ToolError to MCP error content. */
function toolError(err: ToolError): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
    isError: true,
  };
}

/**
 * Wrap a tool handler:
 * - On success, returns both `content` (JSON text for legacy clients) and
 *   `structuredContent` (parsed object validated against the tool's outputSchema).
 * - On failure, returns a typed ToolError as a text-only error response.
 */
function wrapHandler<T>(handler: () => Promise<T>): Promise<ToolResponse> {
  return handler()
    .then((result): ToolResponse => ({
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
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

// ---------------------------------------------------------------------------
// Tool naming convention: dot-notation forms a navigable tree.
//   audit.*    - composite audits that fetch and analyse a page or site
//   check.*    - focused single-dimension checks (robots, sitemap, technical)
//   score.*    - numeric scoring of citation / AI-Overview eligibility / cite-or-not
//   llms_txt.* - generate / validate llms.txt files
//   rewrite.*  - LLM-assisted content rewrites (delegated via MCP sampling)
//   extract.*  - entity / structure extraction
//   diff.*     - comparisons between pages
//   report.*   - report rendering and storage
// Renamed in v0.4.0 from the previous flat snake_case names.
// ---------------------------------------------------------------------------

// --- audit.page ---
server.registerTool(
  "audit.page",
  {
    title: "Audit page (full)",
    description: [
      "Full AI-SEO audit of a single URL: returns categorized findings (info/warning/error) with severity, fix instructions, and a 0-100 composite score plus per-dimension subscores.",
      "Read-only. Fetches the URL once and runs every sub-audit (schema, robots, technical, sitemap, AI-Overview eligibility) against the response. No writes, no third-party APIs, no auth required, no rate limits beyond polite per-host throttling.",
      "Deterministic, rule-based scoring; no LLM calls. Same URL + same input flags returns the same score.",
      "Supports `render: \"static\" | \"headless\"`. Default `static` (fast, raw HTML only). Use `headless` for React/Vue/Angular SPAs — adds 3-10s and requires the optional `playwright-core` peer dep plus a one-time `npx playwright install chromium`.",
      "When to use: the default entry point for `audit any page`. Use this instead of calling check.technical / audit.schema / check.robots / check.sitemap / score.ai_overview_eligibility individually unless you specifically need only one dimension - this tool composes all of them.",
    ].join("\n\n"),
    inputSchema: auditPageInputSchema.shape,
    outputSchema: auditPageOutputShape,
    annotations: {
      title: "Audit page (full)",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input) => wrapHandler(() => auditPage(input)),
);

// --- audit.schema ---
server.registerTool(
  "audit.schema",
  {
    title: "Audit JSON-LD schema",
    description: [
      "Validate JSON-LD structured data against Schema.org rules and AI-citation best practices. Accepts either a URL (fetched) or a raw JSON string (parsed directly).",
      "Read-only when given `url` (one HTTP GET). Zero network when given `schema_json`. No writes.",
      "Deterministic, rule-based; no LLM. Validates required/recommended properties, @context correctness, sameAs links, and AI-search-friendly patterns.",
      "When to use: focused JSON-LD audits, or to validate a schema block you're about to ship. For a full page audit that includes schema + everything else, use `audit.page` instead.",
      "Either `url` or `schema_json` must be provided (not both). If both are provided, `schema_json` wins and no fetch happens.",
    ].join("\n\n"),
    inputSchema: {
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
    outputSchema: auditSchemaOutputShape,
    annotations: {
      title: "Audit JSON-LD schema",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input) => {
    if (!input.url && !input.schema_json) {
      return toolError({ type: "invalid_url", message: "One of url or schema_json is required" });
    }
    return wrapHandler(() => auditSchema(input as Parameters<typeof auditSchema>[0]));
  },
);

// --- audit.canonical ---
server.registerTool(
  "audit.canonical",
  {
    title: "Audit canonical link integrity",
    description: [
      "Audit a page's canonical link integrity: presence, self-reference, cross-domain mismatches, trailing-slash hygiene, and og:url consistency.",
      "Read-only. One HTTP GET to fetch the HEAD section.",
      "Deterministic, rule-based; no LLM.",
      "When to use: a focused canonical-only audit (e.g. debugging a duplicate-content issue). For a full HEAD audit including OpenGraph, hreflang, noindex, title, use `check.technical`. For everything-on-a-page, use `audit.page`.",
    ].join("\n\n"),
    inputSchema: auditCanonicalInputSchema.shape,
    outputSchema: auditCanonicalOutputShape,
    annotations: {
      title: "Audit canonical link integrity",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input) => wrapHandler(() => auditCanonical(input)),
);

// --- check.robots ---
server.registerTool(
  "check.robots",
  {
    title: "Check robots.txt crawler posture",
    description: [
      "Fetch and parse a domain's robots.txt; report per-crawler allow/disallow posture for every known AI training crawler (GPTBot, CCBot, Anthropic-AI, Google-Extended, etc.), AI search crawlers (ChatGPT-User, PerplexityBot, OAI-SearchBot), and user-triggered fetchers.",
      "Read-only. One HTTP GET to /robots.txt. No auth, no rate limits applied.",
      "Deterministic, rule-based; no LLM. Returns structured findings with per-crawler status.",
      "When to use: figuring out which AI crawlers a site blocks vs allows. Combine with `check.sitemap` for a full pre-crawl audit. Distinct from `audit.page` which evaluates a single URL; this evaluates a whole-domain policy.",
    ].join("\n\n"),
    inputSchema: checkRobotsInputSchema.shape,
    outputSchema: checkRobotsOutputShape,
    annotations: {
      title: "Check robots.txt crawler posture",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input) => wrapHandler(() => checkRobots(input)),
);

// --- check.sitemap ---
server.registerTool(
  "check.sitemap",
  {
    title: "Check XML sitemap health",
    description: [
      "Validate a domain's XML sitemap: presence, accessibility, URL count, lastmod freshness, sitemap-index handling, and image/video sitemap extensions.",
      "Read-only. Issues N+1 HTTP GETs: one for robots.txt + sitemap, then up to `max_urls_to_check` HEADs against sampled URLs.",
      "Deterministic, rule-based; no LLM.",
      "When to use: site-wide indexing audits. Pair with `check.robots` for a full pre-crawl picture. For per-page checks, use `audit.page` or `check.technical` instead.",
    ].join("\n\n"),
    inputSchema: checkSitemapInputSchema.shape,
    outputSchema: checkSitemapOutputShape,
    annotations: {
      title: "Check XML sitemap health",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input) => wrapHandler(() => checkSitemap(input)),
);

// --- check.technical ---
server.registerTool(
  "check.technical",
  {
    title: "Check technical HEAD signals",
    description: [
      "Audit a page's HEAD section for technical signals relevant to AI crawlers: HTTPS, canonical, OpenGraph, Twitter Card, hreflang, noindex, and title-vs-H1 hygiene.",
      "Read-only. One HTTP GET, inspects HEAD only (body is not parsed).",
      "Deterministic, rule-based; no LLM.",
      "When to use: when you specifically need HEAD-tag audit findings. For the full page including schema and AI-Overview scoring, use `audit.page`. For canonical-only, use `audit.canonical`.",
    ].join("\n\n"),
    inputSchema: checkTechnicalInputSchema.shape,
    outputSchema: checkTechnicalOutputShape,
    annotations: {
      title: "Check technical HEAD signals",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input) => wrapHandler(() => checkTechnical(input)),
);

// --- score.ai_overview_eligibility ---
server.registerTool(
  "score.ai_overview_eligibility",
  {
    title: "Score AI Overview eligibility",
    description: [
      "Score a page's probability of appearing in Google AI Overviews. Returns an overall 0-100 score plus six factor subscores: semantic completeness, structured data, E-E-A-T signals, entity density, freshness, and technical hygiene.",
      "Read-only. One HTTP GET.",
      "Deterministic, rule-based scoring derived from published 2025-2026 AI-Overview correlation studies. No LLM calls. Same URL returns the same score on repeated runs.",
      "When to use: AI-Overview-specific prioritization. For a multi-dimensional audit that includes this scoring plus everything else, use `audit.page`. For citation-worthiness of a specific text passage (rather than a URL ranking probability), use `score.citation_worthiness`.",
    ].join("\n\n"),
    inputSchema: scoreAiOverviewEligibilityInputSchema.shape,
    outputSchema: scoreAiOverviewOutputShape,
    annotations: {
      title: "Score AI Overview eligibility",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input) => wrapHandler(() => scoreAiOverviewEligibility(input)),
);

// --- score.agentic_browsing ---
server.registerTool(
  "score.agentic_browsing",
  {
    title: "Score Agentic Browsing readiness",
    description: [
      "Score a page against the four signals Google added to the Lighthouse \"Agentic Browsing\" category in May 2026: presence of an llms.txt, WebMCP integration, accessibility-tree integrity, and layout stability. Returns an overall 0-100 score, a letter grade, and a per-factor breakdown.",
      "Read-only. One HTTP GET for the page plus one for /llms.txt (skip with check_llms_txt=false). Pass `html` instead of `url` to score markup offline (llms.txt is then treated as absent).",
      "Deterministic, rule-based heuristics over the fetched HTML; no LLM and no headless render required. This approximates Lighthouse's runtime signals from static markup - it does not execute Lighthouse.",
      "When to use: checking whether a site is ready for AI agents / agentic browsers, or tracking the new Lighthouse Agentic Browsing category. For citation-eligibility of content, use `score.citation_worthiness`; for a full page audit, use `audit.page`.",
    ].join("\n\n"),
    inputSchema: {
      url: z.string().url().optional().describe("Public URL to fetch and score. Either this OR `html` is required."),
      html: z.string().optional().describe("Raw HTML to score offline without fetching. Either this OR `url` is required. llms.txt is treated as absent in this mode."),
      respect_robots: z.boolean().optional().default(true).describe("If true (default), respect robots.txt when fetching `url`. Ignored when `html` is used."),
      render: z.enum(["static", "headless"]).optional().default("static").describe("Rendering mode for `url`. `static` (default) reads raw HTML; `headless` runs Playwright Chromium (adds 3-10s; requires `playwright-core`). Ignored when `html` is used."),
      check_llms_txt: z.boolean().optional().default(true).describe("If true (default), probe /llms.txt for the host to score the llms.txt factor. Set false to skip that extra HTTP GET."),
    },
    outputSchema: scoreAgenticBrowsingOutputShape,
    annotations: {
      title: "Score Agentic Browsing readiness",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input) => {
    if (!input.url && !input.html) {
      return toolError({ type: "invalid_url", message: "One of url or html is required" });
    }
    return wrapHandler(() => scoreAgenticBrowsingTool(input as Parameters<typeof scoreAgenticBrowsingTool>[0]));
  },
);

// --- llms_txt.generate ---
server.registerTool(
  "llms_txt.generate",
  {
    title: "Generate llms.txt",
    description: [
      "Generate a spec-compliant llms.txt (and optionally llms-full.txt) for a domain by reading its sitemap, sampling up to `max_pages` pages, and synthesizing a grouped, sectioned summary.",
      "Read-only. Issues one HTTP GET for the sitemap then one per sampled page.",
      "Deterministic; no LLM. Output is the file content as a string - this tool does NOT write to disk or upload anywhere. The caller is responsible for hosting the resulting file at `https://<domain>/llms.txt`.",
      "When to use: bootstrapping llms.txt for a site you own. To check an existing llms.txt, use `llms_txt.validate` instead.",
    ].join("\n\n"),
    inputSchema: generateLlmsTxtInputSchema.shape,
    outputSchema: generateLlmsTxtOutputShape,
    annotations: {
      title: "Generate llms.txt",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input) => wrapHandler(() => generateLlmsTxtTool(input)),
);

// --- llms_txt.validate ---
server.registerTool(
  "llms_txt.validate",
  {
    title: "Validate llms.txt",
    description: [
      "Validate an existing llms.txt or llms-full.txt against the spec: structure, section ordering, link format, and (optionally) broken-link detection.",
      "Read-only. One HTTP GET when given `url`; zero network when given `content`. Optional link-check issues HEAD requests against each link if `check_links` is true.",
      "Deterministic; no LLM.",
      "When to use: auditing an llms.txt you already have. To generate one from scratch, use `llms_txt.generate`.",
      "Either `url` or `content` must be provided.",
    ].join("\n\n"),
    inputSchema: {
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
    outputSchema: validateLlmsTxtOutputShape,
    annotations: {
      title: "Validate llms.txt",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input) => {
    if (!input.url && !input.content) {
      return toolError({ type: "invalid_url", message: "One of url or content is required" });
    }
    return wrapHandler(() => validateLlmsTxt(input as Parameters<typeof validateLlmsTxt>[0]));
  },
);

// --- score.citation_worthiness ---
server.registerTool(
  "score.citation_worthiness",
  {
    title: "Score AI citation worthiness",
    description: [
      "Score how citable a page or text block is for AI engines (ChatGPT, Claude, Perplexity, Google AI Overviews). Evaluates BLUF (bottom-line-up-front) opening, FAQ patterns, statistic density, entity clarity, and answer-shape fit for the optional `target_query`.",
      "Also returns `extractability_score` plus per-section `chunk_analysis`: how cleanly an LLM can lift a self-contained answer from each heading-delimited section (length band, lead-sentence directness, anaphora, concrete anchors). This is the GEO mechanic - it pinpoints the exact sections to tighten, with `most_extractable` / `least_extractable` called out.",
      "Read-only when given `url` (one HTTP GET). Zero network when given `text`. No writes.",
      "Deterministic, rule-based; no LLM calls. Returns reproducible scores.",
      "When to use: pre-publish content QA, or to triage which existing pages are worth optimizing for AI citation first. Distinct from `score.ai_overview_eligibility` which scores Google-AI-Overview ranking probability for a URL; this scores the inherent citability of a text passage regardless of host.",
      "Either `url` or `text` must be provided.",
    ].join("\n\n"),
    inputSchema: {
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
    outputSchema: scoreCitationOutputShape,
    annotations: {
      title: "Score AI citation worthiness",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input) => {
    if (!input.url && !input.text) {
      return toolError({ type: "invalid_url", message: "One of url or text is required" });
    }
    return wrapHandler(() => scoreCitationWorthiness(input as Parameters<typeof scoreCitationWorthiness>[0]));
  },
);

// --- rewrite.aeo ---
server.registerTool(
  "rewrite.aeo",
  {
    title: "Rewrite for Answer Engine Optimization",
    description: [
      "Rewrite a content block for Answer Engine Optimization. Adds a BLUF opening, FAQ structure, schema additions, and concise question-shaped headings tuned for ChatGPT / Perplexity / Google AI Overviews.",
      "Read-only when given `url` (one HTTP GET). Zero network when given `text`. The tool does NOT write back to the URL - it only returns the rewritten content as a string. No side effects on the source.",
      "This tool delegates the actual rewrite to the calling LLM via MCP sampling - it does not call any external API itself. The MCP host's model produces the rewrite. Same input may produce different output across runs (model-dependent).",
      "When to use: optimizing content for direct-answer surfaces (definitions, how-tos, FAQs). For Generative Engine Optimization (entity-rich, comparison-ready synthesis), use `rewrite.geo` instead.",
      "Either `url` or `text` must be provided. `target_query` is required.",
    ].join("\n\n"),
    inputSchema: {
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
    outputSchema: rewriteOutputShape,
    annotations: {
      title: "Rewrite for Answer Engine Optimization",
      readOnlyHint: true,
      destructiveHint: false,
      // LLM sampling makes output non-deterministic - same input may produce different output.
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (input) => {
    if (!input.url && !input.text) {
      return toolError({ type: "invalid_url", message: "One of url or text is required" });
    }
    return wrapHandler(() =>
      rewriteForAeo(input as Parameters<typeof rewriteForAeo>[0], undefined, undefined, server),
    );
  },
);

// --- rewrite.geo ---
server.registerTool(
  "rewrite.geo",
  {
    title: "Rewrite for Generative Engine Optimization",
    description: [
      "Rewrite a content block for Generative Engine Optimization: entity-rich, comparison-ready, synthesis-friendly. Tuned for surfaces that summarize across sources (Perplexity, Google AI Mode, Claude search).",
      "Read-only on input. Does NOT write back to the source URL - returns the rewritten content as a string.",
      "This tool delegates the actual rewrite to the calling LLM via MCP sampling - it does not call any external API itself. The MCP host's model produces the rewrite. Output may vary across runs (model-dependent).",
      "When to use: optimizing for synthesis-style answers across multiple sources. For direct-answer (BLUF + FAQ) optimization on a single page, use `rewrite.aeo` instead.",
      "Either `url` or `text` must be provided. `target_query` is required.",
    ].join("\n\n"),
    inputSchema: {
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
    outputSchema: rewriteOutputShape,
    annotations: {
      title: "Rewrite for Generative Engine Optimization",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (input) => {
    if (!input.url && !input.text) {
      return toolError({ type: "invalid_url", message: "One of url or text is required" });
    }
    return wrapHandler(() =>
      rewriteForGeo(input as Parameters<typeof rewriteForGeo>[0], undefined, undefined, server),
    );
  },
);

// --- extract.entities ---
server.registerTool(
  "extract.entities",
  {
    title: "Extract named entities and sameAs links",
    description: [
      "Extract named entities, linked concepts, and sameAs graph nodes from a page's content and structured data. Combines body-text NER with JSON-LD `@type` / `sameAs` walking.",
      "Read-only when given `url` (one HTTP GET). Zero network when given `text`.",
      "Primary path: MCP sampling - the host LLM does the NER and returns typed entities with sameAs URIs. Fallback path: deterministic regex-based extractor when sampling is unavailable. The result includes `mode: \"sampling\" | \"regex_fallback\"` so callers can tell which path ran.",
      "When to use: building an entity map for schema generation, or auditing whether a page's entities match its target topic. To validate the JSON-LD itself, use `audit.schema`.",
      "Either `url` or `text` must be provided.",
    ].join("\n\n"),
    inputSchema: {
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
      render: z
        .enum(["static", "headless"])
        .optional()
        .default("static")
        .describe("Rendering mode for `url`. `static` (default) reads raw HTML. `headless` runs Playwright Chromium to capture JS-rendered content (adds 3-10s; requires `playwright-core` + `npx playwright install chromium`). Ignored when `text` is used."),
    },
    outputSchema: extractEntitiesOutputShape,
    annotations: {
      title: "Extract named entities and sameAs links",
      readOnlyHint: true,
      destructiveHint: false,
      // Sampling path is model-dependent; regex fallback is deterministic. Mark as non-idempotent to be safe.
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (input) => {
    if (!input.url && !input.text) {
      return toolError({ type: "invalid_url", message: "One of url or text is required" });
    }
    return wrapHandler(() =>
      extractEntities(input as Parameters<typeof extractEntities>[0], undefined, undefined, server),
    );
  },
);

// --- score.test_citation ---
server.registerTool(
  "score.test_citation",
  {
    title: "Test whether an AI engine would cite this page",
    description: [
      "Simulate `would an AI engine cite this page for this query?`. The host LLM role-plays the chosen engine (chatgpt / claude / perplexity / google_ai_overviews / any), reads the page content, and returns a cite/no-cite verdict with the verbatim excerpt it would surface plus ranked improvements.",
      "Read-only when given `url` (one HTTP GET). Zero network when given `text`.",
      "Primary path uses MCP sampling. If the host doesn't support sampling, falls back to a deterministic heuristic derived from `score.citation_worthiness` (overall_score + per-engine subscore must both clear thresholds). The result includes `mode: \"sampling\" | \"static_heuristic\"` so callers can tell which path ran.",
      "When to use: pre-publish gut-check for a specific query, or auditing whether existing content earns citation surface. Distinct from `score.citation_worthiness` (deterministic 0-100 score) and `audit.page` (whole-page rubric); this returns a binary cite/no-cite verdict tied to one query.",
      "Either `url` or `text` must be provided. `target_query` is required.",
    ].join("\n\n"),
    inputSchema: {
      url: z
        .string()
        .url()
        .optional()
        .describe("Public URL to fetch and test. Either this OR `text` is required."),
      text: z
        .string()
        .optional()
        .describe("Raw text/HTML to test directly. Either this OR `url` is required."),
      target_query: z
        .string()
        .min(3)
        .describe("The user query the engine is answering. Required. Example: `how to add JSON-LD to a Next.js app`."),
      engine: z
        .enum(["chatgpt", "claude", "perplexity", "google_ai_overviews", "any"])
        .optional()
        .default("any")
        .describe("Which engine to simulate. `any` (default) uses a generic AI-search persona. Specific engines tune the cite criteria (e.g. perplexity favors statistic-dense excerpts; google_ai_overviews favors schema + freshness)."),
      respect_robots: z
        .boolean()
        .optional()
        .default(true)
        .describe("If true (default), respect robots.txt when fetching `url`. Ignored when `text` is used."),
    },
    outputSchema: testCitationOutputShape,
    annotations: {
      title: "Test whether an AI engine would cite this page",
      readOnlyHint: true,
      destructiveHint: false,
      // Sampling path is model-dependent.
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (input) => {
    if (!input.url && !input.text) {
      return toolError({ type: "invalid_url", message: "One of url or text is required" });
    }
    return wrapHandler(() =>
      testCitation(input as Parameters<typeof testCitation>[0], undefined, undefined, server),
    );
  },
);

// --- diff.pages ---
server.registerTool(
  "diff.pages",
  {
    title: "Diff two pages for citation-worthiness",
    description: [
      "Compare two URLs for AI citation-worthiness and return a structured breakdown of which page is more likely to be cited and why. Typical use: your page (url_a) vs a competitor's page (url_b).",
      "Read-only. Runs audit.page on both URLs in parallel (2 HTTP fetches per URL), then diffs dimension_scores and findings. No new fetch logic beyond what audit.page already does.",
      "Deterministic, rule-based; no LLM calls. Same two URLs return the same comparison on repeated runs.",
      "When to use: competitive gap analysis - understand exactly which dimensions (schema, structure, robots, entity density, freshness, technical, authority, sitemap) put a competitor ahead, and get prioritized fix_recommendations_for_a to close the gap. For a single-URL audit, use audit.page. For overall scoring of one page, use score.citation_worthiness.",
      "Capped at 2 URLs per call. Heuristic verdict - does not claim to know what AI assistants actually cite; verdict matches audit.page's existing rubric.",
    ].join("\n\n"),
    inputSchema: diffPagesInputSchema.shape,
    outputSchema: diffPagesOutputShape,
    annotations: {
      title: "Diff two pages for citation-worthiness",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input) => wrapHandler(() => diffPages(input)),
);

// --- audit.site ---
server.registerTool(
  "audit.site",
  {
    title: "Audit site (homepage + robots + sitemap + schema)",
    description: [
      "Single-call site sweep: runs audit.page (homepage), check.robots, check.sitemap, and audit.schema in parallel and returns an overall grade (A–F) plus top-5 highest-impact fixes.",
      "Read-only. Issues several HTTP GETs against the domain (homepage fetch, robots.txt, sitemap.xml, and up to 50 sitemap URL HEAD checks); no writes, no auth required, no rate limits beyond polite per-host throttling. The homepage GET is deduplicated across audit.page and audit.schema (~2 network fetches for 4 logical checks). Deterministic, rule-based scoring; no LLM calls. Same domain returns the same grade on repeated runs given unchanged content.",
      "Output: domain, homepage_url, fetched_at, overall_score (0–100), overall_grade, top_5_fixes (Finding[]), and a parts breakdown with individual audit.page, check.robots, check.sitemap, and audit.schema results — each may be a full result or { error: string } when that sub-audit fails.",
      "When to use: quick 'how does this site look overall?' — use when you want a single consolidated score and actionable fix list without calling 4 tools individually. Distinct from audit.sitemap (samples N pages from the sitemap, not just the homepage) and audit.page (single-URL deep dive with all findings, not just top-5).",
    ].join("\n\n"),
    inputSchema: auditSiteInputSchema.shape,
    outputSchema: auditSiteOutputShape,
    annotations: {
      title: "Audit site (homepage + robots + sitemap + schema)",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input) => wrapHandler(() => auditSite(input)),
);

// --- audit.sitemap ---
server.registerTool(
  "audit.sitemap",
  {
    title: "Audit a site's content by sampling its sitemap",
    description: [
      "Site-wide content audit: discovers the sitemap, samples N URLs by deterministic uniform stride, runs audit.page on each, and returns score distribution + worst pages + most-common findings.",
      "Read-only. One HTTP GET for sitemap discovery, optionally a few more for sitemap-index children, then `sample_size` × audit.page calls (each one HTTP GET + parsing). Polite throttling is enforced per host.",
      "Deterministic — same domain + same sample_size returns the same set of URLs (uniform-stride sampling). Per-page scoring is rule-based; no LLM.",
      "When to use: portfolio-level health check across a site (\"how does our content score on average?\"). Distinct from `audit.site` (homepage-only composite) and `check.sitemap` (validates sitemap.xml structure, not page content).",
    ].join("\n\n"),
    inputSchema: auditSitemapInputSchema.shape,
    outputSchema: auditSitemapOutputShape,
    annotations: {
      title: "Audit a site's content by sampling its sitemap",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input) => wrapHandler(() => auditSitemap(input)),
);

// --- report.save ---
server.registerTool(
  "report.save",
  {
    title: "Save audit report to disk",
    description:
      "Render an audit.page or audit.site result as a Markdown report and write it to a file under MCP_WORKSPACE_ROOT (defaults to cwd).",
    inputSchema: saveAuditReportInputSchema.shape,
    outputSchema: saveReportOutputShape,
    annotations: {
      title: "Save audit report to disk",
      // Writes a file - not read-only.
      readOnlyHint: false,
      // Overwrite=true (default) replaces existing files; the change is recoverable but writes do occur.
      destructiveHint: true,
      // Same input writes the same content to the same path.
      idempotentHint: true,
      // Operates on the local filesystem only.
      openWorldHint: false,
    },
  },
  async (input) => wrapHandler(() => saveAuditReport(input as Parameters<typeof saveAuditReport>[0])),
);

// --- Prompts: one-click entry points for AI-SEO workflows ---
// Surfaced by hosts like Claude Desktop as suggested actions. Lowers activation cost
// vs. asking users to pick among the 16-tool catalog.

server.prompt(
  "audit_my_homepage",
  "Run a full AI-SEO audit of a site's homepage.",
  { domain: z.string().describe("The site domain, e.g. example.com or https://example.com") },
  ({ domain }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Call the \`audit.site\` tool with domain="${domain}" and respect_robots=true. ` +
            `When the result returns, summarize the overall_grade, the top_5_fixes (highest-impact first), ` +
            `and the content_quality from the underlying audit.page. Recommend the single most leveraged fix first.`,
        },
      },
    ],
  }),
);

server.prompt(
  "find_citation_blockers",
  "Audit a URL and surface only the critical findings blocking AI citations.",
  { url: z.string().url().describe("The URL to audit") },
  ({ url }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Call \`audit.page\` with url="${url}" and respect_robots=true. ` +
            `From the result, filter findings to severity="critical" only. ` +
            `Group them by category and present a prioritized fix list. ` +
            `Ignore warnings and info-level findings for this pass.`,
        },
      },
    ],
  }),
);

server.prompt(
  "generate_llms_txt_for_domain",
  "Generate a valid llms.txt for a domain.",
  { domain: z.string().describe("The site domain, e.g. example.com") },
  ({ domain }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Call \`llms_txt.generate\` with domain="${domain}", max_pages=50, include_full=false. ` +
            `Return the generated llms.txt verbatim in a code block, then summarize how many pages were indexed.`,
        },
      },
    ],
  }),
);

server.prompt(
  "check_ai_crawler_access",
  "Report which AI training and search crawlers can access a domain.",
  { domain: z.string().describe("The site domain, e.g. example.com") },
  ({ domain }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Call \`check.robots\` with domain="${domain}". ` +
            `From the result, build a table grouped by training_crawlers / search_crawlers / user_triggered, ` +
            `with one row per crawler and an allowed/blocked verdict. ` +
            `Highlight any AI search crawlers that are blocked - those silently kill citation surface.`,
        },
      },
    ],
  }),
);

server.prompt(
  "score_my_citation_worthiness",
  "Score how citable a URL is for AI engines and recommend improvements.",
  {
    url: z.string().url().describe("The URL to score"),
    target_query: z.string().describe("The query the page should be cited for"),
  },
  ({ url, target_query }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Call \`score.citation_worthiness\` with url="${url}", target_query="${target_query}", respect_robots=true. ` +
            `Present overall_score and per-engine scores (Perplexity, ChatGPT, Google AI Overviews, Claude). ` +
            `Then suggest the 3 most impactful structural changes (BLUF opening, FAQ blocks, entity density) to lift the lowest score.`,
        },
      },
    ],
  }),
);

// --- Resources: browsable reference data ---
// Hosts can read these on demand to ground answers about AI-SEO without a tool call.

const SIGNALS_DOC = `# AI-citation signals

The 13 signals AI assistants weigh when deciding what to cite.

## 1. JSON-LD structured data
Article / FAQPage / HowTo schema. With Person/Organization author nodes carrying \`sameAs\` links.
Example:
\`\`\`json
{"@context":"https://schema.org","@type":"Article","author":{"@type":"Person","name":"Jane","sameAs":["https://linkedin.com/in/jane"]}}
\`\`\`

## 2. FAQ structure
H3 headings ending in "?" with concise answer paragraphs. FAQPage JSON-LD doubles the signal.

## 3. BLUF (bottom line up front)
First 1-2 sentences answer the query directly. No throat-clearing.

## 4. Statistic density
2-3+ specific numbers per 500 words. Source-attributed where possible.

## 5. Named entities
People, products, places, organizations - named explicitly (not "this product" / "they").

## 6. Entity links
External links to authoritative domains: wikipedia.org, .gov, linkedin.com, crunchbase.com.

## 7. Comparison tables
Side-by-side product/option tables. AI engines extract these directly.

## 8. Ordered lists
Numbered step-by-step. Especially "how to X" content.

## 9. Schema author identity
Author as a Person node with profile URL, not a plain string.

## 10. Freshness
\`dateModified\` within 90 days. Stale content is downranked aggressively.

## 11. Canonical hygiene
Self-referencing canonical, no trailing-slash redirects, \`og:url\` matches canonical.

## 12. AI crawler allowance
robots.txt allows OAI-SearchBot, PerplexityBot, Claude-SearchBot. Blocking training-only crawlers (GPTBot, ClaudeBot) is fine; blocking search crawlers kills citation surface.

## 13. Sitemap freshness
XML sitemap present, lastmod >80% coverage, listed in robots.txt.

Use \`audit.page\` to score a URL across all 13 signals at once.
`;

const CRAWLERS_DOC = `# AI crawlers reference

The user-agents AI assistants use, what they do, and how to allow / block them in robots.txt.

## Training crawlers
These scrape content to train future model weights. Blocking them does not affect live AI citations.

- **GPTBot** - OpenAI training crawler. \`User-agent: GPTBot\`
- **ClaudeBot** - Anthropic training crawler. \`User-agent: ClaudeBot\`
- **CCBot** - Common Crawl. Powers many downstream models. \`User-agent: CCBot\`
- **Meta-ExternalAgent** - Meta training crawler. \`User-agent: Meta-ExternalAgent\`
- **Amazonbot** - Amazon training crawler. \`User-agent: Amazonbot\`

## Search crawlers
These power live AI search / answer engines. Blocking these directly suppresses your visibility in AI answers.

- **OAI-SearchBot** - ChatGPT search index. \`User-agent: OAI-SearchBot\`
- **Claude-SearchBot** - Claude live search. \`User-agent: Claude-SearchBot\`
- **PerplexityBot** - Perplexity search index. \`User-agent: PerplexityBot\`
- **Bingbot** - Bing, also powers Copilot. \`User-agent: Bingbot\`
- **DuckAssistBot** - DuckDuckGo AI assist. \`User-agent: DuckAssistBot\`

## User-triggered fetchers
On-demand fetches when a user shares a URL in chat. Blocking these breaks user-pasted links.

- **ChatGPT-User** - ChatGPT browsing on user request. \`User-agent: ChatGPT-User\`
- **Claude-User** - Claude browsing on user request. \`User-agent: Claude-User\`
- **Google-Agent** - Google Search agent fetches. \`User-agent: Google-Agent\`

## Robots-token-only signals
These are not crawlers - they are tokens that modify whether the existing Googlebot / Applebot crawl is used for AI grounding.

- **Google-Extended** - opts out of Google AI training/grounding. \`User-agent: Google-Extended\`
- **Applebot-Extended** - opts out of Apple AI training. \`User-agent: Applebot-Extended\`

## Recommended posture
For most sites that want AI citation surface:
\`\`\`
User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: *
Allow: /
\`\`\`
(Blocks training, allows everything else - including search crawlers.)

Use \`check.robots\` to see your current posture per crawler.
`;

server.resource(
  "ai-citation-signals",
  "ai-citation://signals",
  { mimeType: "text/markdown", description: "The 13 signals AI assistants use to decide what to cite, with examples." },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: SIGNALS_DOC }],
  }),
);

server.resource(
  "ai-crawlers",
  "ai-citation://crawlers",
  { mimeType: "text/markdown", description: "Catalog of AI training, search, and user-triggered crawlers with robots.txt syntax." },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: CRAWLERS_DOC }],
  }),
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
