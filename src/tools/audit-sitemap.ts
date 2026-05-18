// Tool: audit_sitemap
// Site-wide aggregation: discover the sitemap, sample N URLs by uniform stride,
// run audit_page on each, then return distribution stats + worst pages + most-common findings.
//
// Distinct from check_sitemap (which validates the sitemap.xml itself) — this audits
// the content the sitemap lists.

import { z } from "zod";
import { politeFetch } from "../lib/fetch.js";
import { fetchRobotsTxt } from "../lib/robots.js";
import { XMLParser } from "fast-xml-parser";
import { auditPage, type AuditPageResult } from "./audit-page.js";
import type { Finding } from "../types.js";

export const auditSitemapInputSchema = z.object({
  domain: z
    .string()
    .min(3)
    .describe(
      "Hostname or origin to audit. Examples: `example.com`, `https://example.com`. The tool discovers the sitemap, samples N URLs by uniform stride, and runs audit_page on each."
    ),
  sample_size: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe(
      "Number of URLs to sample from the sitemap. Default 10. Max 50 (sampling caps to avoid runaway audits — each sample is one full audit_page call, ~1-3s with polite throttling). Sampling is deterministic uniform-stride: if the sitemap has 1000 URLs and sample_size=10, every 100th URL is picked."
    ),
  respect_robots: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "If true (default), respect robots.txt for each sampled URL. Set false only for self-audits where you've intentionally blocked crawlers."
    ),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .default(2)
    .describe(
      "Parallel audit_page calls. Default 2 (gentle). Max 5. The shared politeFetch host-delay is still enforced, so this is per-batch dispatch concurrency, not bypass."
    ),
});

export type AuditSitemapInput = z.infer<typeof auditSitemapInputSchema>;

export interface PerPageAudit {
  url: string;
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  top_issue: string | null;
}

export interface AuditSitemapResult {
  domain: string;
  sitemap_url: string | null;
  total_urls_in_sitemap: number;
  urls_sampled: number;
  sampling: "uniform_stride";
  /** Audits that completed successfully. */
  audited: PerPageAudit[];
  /** URL → error message for audits that failed. */
  failed: Array<{ url: string; error: string }>;
  score_distribution: {
    avg: number;
    median: number;
    min: number;
    max: number;
    p25: number;
    p75: number;
  };
  grade_distribution: { A: number; B: number; C: number; D: number; F: number };
  worst_pages: PerPageAudit[];
  /** Top findings aggregated across all sampled pages, sorted by occurrence count desc. */
  top_findings: Array<{ message: string; category: string; severity: Finding["severity"]; count: number; fix: string }>;
  fetched_at: string;
}

function normalizeDomain(domain: string): string {
  if (domain.startsWith("http://") || domain.startsWith("https://")) {
    try {
      return new URL(domain).hostname;
    } catch {
      return domain;
    }
  }
  return domain.replace(/\/$/, "");
}

interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

async function fetchSitemapXml(hostname: string): Promise<{ url: string | null; xml: string | null }> {
  const candidates = [`https://${hostname}/sitemap.xml`, `https://${hostname}/sitemap_index.xml`];
  const robotsText = await fetchRobotsTxt(`https://${hostname}/robots.txt`);
  if (robotsText) {
    const sitemapMatch = robotsText.match(/^Sitemap:\s*(.+)$/im);
    if (sitemapMatch && sitemapMatch[1]) {
      const robotsSitemapUrl = sitemapMatch[1].trim();
      if (!candidates.includes(robotsSitemapUrl)) candidates.unshift(robotsSitemapUrl);
    }
  }

  for (const candidate of candidates) {
    try {
      const res = await politeFetch(candidate, { respectRobots: false });
      if (res.statusCode === 200) {
        return { url: candidate, xml: res.body };
      }
    } catch {
      // try next
    }
  }
  return { url: null, xml: null };
}

function parseSitemapEntries(xml: string): { entries: SitemapEntry[]; childSitemaps: string[] } {
  const parser = new XMLParser({ ignoreAttributes: false });
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return { entries: [], childSitemaps: [] };
  }

  const sitemapIndex = parsed["sitemapindex"] as Record<string, unknown> | undefined;
  if (sitemapIndex) {
    const sitemaps = sitemapIndex["sitemap"];
    const list: Array<Record<string, unknown>> = Array.isArray(sitemaps)
      ? (sitemaps as Array<Record<string, unknown>>)
      : sitemaps
      ? [sitemaps as Record<string, unknown>]
      : [];
    return { entries: [], childSitemaps: list.map((s) => String(s["loc"] ?? "")).filter(Boolean) };
  }

  const urlset = parsed["urlset"] as Record<string, unknown> | undefined;
  if (!urlset) return { entries: [], childSitemaps: [] };

  const urlEntries = urlset["url"];
  const list: Array<Record<string, unknown>> = Array.isArray(urlEntries)
    ? (urlEntries as Array<Record<string, unknown>>)
    : urlEntries
    ? [urlEntries as Record<string, unknown>]
    : [];

  return {
    entries: list.map((u) => ({
      loc: String(u["loc"] ?? ""),
      lastmod: u["lastmod"] ? String(u["lastmod"]) : undefined,
    })),
    childSitemaps: [],
  };
}

/** Uniform-stride sampling — deterministic, representative. */
function strideSample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items.slice();
  const stride = items.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(i * stride);
    if (items[idx] !== undefined) out.push(items[idx]!);
  }
  return out;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.max(0, Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length)));
  return sortedAsc[idx] ?? 0;
}

function median(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 === 0
    ? Math.round(((sortedAsc[mid - 1] ?? 0) + (sortedAsc[mid] ?? 0)) / 2)
    : sortedAsc[mid] ?? 0;
}

async function runInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

export async function auditSitemap(input: AuditSitemapInput): Promise<AuditSitemapResult> {
  const hostname = normalizeDomain(input.domain);
  const fetched_at = new Date().toISOString();

  const { url: sitemapUrl, xml } = await fetchSitemapXml(hostname);
  if (!sitemapUrl || !xml) {
    return {
      domain: hostname,
      sitemap_url: null,
      total_urls_in_sitemap: 0,
      urls_sampled: 0,
      sampling: "uniform_stride",
      audited: [],
      failed: [],
      score_distribution: { avg: 0, median: 0, min: 0, max: 0, p25: 0, p75: 0 },
      grade_distribution: { A: 0, B: 0, C: 0, D: 0, F: 0 },
      worst_pages: [],
      top_findings: [],
      fetched_at,
    };
  }

  // Flatten one level of sitemap index.
  let allEntries: SitemapEntry[] = [];
  const { entries, childSitemaps } = parseSitemapEntries(xml);
  allEntries.push(...entries);
  if (childSitemaps.length > 0) {
    for (const childUrl of childSitemaps.slice(0, 5)) {
      try {
        const res = await politeFetch(childUrl, { respectRobots: false });
        const { entries: childEntries } = parseSitemapEntries(res.body);
        allEntries.push(...childEntries);
        if (allEntries.length >= 1000) break;
      } catch {
        // skip
      }
    }
  }

  const sampled = strideSample(allEntries, input.sample_size).map((e) => e.loc).filter(Boolean);

  // Run audits in batches.
  type AuditOutcome =
    | { ok: true; url: string; result: AuditPageResult }
    | { ok: false; url: string; error: string };

  const outcomes = await runInBatches<string, AuditOutcome>(
    sampled,
    input.concurrency,
    async (url): Promise<AuditOutcome> => {
      try {
        const result = await auditPage({
          url,
          include_raw_html: false,
          respect_robots: input.respect_robots,
          generate_report: false,
          render: "static",
        });
        return { ok: true, url, result };
      } catch (err) {
        return { ok: false, url, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  const audited: PerPageAudit[] = [];
  const failed: Array<{ url: string; error: string }> = [];
  const findingTally = new Map<string, { count: number; finding: Finding }>();

  for (const o of outcomes) {
    if (!o.ok) {
      failed.push({ url: o.url, error: o.error });
      continue;
    }
    const topFinding = o.result.findings.find(
      (f) => f.severity === "critical" || f.severity === "warning"
    );
    audited.push({
      url: o.url,
      score: o.result.score,
      grade: o.result.grade,
      top_issue: topFinding?.message ?? null,
    });
    for (const f of o.result.findings) {
      if (f.severity === "info") continue;
      const key = `${f.severity}|${f.category}|${f.message}`;
      const existing = findingTally.get(key);
      if (existing) existing.count++;
      else findingTally.set(key, { count: 1, finding: f });
    }
  }

  const scores = audited.map((a) => a.score).sort((a, b) => a - b);
  const avg = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

  const gradeDist = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const a of audited) gradeDist[a.grade]++;

  const worst = [...audited].sort((a, b) => a.score - b.score).slice(0, 5);

  const topFindings = Array.from(findingTally.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map(({ count, finding }) => ({
      message: finding.message,
      category: finding.category,
      severity: finding.severity,
      count,
      fix: finding.fix,
    }));

  return {
    domain: hostname,
    sitemap_url: sitemapUrl,
    total_urls_in_sitemap: allEntries.length,
    urls_sampled: sampled.length,
    sampling: "uniform_stride",
    audited,
    failed,
    score_distribution: {
      avg,
      median: median(scores),
      min: scores[0] ?? 0,
      max: scores[scores.length - 1] ?? 0,
      p25: percentile(scores, 25),
      p75: percentile(scores, 75),
    },
    grade_distribution: gradeDist,
    worst_pages: worst,
    top_findings: topFindings,
    fetched_at,
  };
}
