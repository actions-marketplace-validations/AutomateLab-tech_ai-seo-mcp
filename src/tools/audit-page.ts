// Tool: audit_page
// Full AI-SEO audit of a single URL. Runs all sub-audits and returns a composite score.

import { z } from "zod";
import { politeFetch, ToolFetchError, type HostDelayMap } from "../lib/fetch.js";
import type { RenderMode } from "../lib/cache.js";
import {
  parseHead,
  parseBody,
  analyzeImages,
  analyzeAnchors,
  analyzeHeadingHierarchy,
  analyzeReadability,
  titleH1Overlap,
} from "../lib/html.js";
import { parseJsonLd, getAllSchemaTypes, validateJsonLd } from "../lib/schema.js";
import { checkTechnical } from "./check-technical.js";
import { auditSchema } from "./audit-schema.js";
import { checkRobots } from "./check-robots.js";
import { checkSitemap } from "./check-sitemap.js";
import { scoreAiOverviewEligibility } from "./score-ai-overview-eligibility.js";
import {
  freshnessScore,
  deriveGrade,
  computeWeightedScore,
  applyVetoCaps,
  platformReadiness,
  type DimensionScores,
  type PlatformReadiness,
} from "../lib/score.js";
import { scoreCitability } from "../lib/score-citability.js";
import { scoreEvidence } from "../lib/score-evidence.js";
import { scoreEeatEntity } from "../lib/score-eeat.js";
import { scoreContent } from "../lib/score-content.js";
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
  render: z
    .enum(["static", "headless"])
    .optional()
    .default("static")
    .describe("Rendering mode. `static` (default) fetches raw HTML via HTTP — fast (<1s) but misses JS-rendered content typical of SPAs (React/Vue/Angular landing pages). `headless` spins up Playwright Chromium, waits for networkidle, and audits the rendered DOM — adds 3-10s per audit and requires `playwright-core` installed plus a one-time `npx playwright install chromium`. Use `headless` when the static audit shows `content_quality: \"spa_empty\"` or you know the target is JS-rendered."),
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
  dimension_scores: DimensionScores;
  /** Per-engine readiness derived from the dimension scores (engines reward different signals). */
  platform_readiness: PlatformReadiness;
  /** Hard blockers that capped the composite score (empty when none fired). */
  score_caps: string[];
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
  const renderMode: RenderMode = input.render ?? "static";

  // Fetch URL once
  const result = await politeFetch(input.url, {
    respectRobots: input.respect_robots,
    hostDelays,
    robotsCache,
    renderMode,
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
      robotsCache,
      renderMode
    );
    schemaScore = schemaResult.ai_citation_readiness_score;
    allFindings.push(...schemaResult.findings);
  } catch {
    // schema audit failed - use default score
  }

  // --- Technical dimension ---
  let technicalScore = 50;
  let noindex = false;
  try {
    const techResult = await checkTechnical(
      { url: input.url, respect_robots: input.respect_robots },
      hostDelays,
      robotsCache,
      renderMode
    );
    // Derive technical score from findings
    const techFindings = techResult.findings;
    allFindings.push(...techFindings);
    const criticals = techFindings.filter((f) => f.severity === "critical").length;
    const warnings = techFindings.filter((f) => f.severity === "warning").length;
    technicalScore = Math.max(0, 100 - criticals * 20 - warnings * 8);
    // noindex is a killer
    noindex = techResult.noindex;
    if (noindex) technicalScore = Math.max(0, technicalScore - 30);
  } catch {
    // technical audit failed
  }

  // --- Robots dimension ---
  let robotsScore = 70;
  let aiSearchBlocked = false;
  try {
    const hostname = new URL(input.url).hostname;
    const robotsResult = await checkRobots({ domain: hostname });
    const robotsFindings = robotsResult.findings.filter(
      (f) => f.severity === "critical" || f.severity === "warning"
    );
    allFindings.push(...robotsResult.findings);
    aiSearchBlocked =
      robotsResult.recommended_posture === "block_all" ||
      Object.values(robotsResult.search_crawlers).every((c) => c === "disallowed");
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

  // --- Body-level signals (v0.5): alt coverage, anchors, heading hierarchy, readability ---
  const imageStats = analyzeImages(result.body);
  const anchorStats = analyzeAnchors(result.body);
  const headingHierarchy = analyzeHeadingHierarchy(result.body);
  const readability = analyzeReadability(body.paragraphs);

  // --- Structure dimension ---
  const hasFaq = foundTypes.includes("FAQPage") || body.h3s.some((h) => h.endsWith("?"));
  const hasHowTo = foundTypes.includes("HowTo");
  const hasOrderedList = body.orderedLists > 0;
  const hasTable = body.tables > 0;
  const goodHeadings = body.h2s.length >= 2;
  const cleanHierarchy =
    headingHierarchy.skips.length === 0 && headingHierarchy.h1Count === 1;
  const altCoverage = imageStats.total === 0
    ? 1
    : imageStats.withMeaningfulAlt / imageStats.total;
  const goodAlts = altCoverage >= 0.7;
  const goodAnchors = anchorStats.total === 0
    ? true
    : anchorStats.lowQuality / anchorStats.total <= 0.1;
  const goodReadability =
    readability.totalWords > 0 && readability.longParagraphCount === 0;

  let structureScore = 10;
  if (hasFaq) structureScore += 25;
  if (hasHowTo) structureScore += 12;
  if (hasOrderedList) structureScore += 10;
  if (hasTable) structureScore += 8;
  if (goodHeadings) structureScore += 10;
  if (cleanHierarchy) structureScore += 10;
  if (goodAlts) structureScore += 8;
  if (goodAnchors) structureScore += 7;
  if (goodReadability) structureScore += 10;
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

  // Title vs H1 overlap
  const overlap = titleH1Overlap(head.title, body.h1s[0] ?? null);
  if (overlap !== null && overlap < 0.5) {
    allFindings.push({
      severity: "warning",
      category: "technical",
      where: "<title> vs <h1>",
      message: `Title and H1 share little overlap (${Math.round(overlap * 100)}%) - AI engines weigh the two together.`,
      fix: "Rewrite the H1 or <title> so both communicate the same primary topic. Allow brand/separator differences only.",
      estimated_impact: "medium",
    });
  }

  // Heading hierarchy
  if (headingHierarchy.h1Count === 0) {
    allFindings.push({
      severity: "critical",
      category: "structure",
      where: "<body>",
      message: "Page has no H1 heading.",
      fix: "Add a single H1 that names the page topic; AI assistants use H1 as the canonical document title.",
      estimated_impact: "high",
    });
  } else if (headingHierarchy.h1Count > 1) {
    allFindings.push({
      severity: "warning",
      category: "structure",
      where: "<body>",
      message: `Page has ${headingHierarchy.h1Count} H1 headings (should be exactly one).`,
      fix: "Keep one H1 (the page title) and demote duplicates to H2.",
      estimated_impact: "medium",
    });
  }
  if (headingHierarchy.skips.length > 0) {
    const s = headingHierarchy.skips[0];
    allFindings.push({
      severity: "warning",
      category: "structure",
      where: "<body>",
      message: `Heading hierarchy skips levels (${headingHierarchy.skips.length} skip${headingHierarchy.skips.length === 1 ? "" : "s"}; e.g. h${s.from} to h${s.to} near "${s.nearText}").`,
      fix: "Use heading levels in order (h1 -> h2 -> h3) so AI parsers and assistive tech can follow the outline.",
      estimated_impact: "low",
    });
  }

  // Image alt coverage
  if (imageStats.total > 0) {
    if (altCoverage < 0.5) {
      allFindings.push({
        severity: "warning",
        category: "structure",
        where: "<img>",
        message: `Only ${Math.round(altCoverage * 100)}% of images have meaningful alt text (${imageStats.withMeaningfulAlt}/${imageStats.total}).`,
        fix: 'Add descriptive alt="..." to content images. Use alt="" only for purely decorative images.',
        estimated_impact: "medium",
      });
    } else if (altCoverage < 0.8) {
      allFindings.push({
        severity: "info",
        category: "structure",
        where: "<img>",
        message: `${Math.round(altCoverage * 100)}% of images have meaningful alt text (${imageStats.withMeaningfulAlt}/${imageStats.total}).`,
        fix: "Lift alt coverage above 80% to give vision-impaired and AI crawlers full image context.",
      });
    }
  }

  // Anchor text quality
  if (anchorStats.total > 0) {
    const badPct = anchorStats.lowQuality / anchorStats.total;
    if (anchorStats.lowQuality >= 3 || badPct > 0.15) {
      const sample = anchorStats.lowQualitySamples
        .map((s) => `"${s.text}"`)
        .slice(0, 3)
        .join(", ");
      allFindings.push({
        severity: "info",
        category: "structure",
        where: "<a>",
        message: `${anchorStats.lowQuality} anchor${anchorStats.lowQuality === 1 ? " uses" : "s use"} generic text (${sample}).`,
        fix: "Replace generic anchors with descriptive phrases that name the destination (e.g. 'AI-SEO checker' instead of 'click here').",
      });
    }
  }

  // Readability
  if (readability.totalWords > 100) {
    if (readability.longParagraphCount >= 2 || readability.longSentenceCount >= 5) {
      allFindings.push({
        severity: "info",
        category: "structure",
        where: "page-level",
        message: `Long content: ${readability.longSentenceCount} sentence(s) > 30 words, ${readability.longParagraphCount} paragraph(s) > 120 words (avg ${readability.avgWordsPerSentence} words/sentence).`,
        fix: "Break long paragraphs into 2-4 sentence chunks and split long sentences. AI assistants cite shorter passages more reliably.",
      });
    }
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
  const baseEntityDensity = Math.min(100, (sameAsCount + authExternalLinks) * 7);

  // --- Citation / evidence / trust / entity / content dimensions (GEO) ---
  const citabilityRes = scoreCitability(result.body);
  allFindings.push(...citabilityRes.findings);

  const evidenceRes = scoreEvidence(result.body, body.bodyText, body.externalLinks, body.wordCount);
  allFindings.push(...evidenceRes.findings);

  const eeatRes = scoreEeatEntity({
    html: result.body,
    url: input.url,
    foundTypes,
    jsonLdBlocks,
    internalLinks: body.internalLinks,
    externalLinks: body.externalLinks,
  });
  allFindings.push(...eeatRes.findings);

  const contentRes = scoreContent(body.bodyText, body.wordCount);
  allFindings.push(...contentRes.findings);

  // Entity density blends the raw link-count proxy with the structured-entity score.
  const entityDensityScore = Math.round((baseEntityDensity + eeatRes.entity_score) / 2);

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
  const dimensionScores: DimensionScores = {
    schema: schemaScore,
    robots: robotsScore,
    technical: technicalScore,
    freshness: freshnessScoreVal,
    structure: structureScore,
    authority: authorityScore,
    entity_density: entityDensityScore,
    sitemap: sitemapScore,
    citability: citabilityRes.score,
    evidence: evidenceRes.score,
    trust: eeatRes.trust_score,
  };

  const scriptCount = countScriptTags(result.body);
  const contentQuality = detectContentQuality(body.bodyText, scriptCount);
  if (contentQuality === "spa_empty" && renderMode === "static") {
    allFindings.push({
      severity: "critical",
      category: "technical",
      where: "<body>",
      message: "Page appears to be a JS-rendered SPA (low body text, many script tags); audit results are likely incomplete.",
      fix: "Re-run audit_page with render: 'headless' to capture the rendered DOM, or serve SSR/prerendered HTML so AI crawlers without JS see real content.",
      estimated_impact: "high",
    });
  } else if (contentQuality === "spa_empty" && renderMode === "headless") {
    allFindings.push({
      severity: "critical",
      category: "technical",
      where: "<body>",
      message: "Even with headless rendering the page body has little extractable text — the SPA may render content lazily or behind interaction.",
      fix: "Serve SSR/prerendered HTML; AI crawlers (and audit_page even with render=headless) cannot reliably trigger lazy/interaction-gated content.",
      estimated_impact: "high",
    });
  }

  const rawScore = computeWeightedScore(dimensionScores);

  // --- Veto caps: hard blockers that make the page uncitable regardless of the
  // other dimensions cap the composite at grade-C ceiling. ---
  const isHttps = (() => {
    try { return new URL(input.url).protocol === "https:"; } catch { return false; }
  })();
  const vetoes: string[] = [];
  if (noindex) vetoes.push("Page is noindex — excluded from search and AI indexes.");
  if (aiSearchBlocked) vetoes.push("AI search crawlers are blocked in robots.txt — engines can't read the page to cite it.");
  if (contentQuality === "spa_empty") vetoes.push("Content is JS-only (SPA) — crawlers without JS see an empty page.");
  if (!isHttps) vetoes.push("Served over HTTP, not HTTPS.");
  const veto = applyVetoCaps(rawScore, vetoes);
  const score = veto.score;
  const grade = deriveGrade(score);
  const platform_readiness = platformReadiness(dimensionScores);

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
    platform_readiness,
    score_caps: veto.reasons,
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
