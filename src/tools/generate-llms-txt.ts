// Tool: generate_llms_txt
// Generates a valid llms.txt (and optionally llms-full.txt) for a domain.

import { z } from "zod";
import { politeFetch, type HostDelayMap } from "../lib/fetch.js";
import { parseHead, parseBody } from "../lib/html.js";
import { checkSitemap, parseSitemapXml, type SitemapUrl } from "./check-sitemap.js";
import {
  groupPagesBySection,
  generateLlmsTxt as buildLlmsTxt,
  generateLlmsFullTxt,
  validateLlmsTxtContent,
  type LlmsPage,
} from "../lib/llms-txt.js";
import type { Finding } from "../types.js";

export const generateLlmsTxtInputSchema = z.object({
  domain: z
    .string()
    .min(3)
    .describe("Hostname or origin to generate llms.txt for. Examples: `example.com`, `https://example.com`. The tool reads the domain's sitemap, fetches up to `max_pages` of them, and synthesizes a spec-compliant llms.txt grouped by section. Issues N+1 HTTP GETs: one for the sitemap, then one per sampled page. Read-only."),
  max_pages: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(30)
    .describe("How many pages to sample from the sitemap when building section groupings. Default 30. Each page is fetched (one HTTP GET per page) - keep this low for large sites or rate-limited hosts."),
  include_full: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, also generate llms-full.txt (the expanded variant containing full page text, not just URLs and titles). Default false. The llms-full.txt output can be large; only enable when you actually plan to host both files."),
  site_name: z
    .string()
    .optional()
    .describe("Override the site name used in the generated llms.txt header. If omitted, inferred from the homepage's <title> tag."),
  site_description: z
    .string()
    .optional()
    .describe("Override the site description used in the generated llms.txt header. If omitted, inferred from the homepage's meta description."),
});

export type GenerateLlmsTxtInput = z.infer<typeof generateLlmsTxtInputSchema>;

export interface LlmsTxtResult {
  domain: string;
  llms_txt: string;
  llms_full_txt: string | null;
  pages_indexed: number;
  validation_issues: Finding[];
  suggested_path: "/llms.txt";
}

// Walk a sitemap, following sitemap-index files to any depth, and collect the
// <url> entries from every referenced child sitemap. Bounded by MAX_FETCHES so a
// pathological index tree can't fan out unbounded.
async function collectSitemapUrls(
  rootSitemapUrl: string,
  hostDelays?: HostDelayMap,
  robotsCache?: Map<string, string>
): Promise<SitemapUrl[]> {
  const MAX_FETCHES = 50;
  const collected: SitemapUrl[] = [];
  const queue: string[] = [rootSitemapUrl];
  const visited = new Set<string>();
  let fetches = 0;

  while (queue.length > 0 && fetches < MAX_FETCHES) {
    const url = queue.shift() as string;
    if (visited.has(url)) continue;
    visited.add(url);

    let body: string;
    try {
      const res = await politeFetch(url, { respectRobots: false, hostDelays, robotsCache });
      fetches++;
      body = res.body;
    } catch {
      continue; // skip sitemaps that fail to fetch
    }

    const { urls, isSitemapIndex, childSitemaps } = parseSitemapXml(body, url);
    if (isSitemapIndex) {
      for (const child of childSitemaps) {
        if (!visited.has(child)) queue.push(child);
      }
    } else {
      collected.push(...urls);
    }
  }

  return collected;
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

export async function generateLlmsTxtTool(
  input: GenerateLlmsTxtInput,
  hostDelays?: HostDelayMap,
  robotsCache?: Map<string, string>
): Promise<LlmsTxtResult> {
  const hostname = normalizeDomain(input.domain);
  const baseUrl = `https://${hostname}`;
  const validation_issues: Finding[] = [];

  // Discover pages from sitemap
  let pageUrls: string[] = [];
  try {
    const sitemapResult = await checkSitemap(
      { domain: hostname, max_urls_to_check: input.max_pages },
      hostDelays,
      robotsCache
    );
    if (sitemapResult.status === "found" && sitemapResult.sitemap_url) {
      // Re-walk the sitemap (following sitemap-index files into their children)
      // to get priority-sorted URLs.
      try {
        const sitemapUrls = await collectSitemapUrls(
          sitemapResult.sitemap_url,
          hostDelays,
          robotsCache
        );
        pageUrls = sitemapUrls
          .sort((a, b) => {
            const pa = parseFloat(a.priority ?? "0.5");
            const pb = parseFloat(b.priority ?? "0.5");
            return pb - pa;
          })
          .slice(0, input.max_pages)
          .map((u) => u.loc)
          .filter(Boolean);
      } catch {
        // fall through to root page fallback
      }
    }
  } catch {
    // sitemap unavailable
  }

  // Fallback to root page if no sitemap
  if (pageUrls.length === 0) {
    pageUrls = [baseUrl];
    validation_issues.push({
      severity: "warning",
      category: "sitemap",
      where: `https://${hostname}/sitemap.xml`,
      message: "No sitemap found - llms.txt generated from root page only.",
      fix: "Create a sitemap.xml to enable comprehensive llms.txt generation.",
      estimated_impact: "medium",
    });
  }

  // Fetch each page
  const pages: Array<LlmsPage & { fullText?: string }> = [];
  let siteName = input.site_name ?? hostname;
  let siteDescription = input.site_description ?? `Content from ${hostname}.`;

  for (const url of pageUrls) {
    if (pages.length >= input.max_pages) break;
    try {
      const res = await politeFetch(url, {
        respectRobots: true,
        hostDelays: hostDelays ?? new Map(),
        robotsCache,
      });
      const head = parseHead(res.body);
      const body = parseBody(res.body, url);

      let pathFallback = "";
      try {
        pathFallback = new URL(url).pathname.replace(/\//g, " ").trim();
      } catch {
        pathFallback = url;
      }
      const title = head.ogTitle ?? head.title ?? (pathFallback || url);
      const description =
        head.metaDescription ??
        head.ogDescription ??
        (body.paragraphs[0] ? body.paragraphs[0].substring(0, 120) : "");

      // Use site root for name/description if this is the home page
      if (url === baseUrl || url === `${baseUrl}/`) {
        if (!input.site_name && head.ogTitle) siteName = head.ogTitle;
        if (!input.site_description && head.metaDescription) {
          siteDescription = head.metaDescription;
        }
      }

      pages.push({
        url,
        title,
        description,
        fullText: body.bodyText.substring(0, 5000),
      });
    } catch {
      // skip pages that fail to fetch
    }
  }

  if (pages.length === 0) {
    pages.push({ url: baseUrl, title: siteName, description: siteDescription });
  }

  const groups = groupPagesBySection(pages);
  const llms_txt = buildLlmsTxt(siteName, siteDescription, groups);

  let llms_full_txt: string | null = null;
  if (input.include_full) {
    const { content, truncated } = generateLlmsFullTxt(siteName, siteDescription, pages);
    llms_full_txt = content;
    if (truncated) {
      validation_issues.push({
        severity: "info",
        category: "llms_txt",
        where: "llms-full.txt",
        message: "llms-full.txt was truncated at 500KB.",
        fix: "Reduce max_pages or trim per-page body text extraction.",
      });
    }
  }

  // Validate generated output
  const structuralIssues = validateLlmsTxtContent(llms_txt);
  validation_issues.push(...structuralIssues);

  return {
    domain: hostname,
    llms_txt,
    llms_full_txt,
    pages_indexed: pages.length,
    validation_issues,
    suggested_path: "/llms.txt",
  };
}
