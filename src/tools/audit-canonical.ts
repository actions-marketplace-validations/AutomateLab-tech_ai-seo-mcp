// Tool: audit_canonical
// Canonical link integrity, trailing-slash hygiene, self-referencing, og:url mismatches.

import { z } from "zod";
import { politeFetch, type HostDelayMap } from "../lib/fetch.js";
import { parseHead } from "../lib/html.js";
import type { Finding } from "../types.js";

export const auditCanonicalInputSchema = z.object({
  url: z
    .string()
    .url()
    .describe("Public URL whose canonical link tag and og:url consistency you want to audit. Must be a fully-qualified http(s) URL. The tool fetches the URL (following redirects) and inspects only the <head> section; the body is not parsed."),
  respect_robots: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true (default), respect robots.txt before fetching. Set false only for auditing your own site where you've intentionally blocked crawlers."),
});

export type AuditCanonicalInput = z.infer<typeof auditCanonicalInputSchema>;

export interface CanonicalResult {
  url: string;
  final_url: string;
  canonical_value: string | null;
  is_self_referential: boolean;
  is_cross_domain: boolean;
  trailing_slash_consistent: boolean;
  canonical_og_url_match: boolean;
  findings: Finding[];
}

export async function auditCanonical(
  input: AuditCanonicalInput,
  hostDelays?: HostDelayMap,
  robotsCache?: Map<string, string>
): Promise<CanonicalResult> {
  const result = await politeFetch(input.url, {
    respectRobots: input.respect_robots,
    hostDelays,
    robotsCache,
  });

  const head = parseHead(result.body);
  const findings: Finding[] = [];
  const finalUrl = result.finalUrl;

  let isSelfRef = false;
  let isCrossDomain = false;
  let trailingSlashConsistent = true;
  let canonicalOgUrlMatch = true;

  if (!head.canonical) {
    findings.push({
      severity: "warning",
      category: "technical",
      where: '<link rel="canonical">',
      message: "No canonical link element found.",
      fix: `Add <link rel="canonical" href="${finalUrl}"> to <head>.`,
      estimated_impact: "medium",
    });
  } else {
    try {
      const pageUrl = new URL(finalUrl);
      const canonUrl = new URL(head.canonical, input.url);

      isSelfRef =
        canonUrl.hostname === pageUrl.hostname &&
        canonUrl.pathname.replace(/\/$/, "") === pageUrl.pathname.replace(/\/$/, "");
      isCrossDomain = canonUrl.hostname !== pageUrl.hostname;

      // Trailing slash consistency
      const pageHasSlash = pageUrl.pathname.endsWith("/");
      const canonHasSlash = canonUrl.pathname.endsWith("/");
      if (
        pageUrl.pathname !== "/" &&
        canonUrl.pathname !== "/" &&
        pageHasSlash !== canonHasSlash
      ) {
        trailingSlashConsistent = false;
        findings.push({
          severity: "warning",
          category: "technical",
          where: '<link rel="canonical">',
          message: `Trailing slash inconsistency: page "${pageUrl.pathname}" vs canonical "${canonUrl.pathname}".`,
          fix: "Ensure canonical href and page URL use the same trailing slash convention. Pick one and redirect all variants.",
          estimated_impact: "low",
        });
      }

      if (isCrossDomain) {
        findings.push({
          severity: "warning",
          category: "technical",
          where: '<link rel="canonical">',
          message: `Canonical points to a different domain: ${canonUrl.hostname}.`,
          fix: "Verify this is intentional (syndicated content). If not, update to a self-referencing canonical.",
          estimated_impact: "medium",
        });
      } else if (!isSelfRef) {
        findings.push({
          severity: "warning",
          category: "technical",
          where: '<link rel="canonical">',
          message: "Canonical does not self-reference the current page URL.",
          fix: `Update canonical to: <link rel="canonical" href="${finalUrl}">.`,
          estimated_impact: "medium",
        });
      }
    } catch {
      findings.push({
        severity: "warning",
        category: "technical",
        where: '<link rel="canonical">',
        message: `Canonical value "${head.canonical}" is not a valid URL.`,
        fix: "Replace with a valid absolute URL.",
        estimated_impact: "medium",
      });
    }

    // og:url vs canonical mismatch
    if (head.ogUrl && head.canonical) {
      try {
        const canonUrl = new URL(head.canonical, input.url);
        const ogUrl = new URL(head.ogUrl, input.url);
        canonicalOgUrlMatch =
          canonUrl.hostname === ogUrl.hostname && canonUrl.pathname === ogUrl.pathname;
        if (!canonicalOgUrlMatch) {
          findings.push({
            severity: "warning",
            category: "technical",
            where: "og:url vs canonical",
            message: "og:url does not match canonical URL.",
            fix: `Set og:url to match the canonical URL: <meta property="og:url" content="${head.canonical}">.`,
            estimated_impact: "low",
          });
        }
      } catch {
        // ignore URL parse errors
      }
    }
  }

  return {
    url: input.url,
    final_url: finalUrl,
    canonical_value: head.canonical,
    is_self_referential: isSelfRef,
    is_cross_domain: isCrossDomain,
    trailing_slash_consistent: trailingSlashConsistent,
    canonical_og_url_match: canonicalOgUrlMatch,
    findings,
  };
}
