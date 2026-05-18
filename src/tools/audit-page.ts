// Tool: audit_page
// Full AI-SEO audit of a single URL. Runs all sub-audits and returns a composite score.

import { z } from "zod";
import { politeFetch, ToolFetchError, type HostDelayMap } from "../lib/fetch.js";
import { parseHead, parseBody } from "../lib/html.js";
import { parseJsonLd, getAllSchemaTypes, validateJsonLd } from "../lib/schema.js";
import { checkTechnical } from "./check-technical.js";
import { auditSchema } from "./audit-schema.js";
import { checkRobots } from "./check-robots.js";
import { checkSitemap } from "./check-sitemap.js";
import { scoreAiOverviewEligibility } from "./score-ai-overview-eligibility.js";
import { freshnessScore, deriveGrade, computeWeightedScore } from "../lib/score.js";
import { renderScorecardHtml } from "../lib/scorecard-html.js";
import type { Finding, AuditResult } from "../types.js";

export const auditPageInputSchema = z.object({
  url: z
    .string()
    .url()
    .describe("Public URL to audit. Must be a fully-qualified http(s) URL that returns HTTP 200 (redirects are followed). The tool fetches this URL once and runs every sub-audit (schema, robots, technical, sitemap, AI-Overview eligibility) against the response."),
  include_raw_html: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, return the full raw HTML in the response under `raw_html`. Default false. Set true only when you need to inspect markup that wasn't captured by the structured findings; the payload can be large."),
  respect_robots: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true (default), the tool checks robots.txt before fetching and skips disallowed paths, returning a robots_blocked finding instead. Set to false ONLY for auditing your own site where you've intentionally blocked crawlers and need the audit to bypass that block."),
  generate_report: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, return a standalone HTML scorecard in the `report_html` field. The HTML is self-contained (no external dependencies) and can be saved as a .html file or pasted to Gist/CodePen. Default false to keep audits cheap."),
});

export type AuditPageInput = z.infer<typeof auditPageInputSchema>;

export interface CitationVerdict {
  will_ai_cite: "unlikely" | "marginal" | "likely";
  top_3_blockers: Array<{
    category: string;
    message: string;
    fix: string;
    estimated_impact?: "high" | "medium" | "low";
  }>;
  one_line_summary: string;
}

export type ContentQuality = "static_html" | "ssr_likely" | "spa_empty";

export interface AuditPageResult extends AuditResult {
  citation_verdict: CitationVerdict;
  dimension_scores: {
    schema: number;
    robots: number;
    technical: number;
    freshness: number;
    structure: number;
    authority: number;
    entity_density: number;
    sitemap: number;
  };
  /**
   * Heuristic classification of the fetched HTML's content readiness.
   * - `static_html`: body text >= 500 chars; audit is reliable.
   * - `ssr_likely`: body text < 500 chars but few scripts; small/edge page or stub.
   * - `spa_empty`: body text < 500 chars AND >5 script tags; results are degraded — re-run with render: 'headless' once available.
   */
  content_quality: ContentQuality;
  raw_html?: string;
  report_html?: string;
}

const SPA_BODY_TEXT_MIN = 500;
const SPA_SCRIPT_TAG_MIN = 5;

function detectContentQuality(bodyText: string, scriptCount: number): ContentQuality {
  const textLen = bodyText.trim().length;
  if (textLen >= SPA_BODY_TEXT_MIN) return "static_html";
  if (scriptCount > SPA_SCRIPT_TAG_MIN) return "spa_empty";
  return "ssr_likely";
}

function countScriptTags(html: string): number {
  let n = 0;
  const re = /<script\b/gi;
  while (re.exec(html) !== null) n++;
  return n;
}

export async function auditPage(input: AuditPageInput): Promise<AuditPageResult> {
  const hostDelays: HostDelayMap = new Map();
  const robotsCache = new Map<string, string>();

  // Fetch URL once
  const result = await politeFetch(input.url, {
    respectRobots: input.respect_robots,
    hostDelays,
    robotsCache,
  });

  const ct = result.headers["content-type"];
  const ctStr = Array.isArray(ct) ? ct[0] : (ct ?? "");
  if (ctStr && !ctStr.includes("html")) {
    throw new ToolFetchError({
      type: "non_html_response",
      url: input.url,
      content_type: ctStr,
    });
  }

  const fetched_at = new Date().toISOString();
  const allFindings: Finding[] = [];

  // --- Schema dimension ---
  let schemaScore = 50;
  try {
    const schemaResult = await auditSchema(
      { url: input.url, respect_robots: input.respect_robots },
      hostDelays,
      robotsCache
    );
    schemaScore = schemaResult.ai_citation_readiness_score;
    allFindings.push(...schemaResult.findings);
  } catch {
    // schema audit failed - use default score
  }

  // --- Technical dimension ---
  let technicalScore = 50;
  try {
    const techResult = await checkTechnical(
      { url: input.url, respect_robots: input.respect_robots },
      hostDelays,
      robotsCache
    );
    // Derive technical score from findings
    const techFindings = techResult.findings;
    allFindings.push(...techFindings);
    const criticals = techFindings.filter((f) => f.severity === "critical").length;
    const warnings = techFindings.filter((f) => f.severity === "warning").length;
    technicalScore = Math.max(0, 100 - criticals * 20 - warnings * 8);
    // noindex is a killer
    if (techResult.noindex) technicalScore = Math.max(0, technicalScore - 30);
  } catch {
    // technical audit failed
  }

  // --- Robots dimension ---
  let robotsScore = 70;
  try {
    const hostname = new URL(input.url).hostname;
    const robotsResult = await checkRobots({ domain: hostname });
    const robotsFindings = robotsResult.findings.filter(
      (f) => f.severity === "critical" || f.severity === "warning"
    );
    allFindings.push(...robotsResult.findings);
    robotsScore = Math.max(
      0,
      100 -
        robotsFindings.filter((f) => f.severity === "critical").length * 15 -
        robotsFindings.filter((f) => f.severity === "warning").length * 7
    );
  } catch {
    // robots check failed
  }

  // --- Page content for structure/freshness/authority/entity_density ---
  const head = parseHead(result.body);
  const body = parseBody(result.body, input.url);
  const jsonLdBlocks = parseJsonLd(result.body);
  const foundTypes = getAllSchemaTypes(jsonLdBlocks);

  // --- Freshness dimension ---
  let dateModified: string | null = null;
  for (const b of jsonLdBlocks) {
    const dm = b.parsed["dateModified"] ?? b.parsed["datePublished"];
    if (typeof dm === "string") {
      dateModified = dm;
      break;
    }
  }
  const freshnessScoreVal = freshnessScore(dateModified);
  if (freshnessScoreVal < 50) {
    allFindings.push({
      severity: "warning",
      category: "freshness",
      where: "Article.dateModified",
      message: dateModified
        ? "Content appears stale (dateModified > 90 days ago)."
        : "No dateModified found in structured data.",
      fix: "Update content and set dateModified to today in Article JSON-LD.",
      estimated_impact: "medium",
    });
  }

  // --- Structure dimension ---
  const hasFaq = foundTypes.includes("FAQPage") || body.h3s.some((h) => h.endsWith("?"));
  const hasHowTo = foundTypes.includes("HowTo");
  const hasOrderedList = body.orderedLists > 0;
  const hasTable = body.tables > 0;
  const goodHeadings = body.h2s.length >= 2;
  let structureScore = 20;
  if (hasFaq) structureScore += 30;
  if (hasHowTo) structureScore += 15;
  if (hasOrderedList) structureScore += 15;
  if (hasTable) structureScore += 10;
  if (goodHeadings) structureScore += 10;
  structureScore = Math.min(100, structureScore);

  if (!hasFaq) {
    allFindings.push({
      severity: "critical",
      category: "structure",
      where: "<body>",
      message: "No FAQ structure found (no FAQPage schema or H3 question headings).",
      fix: "Add FAQ H3 headings ending in '?' with answer paragraphs, and a FAQPage JSON-LD block.",
      estimated_impact: "high",
    });
  }

  // --- Authority dimension ---
  const hasOrg = foundTypes.includes("Organization");
  const hasPerson = jsonLdBlocks.some((b) => b.types.includes("Person"));
  const hasArticleWithAuthorNode = jsonLdBlocks.some(
    (b) =>
      b.types.some((t) => ["Article", "BlogPosting", "NewsArticle"].includes(t)) &&
      typeof b.parsed["author"] === "object" &&
      b.parsed["author"] !== null
  );
  let authorityScore = 10;
  if (hasOrg) authorityScore += 30;
  if (hasPerson || hasArticleWithAuthorNode) authorityScore += 30;
  const sameAsCount = jsonLdBlocks.reduce((acc, b) => {
    const sa = b.parsed["sameAs"];
    return acc + (Array.isArray(sa) ? sa.length : sa ? 1 : 0);
  }, 0);
  if (sameAsCount > 0) authorityScore += Math.min(30, sameAsCount * 5);
  authorityScore = Math.min(100, authorityScore);

  if (authorityScore < 40) {
    allFindings.push({
      severity: "warning",
      category: "authority",
      where: "page-level",
      message: "Low authority signals - missing Organization or author Person schema.",
      fix: "Add Organization JSON-LD and Article.author as a Person node with sameAs links.",
      estimated_impact: "high",
    });
  }

  // --- Entity density dimension ---
  const authoritativeDomains = [
    "wikipedia.org","wikidata.org",".gov","linkedin.com","twitter.com",
    "x.com","crunchbase.com","bloomberg.com","reuters.com",
  ];
  const authExternalLinks = body.externalLinks.filter((href) =>
    authoritativeDomains.some((d) => href.includes(d))
  ).length;
  const entityDensityScore = Math.min(100, (sameAsCount + authExternalLinks) * 7);

  // --- Sitemap dimension ---
  let sitemapScore = 50;
  try {
    const hostname = new URL(input.url).hostname;
    const sitemapResult = await checkSitemap(
      { domain: hostname, max_urls_to_check: 50 },
      hostDelays,
      robotsCache
    );
    if (sitemapResult.status === "found") {
      sitemapScore = 80;
      if (sitemapResult.urls_with_lastmod / Math.max(1, sitemapResult.total_urls) > 0.8) {
        sitemapScore = 100;
      }
    } else {
      sitemapScore = 20;
    }
  } catch {
    // sitemap check failed
  }

  // --- Weighted composite score ---
  const dimensionScores = {
    schema: schemaScore,
    robots: robotsScore,
    technical: technicalScore,
    freshness: freshnessScoreVal,
    structure: structureScore,
    authority: authorityScore,
    entity_density: entityDensityScore,
    sitemap: sitemapScore,
  };

  const scriptCount = countScriptTags(result.body);
  const contentQuality = detectContentQuality(body.bodyText, scriptCount);
  if (contentQuality === "spa_empty") {
    allFindings.push({
      severity: "critical",
      category: "technical",
      where: "<body>",
      message: "Page appears to be a JS-rendered SPA (low body text, many script tags); audit results are likely incomplete.",
      fix: "Re-run audit_page with render: 'headless' (when available), or serve SSR/prerendered HTML so AI crawlers without JS see real content.",
      estimated_impact: "high",
    });
  }

  const score = computeWeightedScore(dimensionScores);
  const grade = deriveGrade(score);

  // Deduplicate findings (same message from multiple sub-tools)
  const seen = new Set<string>();
  const deduped = allFindings.filter((f) => {
    const key = `${f.severity}:${f.category}:${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // --- Citation verdict (prepended block) ---
  const will_ai_cite: "unlikely" | "marginal" | "likely" =
    score < 50 ? "unlikely" : score <= 75 ? "marginal" : "likely";

  const impactOrder = { high: 0, medium: 1, low: 2, undefined: 3 };
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  const top_3_blockers = [...deduped]
    .filter((f) => f.severity === "critical" || f.severity === "warning")
    .sort((a, b) => {
      const ia = impactOrder[a.estimated_impact ?? "undefined"];
      const ib = impactOrder[b.estimated_impact ?? "undefined"];
      if (ia !== ib) return ia - ib;
      return severityOrder[a.severity] - severityOrder[b.severity];
    })
    .slice(0, 3)
    .map((f) => ({
      category: f.category,
      message: f.message,
      fix: f.fix,
      estimated_impact: f.estimated_impact,
    }));

  const topBlockerMessage =
    top_3_blockers.length > 0 ? top_3_blockers[0].message : "no critical blockers found";
  const one_line_summary = `AI assistants are ${will_ai_cite} to cite this page because ${topBlockerMessage.charAt(0).toLowerCase()}${topBlockerMessage.slice(1).replace(/\.$/, "")}.`;

  const citation_verdict: CitationVerdict = { will_ai_cite, top_3_blockers, one_line_summary };

  const output: AuditPageResult = {
    url: input.url,
    fetched_at,
    citation_verdict,
    findings: deduped,
    score,
    grade,
    dimension_scores: dimensionScores,
    content_quality: contentQuality,
  };

  if (input.include_raw_html) {
    output.raw_html = result.body;
  }

  if (input.generate_report) {
    output.report_html = renderScorecardHtml({
      url: input.url,
      fetched_at,
      score,
      grade,
      citation_verdict,
      dimension_scores: dimensionScores,
    });
  }

  return output;
}
