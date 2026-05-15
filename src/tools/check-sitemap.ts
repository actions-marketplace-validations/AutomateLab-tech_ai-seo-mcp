// Tool: check_sitemap
// Validates a domain's XML sitemap for presence, accessibility, and AI-search attributes.

import { z } from "zod";
import { politeFetch, type HostDelayMap } from "../lib/fetch.js";
import { fetchRobotsTxt } from "../lib/robots.js";
import { XMLParser } from "fast-xml-parser";
import type { Finding } from "../types.js";

export const checkSitemapInputSchema = z.object({
  domain: z
    .string()
    .min(3)
    .describe("Hostname or origin to inspect. Examples: `example.com`, `https://example.com`. The tool tries `/sitemap.xml` then the sitemap URL declared in robots.txt; follows sitemap index files one level deep. Read-only HTTP GETs against the domain only."),
  max_urls_to_check: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .default(100)
    .describe("Cap on how many URLs from the sitemap to sample for lastmod, image/video extension, and structural checks. Default 100. Increase up to 500 for large sites where you want a more representative sample; each extra URL is one HTTP HEAD."),
});

export type CheckSitemapInput = z.infer<typeof checkSitemapInputSchema>;

export interface SitemapResult {
  sitemap_url: string | null;
  status: "found" | "missing" | "error";
  total_urls: number;
  urls_with_lastmod: number;
  stale_urls: number;
  has_image_sitemap: boolean;
  has_video_sitemap: boolean;
  sitemap_index: boolean;
  findings: Finding[];
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

interface SitemapUrl {
  loc: string;
  lastmod?: string;
  priority?: string;
  changefreq?: string;
}

function isStale(lastmod: string): boolean {
  try {
    const d = new Date(lastmod).getTime();
    const ageDays = (Date.now() - d) / (1000 * 60 * 60 * 24);
    return ageDays > 90;
  } catch {
    return false;
  }
}

function parseSitemapXml(
  xml: string,
  sitemapUrl: string
): { urls: SitemapUrl[]; isSitemapIndex: boolean; childSitemaps: string[] } {
  const parser = new XMLParser({ ignoreAttributes: false });
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return { urls: [], isSitemapIndex: false, childSitemaps: [] };
  }

  // Sitemap index
  const sitemapIndex = parsed["sitemapindex"] as Record<string, unknown> | undefined;
  if (sitemapIndex) {
    const sitemaps = sitemapIndex["sitemap"];
    const sitemapList: Array<Record<string, unknown>> = Array.isArray(sitemaps)
      ? (sitemaps as Array<Record<string, unknown>>)
      : sitemaps
      ? [sitemaps as Record<string, unknown>]
      : [];
    const childSitemaps = sitemapList
      .map((s) => String(s["loc"] ?? ""))
      .filter(Boolean);
    return { urls: [], isSitemapIndex: true, childSitemaps };
  }

  // Regular sitemap
  const urlset = parsed["urlset"] as Record<string, unknown> | undefined;
  if (!urlset) return { urls: [], isSitemapIndex: false, childSitemaps: [] };

  const urlEntries = urlset["url"];
  const urlList: Array<Record<string, unknown>> = Array.isArray(urlEntries)
    ? (urlEntries as Array<Record<string, unknown>>)
    : urlEntries
    ? [urlEntries as Record<string, unknown>]
    : [];

  const urls: SitemapUrl[] = urlList.map((u) => ({
    loc: String(u["loc"] ?? ""),
    lastmod: u["lastmod"] ? String(u["lastmod"]) : undefined,
    priority: u["priority"] ? String(u["priority"]) : undefined,
    changefreq: u["changefreq"] ? String(u["changefreq"]) : undefined,
  }));

  // Check for image/video namespaces in raw XML
  const hasImage = xml.includes("image:") || xml.includes("xmlns:image");
  const hasVideo = xml.includes("video:") || xml.includes("xmlns:video");

  return {
    urls,
    isSitemapIndex: false,
    childSitemaps: [],
  };
}

export async function checkSitemap(
  input: CheckSitemapInput,
  hostDelays?: HostDelayMap,
  robotsCache?: Map<string, string>
): Promise<SitemapResult> {
  const hostname = normalizeDomain(input.domain);
  const findings: Finding[] = [];
  let sitemapUrl: string | null = null;
  let allUrls: SitemapUrl[] = [];
  let isSitemapIndex = false;
  let hasImageSitemap = false;
  let hasVideoSitemap = false;

  // Try to discover sitemap
  const candidates = [
    `https://${hostname}/sitemap.xml`,
    `https://${hostname}/sitemap_index.xml`,
  ];

  // Check robots.txt for Sitemap: directive
  const robotsText = await fetchRobotsTxt(`https://${hostname}/robots.txt`);
  if (robotsText) {
    const sitemapMatch = robotsText.match(/^Sitemap:\s*(.+)$/im);
    if (sitemapMatch && sitemapMatch[1]) {
      const robotsSitemapUrl = sitemapMatch[1].trim();
      if (!candidates.includes(robotsSitemapUrl)) {
        candidates.unshift(robotsSitemapUrl); // try first
      }
    }
  }

  let sitemapXml: string | null = null;
  for (const candidate of candidates) {
    try {
      const res = await politeFetch(candidate, {
        respectRobots: false, // sitemaps are always allowed
        hostDelays,
        robotsCache,
      });
      if (res.statusCode === 200) {
        sitemapUrl = candidate;
        sitemapXml = res.body;
        break;
      }
    } catch {
      // try next candidate
    }
  }

  if (!sitemapXml || !sitemapUrl) {
    findings.push({
      severity: "critical",
      category: "sitemap",
      where: `https://${hostname}/sitemap.xml`,
      message: "No sitemap found at standard locations.",
      fix: "Create a sitemap.xml and declare it in robots.txt with 'Sitemap: https://yourdomain.com/sitemap.xml'.",
      estimated_impact: "medium",
    });
    return {
      sitemap_url: null,
      status: "missing",
      total_urls: 0,
      urls_with_lastmod: 0,
      stale_urls: 0,
      has_image_sitemap: false,
      has_video_sitemap: false,
      sitemap_index: false,
      findings,
    };
  }

  hasImageSitemap = sitemapXml.includes("image:") || sitemapXml.includes("xmlns:image");
  hasVideoSitemap = sitemapXml.includes("video:") || sitemapXml.includes("xmlns:video");

  const { urls, isSitemapIndex: isIndex, childSitemaps } = parseSitemapXml(sitemapXml, sitemapUrl);
  isSitemapIndex = isIndex;
  allUrls = urls;

  // Load child sitemaps (up to 3 levels, capped at max_urls_to_check)
  if (isIndex && childSitemaps.length > 0) {
    let loaded = 0;
    for (const childUrl of childSitemaps) {
      if (allUrls.length >= input.max_urls_to_check) break;
      if (loaded >= 3) break; // max 3 child sitemaps for now
      try {
        const childRes = await politeFetch(childUrl, {
          respectRobots: false,
          hostDelays,
          robotsCache,
        });
        const { urls: childUrls } = parseSitemapXml(childRes.body, childUrl);
        if (childRes.body.includes("image:")) hasImageSitemap = true;
        if (childRes.body.includes("video:")) hasVideoSitemap = true;
        allUrls.push(...childUrls);
        loaded++;
      } catch {
        // skip failed child sitemaps
      }
    }
  }

  // Cap at max_urls_to_check
  const checked = allUrls.slice(0, input.max_urls_to_check);
  const total_urls = checked.length;
  const urls_with_lastmod = checked.filter((u) => !!u.lastmod).length;
  const stale_urls = checked.filter((u) => u.lastmod && isStale(u.lastmod)).length;

  // Findings
  const missingLastmod = total_urls - urls_with_lastmod;
  if (total_urls > 0 && missingLastmod / total_urls > 0.5) {
    findings.push({
      severity: "warning",
      category: "sitemap",
      where: "sitemap.xml",
      message: `${Math.round((missingLastmod / total_urls) * 100)}% of URLs are missing lastmod dates - reduces freshness signals.`,
      fix: "Add <lastmod> to all <url> entries. Use ISO 8601 format (YYYY-MM-DD).",
      estimated_impact: "medium",
    });
  }

  if (total_urls > 0 && stale_urls / total_urls > 0.5) {
    findings.push({
      severity: "warning",
      category: "sitemap",
      where: "sitemap.xml",
      message: `${Math.round((stale_urls / total_urls) * 100)}% of URLs have lastmod older than 90 days.`,
      fix: "Update lastmod dates when content changes. Stale content signals reduce AI citation probability.",
      estimated_impact: "medium",
    });
  }

  return {
    sitemap_url: sitemapUrl,
    status: "found",
    total_urls,
    urls_with_lastmod,
    stale_urls,
    has_image_sitemap: hasImageSitemap,
    has_video_sitemap: hasVideoSitemap,
    sitemap_index: isSitemapIndex,
    findings,
  };
}
