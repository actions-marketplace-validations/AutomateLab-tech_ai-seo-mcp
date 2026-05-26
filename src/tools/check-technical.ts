// Tool: check_technical
// Audits a page's HEAD section for technical signals relevant to AI crawlers.

import { z } from "zod";
import { politeFetch, ToolFetchError, type HostDelayMap } from "../lib/fetch.js";
import type { RenderMode } from "../lib/cache.js";
import { parseHead, levenshtein, analyzeMixedContent } from "../lib/html.js";
import type { Finding } from "../types.js";

export const checkTechnicalInputSchema = z.object({
  url: z
    .string()
    .url()
    .describe("Public URL to audit. The tool fetches the URL once and inspects HEAD-section signals: HTTPS, canonical, OpenGraph, Twitter Card, hreflang, noindex, title length and overlap with H1. Body content is not parsed. Read-only HTTP GET."),
  respect_robots: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true (default), respect robots.txt before fetching. Set false only for auditing your own site where you've intentionally blocked crawlers."),
});

export type CheckTechnicalInput = z.infer<typeof checkTechnicalInputSchema>;

export interface TechnicalResult {
  url: string;
  https: boolean;
  canonical: {
    present: boolean;
    value: string | null;
    self_referential: boolean;
    cross_domain: boolean;
  };
  noindex: boolean;
  noindex_header: boolean;
  og_tags: {
    title: boolean;
    description: boolean;
    image: boolean;
    url: boolean;
    type: boolean;
  };
  twitter_card: {
    present: boolean;
    card_type: string | null;
  };
  hreflang: {
    present: boolean;
    count: number;
    x_default: boolean;
  };
  title_og_match: boolean;
  meta_description: {
    present: boolean;
    length: number;
  };
  response_headers: {
    hsts: string | null;
    x_content_type_options: string | null;
    referrer_policy: string | null;
    content_security_policy: string | null;
    cache_control: string | null;
  };
  mixed_content: {
    count: number;
    samples: string[];
  };
  findings: Finding[];
}

export async function checkTechnical(
  input: CheckTechnicalInput,
  hostDelays?: HostDelayMap,
  robotsCache?: Map<string, string>,
  renderMode?: RenderMode
): Promise<TechnicalResult> {
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

  const xRobotsTag = result.headers["x-robots-tag"];
  const head = parseHead(result.body, xRobotsTag);
  const findings: Finding[] = [];

  // HTTPS
  const https = input.url.startsWith("https://");

  // Canonical
  let canonicalSelfRef = false;
  let canonicalCrossDomain = false;
  if (head.canonical) {
    try {
      const pageUrl = new URL(result.finalUrl);
      const canonUrl = new URL(head.canonical, input.url);
      canonicalSelfRef =
        canonUrl.hostname === pageUrl.hostname &&
        canonUrl.pathname === pageUrl.pathname;
      canonicalCrossDomain = canonUrl.hostname !== pageUrl.hostname;
    } catch {
      // ignore URL parse errors
    }
  }

  if (!head.canonical) {
    findings.push({
      severity: "warning",
      category: "technical",
      where: "<head>",
      message: "No canonical link element found.",
      fix: 'Add <link rel="canonical" href="https://example.com/page"> to <head>.',
      estimated_impact: "medium",
    });
  } else if (canonicalCrossDomain) {
    findings.push({
      severity: "warning",
      category: "technical",
      where: 'link[rel="canonical"]',
      message: "Canonical points to a different domain.",
      fix: "Verify this is intentional (syndicated content). If not, update to the self-referencing canonical.",
      estimated_impact: "medium",
    });
  }

  // noindex
  if (head.noindex) {
    findings.push({
      severity: "critical",
      category: "technical",
      where: head.noindexHeader ? "X-Robots-Tag header" : 'meta[name="robots"]',
      message: "Page has noindex directive - no AI search engine can index this page.",
      fix: "Remove the noindex directive if you want this page to appear in AI search results.",
      estimated_impact: "high",
    });
  }

  // Redirect finding
  if (result.redirected && result.finalUrl !== input.url) {
    findings.push({
      severity: "info",
      category: "technical",
      where: "page-level",
      message: `Page redirects to ${result.finalUrl} - ensure canonical and OG tags reflect the canonical URL.`,
      fix: "Update og:url and canonical href to the final redirect target URL.",
    });
  }

  // OG tags
  if (!head.ogTitle) {
    findings.push({
      severity: "warning",
      category: "technical",
      where: "og:title",
      message: "og:title is missing.",
      fix: 'Add <meta property="og:title" content="Page Title">.',
      estimated_impact: "medium",
    });
  }
  if (!head.ogDescription) {
    findings.push({
      severity: "warning",
      category: "technical",
      where: "og:description",
      message: "og:description is missing.",
      fix: 'Add <meta property="og:description" content="120-160 character description.">.',
      estimated_impact: "medium",
    });
  }
  if (!head.ogImage) {
    findings.push({
      severity: "warning",
      category: "technical",
      where: "og:image",
      message: "og:image is missing.",
      fix: 'Add <meta property="og:image" content="https://example.com/image.jpg">.',
      estimated_impact: "medium",
    });
  }

  // Twitter card
  if (!head.twitterCard) {
    findings.push({
      severity: "info",
      category: "technical",
      where: "twitter:card",
      message: "Twitter Card tags are absent.",
      fix: 'Add <meta name="twitter:card" content="summary_large_image"> and twitter:title, twitter:description.',
    });
  }

  // Meta description length
  const metaDescLen = head.metaDescription?.length ?? 0;
  if (!head.metaDescription) {
    findings.push({
      severity: "warning",
      category: "technical",
      where: 'meta[name="description"]',
      message: "Meta description is missing.",
      fix: 'Add <meta name="description" content="120-160 character description.">.',
      estimated_impact: "medium",
    });
  } else if (metaDescLen < 50) {
    findings.push({
      severity: "warning",
      category: "technical",
      where: 'meta[name="description"]',
      message: `Meta description is only ${metaDescLen} chars - too short (ideal: 120-160).`,
      fix: "Expand the meta description to 120-160 characters summarizing the page content.",
      estimated_impact: "low",
    });
  } else if (metaDescLen > 200) {
    findings.push({
      severity: "warning",
      category: "technical",
      where: 'meta[name="description"]',
      message: `Meta description is ${metaDescLen} chars - too long (ideal: 120-160).`,
      fix: "Trim the meta description to under 200 characters.",
      estimated_impact: "low",
    });
  }

  // Response header hygiene
  const hsts = result.headers["strict-transport-security"] ?? null;
  const xContentTypeOptions = result.headers["x-content-type-options"] ?? null;
  const referrerPolicy = result.headers["referrer-policy"] ?? null;
  const csp = result.headers["content-security-policy"] ?? null;
  const cacheControl = result.headers["cache-control"] ?? null;

  if (https && !hsts) {
    findings.push({
      severity: "warning",
      category: "technical",
      where: "Strict-Transport-Security header",
      message: "HSTS header is missing - browsers can be downgraded to http on first visit.",
      fix: "Send Strict-Transport-Security: max-age=63072000; includeSubDomains; preload from the server or CDN edge.",
      estimated_impact: "low",
    });
  }
  if (!xContentTypeOptions || !xContentTypeOptions.toLowerCase().includes("nosniff")) {
    findings.push({
      severity: "info",
      category: "technical",
      where: "X-Content-Type-Options header",
      message: "X-Content-Type-Options: nosniff header is absent.",
      fix: "Add X-Content-Type-Options: nosniff to block MIME-sniffing attacks.",
    });
  }
  if (!referrerPolicy) {
    findings.push({
      severity: "info",
      category: "technical",
      where: "Referrer-Policy header",
      message: "Referrer-Policy header is absent.",
      fix: "Set Referrer-Policy (e.g. strict-origin-when-cross-origin) to control referrer leakage.",
    });
  }

  // Mixed content scan (http:// resources on an https page)
  const mixed = https
    ? analyzeMixedContent(result.body)
    : { total: 0, samples: [] };
  if (mixed.total > 0) {
    findings.push({
      severity: "critical",
      category: "technical",
      where: "page-level",
      message: `Mixed content: ${mixed.total} http:// resource${mixed.total === 1 ? "" : "s"} on an https page (e.g. ${mixed.samples[0] ?? ""}).`,
      fix: "Update all <img>, <script>, and <link> URLs to https:// or protocol-relative //. Mixed content is blocked by browsers and signals neglect.",
      estimated_impact: "high",
    });
  }

  // Title/OG match
  const titleOgMatch =
    !head.title || !head.ogTitle
      ? true // can't compare if either is missing
      : levenshtein(head.title, head.ogTitle) <= 10;

  if (!titleOgMatch) {
    findings.push({
      severity: "warning",
      category: "technical",
      where: "og:title vs <title>",
      message: "og:title differs significantly from <title> - may signal content inconsistency.",
      fix: "Align og:title with <title> or ensure the difference is intentional.",
      estimated_impact: "low",
    });
  }

  return {
    url: input.url,
    https,
    canonical: {
      present: !!head.canonical,
      value: head.canonical,
      self_referential: canonicalSelfRef,
      cross_domain: canonicalCrossDomain,
    },
    noindex: head.noindex,
    noindex_header: head.noindexHeader,
    og_tags: {
      title: !!head.ogTitle,
      description: !!head.ogDescription,
      image: !!head.ogImage,
      url: !!head.ogUrl,
      type: !!head.ogType,
    },
    twitter_card: {
      present: !!head.twitterCard,
      card_type: head.twitterCard,
    },
    hreflang: {
      present: head.hreflangTags.length > 0,
      count: head.hreflangTags.length,
      x_default: head.hreflangTags.some((h) => h.lang === "x-default"),
    },
    title_og_match: titleOgMatch,
    meta_description: {
      present: !!head.metaDescription,
      length: metaDescLen,
    },
    response_headers: {
      hsts,
      x_content_type_options: xContentTypeOptions,
      referrer_policy: referrerPolicy,
      content_security_policy: csp,
      cache_control: cacheControl,
    },
    mixed_content: {
      count: mixed.total,
      samples: mixed.samples,
    },
    findings,
  };
}
