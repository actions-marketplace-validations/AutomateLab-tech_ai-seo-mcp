// Tool: score_ai_overview_eligibility
// Scores a page's probability of appearing in Google AI Overviews using correlation factors.

import { z } from "zod";
import { politeFetch, type HostDelayMap } from "../lib/fetch.js";
import { parseHead, parseBody } from "../lib/html.js";
import { parseJsonLd, getAllSchemaTypes } from "../lib/schema.js";
import { freshnessScore } from "../lib/score.js";
import type { Finding } from "../types.js";

export const scoreAiOverviewEligibilityInputSchema = z.object({
  url: z
    .string()
    .url()
    .describe("Public URL to score. The tool fetches the URL once and runs deterministic, rule-based scoring across six factors (semantic completeness, structured data, E-E-A-T signals, entity density, freshness, technical hygiene) using published 2025-2026 correlation studies. No LLM calls. Read-only HTTP GET."),
  respect_robots: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true (default), respect robots.txt before fetching. Set false only for auditing your own site where you've intentionally blocked crawlers."),
});

export type ScoreAiOverviewEligibilityInput = z.infer<typeof scoreAiOverviewEligibilityInputSchema>;

export interface AiOverviewEligibilityResult {
  url: string;
  overall_eligibility_score: number;
  factors: {
    semantic_completeness: number;
    structured_data: number;
    eeat_signals: number;
    entity_density: number;
    content_freshness: number;
    passage_structure: number;
    multimodal_content: number;
  };
  top_improvements: Array<{ action: string; estimated_score_gain: number }>;
  findings: Finding[];
}

export async function scoreAiOverviewEligibility(
  input: ScoreAiOverviewEligibilityInput,
  hostDelays?: HostDelayMap,
  robotsCache?: Map<string, string>
): Promise<AiOverviewEligibilityResult> {
  const result = await politeFetch(input.url, {
    respectRobots: input.respect_robots,
    hostDelays,
    robotsCache,
  });

  const head = parseHead(result.body);
  const body = parseBody(result.body, input.url);
  const jsonLdBlocks = parseJsonLd(result.body);
  const foundTypes = getAllSchemaTypes(jsonLdBlocks);
  const findings: Finding[] = [];

  // 1. Semantic completeness - count paragraphs with 100-200 words
  const selfContainedBlocks = body.paragraphs.filter((p) => {
    const words = p.split(/\s+/).filter((w) => w.length > 0);
    return words.length >= 100 && words.length <= 200;
  });
  const semantic_completeness = Math.min(100, selfContainedBlocks.length * 25);

  // 2. Structured data presence - tier 1 types
  const tier1Types = ["FAQPage", "HowTo", "Article", "BlogPosting", "NewsArticle", "Organization"];
  const tier1Found = tier1Types.filter((t) => foundTypes.includes(t));
  const structured_data = Math.min(100, tier1Found.length * 25);

  // 3. E-E-A-T signals: author Person, Organization, sameAs
  let eeatScore = 30; // base
  const hasOrg = foundTypes.includes("Organization");
  const hasPerson = jsonLdBlocks.some((b) => b.types.includes("Person"));
  const hasSameAs = jsonLdBlocks.some((b) => {
    const sa = b.parsed["sameAs"];
    return Array.isArray(sa) ? sa.length > 0 : !!sa;
  });
  const hasArticleWithAuthorNode = jsonLdBlocks.some((b) =>
    b.types.some((t) => ["Article", "BlogPosting", "NewsArticle"].includes(t)) &&
    typeof b.parsed["author"] === "object" &&
    b.parsed["author"] !== null
  );
  if (hasOrg) eeatScore += 20;
  if (hasPerson) eeatScore += 20;
  if (hasSameAs) eeatScore += 15;
  if (hasArticleWithAuthorNode) eeatScore += 15;
  const eeat_signals = Math.min(100, eeatScore);

  // 4. Entity density - sameAs links + authoritative external hrefs
  const authoritativeDomains = [
    "wikipedia.org", "wikidata.org", ".gov", "linkedin.com", "twitter.com",
    "x.com", "crunchbase.com", "bloomberg.com", "reuters.com",
  ];
  const sameAsCount = jsonLdBlocks.reduce((acc, b) => {
    const sa = b.parsed["sameAs"];
    return acc + (Array.isArray(sa) ? sa.length : sa ? 1 : 0);
  }, 0);
  const authExternalLinks = body.externalLinks.filter((href) =>
    authoritativeDomains.some((d) => href.includes(d))
  ).length;
  const entity_density = Math.min(100, (sameAsCount + authExternalLinks) * 7);

  // 5. Content freshness - from JSON-LD dateModified
  let dateModified: string | null = null;
  for (const b of jsonLdBlocks) {
    const dm = b.parsed["dateModified"] ?? b.parsed["datePublished"];
    if (typeof dm === "string") {
      dateModified = dm;
      break;
    }
  }
  const content_freshness = freshnessScore(dateModified);

  // 6. Passage structure - FAQ, comparison table, ordered list
  const hasH3Questions = body.h3s.some((h) => h.endsWith("?"));
  const hasFaqSchema = foundTypes.includes("FAQPage");
  const hasFaq = hasH3Questions || hasFaqSchema;
  const hasComparisonTable = body.tables > 0;
  const hasOrderedList = body.orderedLists > 0;
  let passage_structure = 0;
  if (hasFaq) passage_structure += 25;
  if (hasComparisonTable) passage_structure += 25;
  if (hasOrderedList) passage_structure += 25;
  if (body.h2s.length >= 3) passage_structure += 25; // good heading structure
  passage_structure = Math.min(100, passage_structure);

  // 7. Multimodal content
  let multimodal = 0;
  if (body.images > 0) multimodal += 30;
  if (body.videos > 0) multimodal += 30;
  if (foundTypes.includes("ImageObject")) multimodal += 20;
  if (foundTypes.includes("VideoObject")) multimodal += 20;
  const multimodal_content = Math.min(100, multimodal);

  // Weighted score per spec:
  // semantic_completeness 25%, structured_data 25%, passage_structure 20%,
  // eeat_signals 15%, entity_density 10%, content_freshness 3%, multimodal_content 2%
  const overall_eligibility_score = Math.round(
    semantic_completeness * 0.25 +
    structured_data * 0.25 +
    passage_structure * 0.20 +
    eeat_signals * 0.15 +
    entity_density * 0.10 +
    content_freshness * 0.03 +
    multimodal_content * 0.02
  );

  // Top improvements
  const improvements: Array<{ action: string; estimated_score_gain: number }> = [];

  if (!hasFaqSchema) {
    improvements.push({
      action: "Add FAQPage JSON-LD schema with 3-5 Q&A pairs targeting sub-queries",
      estimated_score_gain: Math.round(25 * 0.25 + 25 * 0.20), // structured_data + passage_structure
    });
  }
  if (!hasArticleWithAuthorNode) {
    improvements.push({
      action: "Add Article JSON-LD with author as a Person node including sameAs links",
      estimated_score_gain: Math.round(15 * 0.15),
    });
  }
  if (!hasComparisonTable) {
    improvements.push({
      action: "Add a comparison table or step-by-step list to improve passage structure",
      estimated_score_gain: Math.round(25 * 0.20),
    });
  }
  if (semantic_completeness < 50) {
    improvements.push({
      action: "Expand body paragraphs to 100-200 words each for self-contained answer blocks",
      estimated_score_gain: Math.round(50 * 0.25),
    });
  }

  improvements.sort((a, b) => b.estimated_score_gain - a.estimated_score_gain);
  const top_improvements = improvements.slice(0, 3);

  // Key findings
  if (!hasFaqSchema && !hasH3Questions) {
    findings.push({
      severity: "warning",
      category: "structure",
      where: "page-level",
      message: "No FAQ structure found (no FAQPage schema and no H3 questions).",
      fix: "Add FAQ H3 headings ending in '?' with answer paragraphs, plus FAQPage JSON-LD.",
      estimated_impact: "high",
    });
  }
  if (eeat_signals < 50) {
    findings.push({
      severity: "warning",
      category: "authority",
      where: "page-level",
      message: "Weak E-E-A-T signals - no Organization or author Person schema found.",
      fix: "Add Organization JSON-LD to site-wide head, and Article.author as a Person node.",
      estimated_impact: "high",
    });
  }
  if (content_freshness < 50 && dateModified) {
    findings.push({
      severity: "warning",
      category: "freshness",
      where: "Article.dateModified",
      message: "Content appears stale (dateModified > 90 days ago).",
      fix: "Update the page content and set dateModified to today in the Article JSON-LD.",
      estimated_impact: "medium",
    });
  }

  return {
    url: input.url,
    overall_eligibility_score,
    factors: {
      semantic_completeness,
      structured_data,
      eeat_signals,
      entity_density,
      content_freshness,
      passage_structure,
      multimodal_content,
    },
    top_improvements,
    findings,
  };
}
