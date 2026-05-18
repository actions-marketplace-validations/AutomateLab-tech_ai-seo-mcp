// Tool: diff_pages
// Compares two URLs (e.g. user's page vs competitor) and returns a structured
// breakdown of why one is more citation-worthy than the other.

import { z } from "zod";
import { auditPage } from "./audit-page.js";
import type { Finding } from "../types.js";

export const diffPagesInputSchema = z.object({
  url_a: z
    .string()
    .url()
    .describe(
      "First URL to compare - typically your own page. Must be a fully-qualified http(s) URL that returns HTTP 200 (redirects are followed)."
    ),
  url_b: z
    .string()
    .url()
    .describe(
      "Second URL to compare - typically a competitor's page. Must be a fully-qualified http(s) URL that returns HTTP 200 (redirects are followed)."
    ),
  query: z
    .string()
    .optional()
    .describe(
      "Optional target search query both pages are competing for (e.g. 'how to connect Zapier to Notion'). When provided, it is surfaced in fix_recommendations_for_a as context. Does not alter the scoring algorithm - scoring is based on audit_page's existing rubric."
    ),
  respect_robots: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "If true (default), respect robots.txt before fetching each URL. Set false only when auditing your own sites where you have intentionally blocked crawlers."
    ),
});

export type DiffPagesInput = z.infer<typeof diffPagesInputSchema>;

export interface DimensionDiff {
  a: number;
  b: number;
  /** Which URL has the higher score for this dimension, or 'tie' if equal. */
  advantage: "a" | "b" | "tie";
}

export interface DiffPagesResult {
  url_a: string;
  url_b: string;
  query?: string;
  /** Which URL is more citation-worthy overall, or 'tie' if within 5 points. */
  better_for_citation: "a" | "b" | "tie";
  scores: { a: number; b: number };
  delta: {
    schema: DimensionDiff;
    structure: DimensionDiff;
    robots: DimensionDiff;
    entity_density: DimensionDiff;
    freshness: DimensionDiff;
    technical: DimensionDiff;
    authority: DimensionDiff;
    sitemap: DimensionDiff;
  };
  /** Categories (or entities) present on B but absent from A's findings (A is missing these). */
  missing_in_a: string[];
  /** Categories (or entities) present on A but absent from B's findings (B is missing these). */
  missing_in_b: string[];
  /** Prioritized, actionable recommendations for improving URL A's citation probability. */
  fix_recommendations_for_a: Array<{
    category: string;
    message: string;
    fix: string;
    estimated_impact?: "high" | "medium" | "low";
  }>;
}

/** Return "a", "b", or "tie" based on score values (tie within 5 points). */
function advantage(aScore: number, bScore: number): "a" | "b" | "tie" {
  if (Math.abs(aScore - bScore) <= 5) return "tie";
  return aScore > bScore ? "a" : "b";
}

/** Derive missing_in_a and missing_in_b by comparing findings categories. */
function deriveMissing(findingsA: Finding[], findingsB: Finding[]): { missingInA: string[]; missingInB: string[] } {
  const categoriesInA = new Set(
    findingsA.filter((f) => f.severity === "critical" || f.severity === "warning").map((f) => f.category)
  );
  const categoriesInB = new Set(
    findingsB.filter((f) => f.severity === "critical" || f.severity === "warning").map((f) => f.category)
  );

  // Collect distinct finding messages in each set to surface actionable gaps
  const messagesInA = new Set(
    findingsA.filter((f) => f.severity === "critical" || f.severity === "warning").map((f) => f.message)
  );
  const messagesInB = new Set(
    findingsB.filter((f) => f.severity === "critical" || f.severity === "warning").map((f) => f.message)
  );

  // missing_in_a: findings B has (problems B solved that A hasn't addressed) - i.e. categories B has clean that A doesn't
  // Cleaner interpretation: dimensions where B scores higher represent gaps A has
  const missingInA: string[] = [];
  for (const msg of messagesInB) {
    if (!messagesInA.has(msg)) {
      missingInA.push(msg);
    }
  }

  const missingInB: string[] = [];
  for (const msg of messagesInA) {
    if (!messagesInB.has(msg)) {
      missingInB.push(msg);
    }
  }

  // If no message-level gaps, fall back to category-level gaps
  if (missingInA.length === 0) {
    for (const cat of categoriesInB) {
      if (!categoriesInA.has(cat)) missingInA.push(`${cat} issues (present on B but not A)`);
    }
  }
  if (missingInB.length === 0) {
    for (const cat of categoriesInA) {
      if (!categoriesInB.has(cat)) missingInB.push(`${cat} issues (present on A but not B)`);
    }
  }

  return { missingInA, missingInB };
}

export async function diffPages(input: DiffPagesInput): Promise<DiffPagesResult> {
  // Run both audits in parallel
  const [resultA, resultB] = await Promise.all([
    auditPage({ url: input.url_a, include_raw_html: false, generate_report: false, respect_robots: input.respect_robots, render: "static" }),
    auditPage({ url: input.url_b, include_raw_html: false, generate_report: false, respect_robots: input.respect_robots, render: "static" }),
  ]);

  const dimA = resultA.dimension_scores;
  const dimB = resultB.dimension_scores;

  const delta: DiffPagesResult["delta"] = {
    schema:         { a: dimA.schema,         b: dimB.schema,         advantage: advantage(dimA.schema,         dimB.schema)         },
    structure:      { a: dimA.structure,       b: dimB.structure,      advantage: advantage(dimA.structure,      dimB.structure)      },
    robots:         { a: dimA.robots,          b: dimB.robots,         advantage: advantage(dimA.robots,         dimB.robots)         },
    entity_density: { a: dimA.entity_density,  b: dimB.entity_density, advantage: advantage(dimA.entity_density, dimB.entity_density) },
    freshness:      { a: dimA.freshness,       b: dimB.freshness,      advantage: advantage(dimA.freshness,      dimB.freshness)      },
    technical:      { a: dimA.technical,       b: dimB.technical,      advantage: advantage(dimA.technical,      dimB.technical)      },
    authority:      { a: dimA.authority,       b: dimB.authority,      advantage: advantage(dimA.authority,      dimB.authority)      },
    sitemap:        { a: dimA.sitemap,         b: dimB.sitemap,        advantage: advantage(dimA.sitemap,        dimB.sitemap)        },
  };

  const overallAdvantage = advantage(resultA.score, resultB.score);

  const { missingInA, missingInB } = deriveMissing(resultA.findings, resultB.findings);

  // fix_recommendations_for_a: A's own critical + warning findings, sorted by impact
  const impactOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  const recsForA = [...resultA.findings]
    .filter((f) => f.severity === "critical" || f.severity === "warning")
    .sort((a, b) => {
      const ia = impactOrder[a.estimated_impact ?? "low"] ?? 2;
      const ib = impactOrder[b.estimated_impact ?? "low"] ?? 2;
      if (ia !== ib) return ia - ib;
      return (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2);
    })
    .map((f) => ({
      category: f.category,
      message: f.message,
      fix: f.fix,
      estimated_impact: f.estimated_impact,
    }));

  const output: DiffPagesResult = {
    url_a: input.url_a,
    url_b: input.url_b,
    better_for_citation: overallAdvantage,
    scores: { a: resultA.score, b: resultB.score },
    delta,
    missing_in_a: missingInA,
    missing_in_b: missingInB,
    fix_recommendations_for_a: recsForA,
  };

  if (input.query) {
    output.query = input.query;
  }

  return output;
}
