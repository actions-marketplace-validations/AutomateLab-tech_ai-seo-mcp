// Tool: audit_site
// Single-call aggregator: audit_page (homepage) + check_robots + check_sitemap + audit_schema.
// Returns a unified overall_grade and top_5_fixes for users who don't want the 13-tool buffet.

import { z } from "zod";
import { auditPage, type AuditPageResult } from "./audit-page.js";
import { checkRobots, type RobotsResult } from "./check-robots.js";
import { checkSitemap, type SitemapResult } from "./check-sitemap.js";
import { auditSchema, type AuditSchemaResult } from "./audit-schema.js";
import { deriveGrade } from "../lib/score.js";
import type { Finding } from "../types.js";

export const auditSiteInputSchema = z.object({
  domain: z
    .string()
    .min(3)
    .describe("Hostname or origin to audit. Examples: `example.com`, `https://example.com`. The tool resolves the homepage and runs audit_page + check_robots + check_sitemap + audit_schema in parallel against it, then returns an overall grade plus top-5 fixes. Issues several HTTP GETs against the domain."),
  respect_robots: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true (default), respect robots.txt before fetching the homepage. Set false ONLY to audit a site you own that has temporarily blocked crawlers."),
});

export type AuditSiteInput = z.infer<typeof auditSiteInputSchema>;

export interface AuditSiteResult {
  domain: string;
  homepage_url: string;
  fetched_at: string;
  overall_score: number;
  overall_grade: "A" | "B" | "C" | "D" | "F";
  top_5_fixes: Finding[];
  parts: {
    audit_page: AuditPageResult | { error: string };
    check_robots: RobotsResult | { error: string };
    check_sitemap: SitemapResult | { error: string };
    audit_schema: AuditSchemaResult | { error: string };
  };
}

function normalizeDomain(input: string): { hostname: string; homepageUrl: string } {
  let host = input.trim();
  if (host.startsWith("http://") || host.startsWith("https://")) {
    try {
      const u = new URL(host);
      return { hostname: u.hostname, homepageUrl: `${u.protocol}//${u.hostname}/` };
    } catch {
      // fall through to plain-domain handling
    }
  }
  host = host.replace(/\/$/, "");
  return { hostname: host, homepageUrl: `https://${host}/` };
}

function severityRank(s: Finding["severity"]): number {
  return s === "critical" ? 0 : s === "warning" ? 1 : 2;
}

function impactRank(i?: Finding["estimated_impact"]): number {
  return i === "high" ? 0 : i === "medium" ? 1 : i === "low" ? 2 : 3;
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.severity}:${f.category}:${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export async function auditSite(input: AuditSiteInput): Promise<AuditSiteResult> {
  const { hostname, homepageUrl } = normalizeDomain(input.domain);
  const fetched_at = new Date().toISOString();

  // Fan out the four checks in parallel. The fetch cache de-duplicates the homepage GET
  // across audit_page / audit_schema, so this is roughly 4 logical calls but ~2 network fetches.
  const [pageRes, robotsRes, sitemapRes, schemaRes] = await Promise.allSettled([
    auditPage({
      url: homepageUrl,
      include_raw_html: false,
      respect_robots: input.respect_robots,
      generate_report: false,
      render: "static",
    }),
    checkRobots({ domain: hostname }),
    checkSitemap({ domain: hostname, max_urls_to_check: 50 }),
    auditSchema({ url: homepageUrl, respect_robots: input.respect_robots }),
  ]);

  const allFindings: Finding[] = [];

  const partPage =
    pageRes.status === "fulfilled"
      ? pageRes.value
      : { error: pageRes.reason instanceof Error ? pageRes.reason.message : String(pageRes.reason) };
  if (pageRes.status === "fulfilled") {
    allFindings.push(...pageRes.value.findings);
  }

  const partRobots =
    robotsRes.status === "fulfilled"
      ? robotsRes.value
      : { error: robotsRes.reason instanceof Error ? robotsRes.reason.message : String(robotsRes.reason) };
  if (robotsRes.status === "fulfilled") {
    allFindings.push(...robotsRes.value.findings);
  }

  const partSitemap =
    sitemapRes.status === "fulfilled"
      ? sitemapRes.value
      : { error: sitemapRes.reason instanceof Error ? sitemapRes.reason.message : String(sitemapRes.reason) };
  if (sitemapRes.status === "fulfilled") {
    allFindings.push(...sitemapRes.value.findings);
  }

  const partSchema =
    schemaRes.status === "fulfilled"
      ? schemaRes.value
      : { error: schemaRes.reason instanceof Error ? schemaRes.reason.message : String(schemaRes.reason) };
  if (schemaRes.status === "fulfilled") {
    allFindings.push(...schemaRes.value.findings);
  }

  // The composite score: audit_page is already a weighted composite — anchor on it.
  // If audit_page failed, fall back to 50 (mirrors per-dimension defaults inside audit_page).
  const overall_score =
    pageRes.status === "fulfilled" ? pageRes.value.score : 50;
  const overall_grade = deriveGrade(overall_score);

  const sorted = dedupeFindings(allFindings).sort((a, b) => {
    const sev = severityRank(a.severity) - severityRank(b.severity);
    if (sev !== 0) return sev;
    return impactRank(a.estimated_impact) - impactRank(b.estimated_impact);
  });

  return {
    domain: hostname,
    homepage_url: homepageUrl,
    fetched_at,
    overall_score,
    overall_grade,
    top_5_fixes: sorted.slice(0, 5),
    parts: {
      audit_page: partPage,
      check_robots: partRobots,
      check_sitemap: partSitemap,
      audit_schema: partSchema,
    },
  };
}
