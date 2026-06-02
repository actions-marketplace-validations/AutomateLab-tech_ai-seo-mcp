// E-E-A-T trust signals, entity identity, and off-site presence (on-page proxy).
//
// Three convergent themes from the GEO toolkits we surveyed:
//  - TRUST (#4): AI engines weight authorship, dates, and policy transparency.
//  - ENTITY (#5): "if an AI cannot identify the publishing entity, it cannot
//    cite it" — Organization/Person schema + sameAs to the knowledge graph.
//  - PRESENCE (#9): off-site brand mentions. We can only PROXY this on-page
//    (does the site link its own authoritative/social profiles); the real
//    off-site mention scan belongs to the citation-intelligence MCP.

import * as cheerio from "cheerio";
import type { Finding } from "../types.js";
import type { ParsedJsonLd } from "./schema.js";

const AUTHORITATIVE_HOSTS = [
  "wikipedia.org", "wikidata.org", "linkedin.com", "twitter.com", "x.com",
  "github.com", "crunchbase.com", "youtube.com", "facebook.com", "instagram.com",
];

const POLICY_PATHS = ["/privacy", "/terms", "/contact", "/about", "/editorial", "/legal"];

export interface EeatResult {
  trust_score: number;  // 0-100
  entity_score: number; // 0-100
  findings: Finding[];
}

export function scoreEeatEntity(args: {
  html: string;
  url: string;
  foundTypes: string[];
  jsonLdBlocks: ParsedJsonLd[];
  internalLinks: string[];
  externalLinks: string[];
}): EeatResult {
  const { html, url, foundTypes, jsonLdBlocks, internalLinks, externalLinks } = args;
  const $ = cheerio.load(html);
  const findings: Finding[] = [];

  const isHttps = (() => {
    try { return new URL(url).protocol === "https:"; } catch { return false; }
  })();

  // --- TRUST ---
  const hasAuthorSchema = jsonLdBlocks.some(
    (b) => b.types.includes("Person") ||
      (b.types.some((t) => ["Article", "BlogPosting", "NewsArticle"].includes(t)) &&
        typeof b.parsed["author"] === "object" && b.parsed["author"] !== null)
  );
  const hasAuthorMarkup =
    $('[rel="author"], [class*="author" i], [itemprop="author"]').length > 0 ||
    /\bby\s+[A-Z][a-z]+\s+[A-Z][a-z]+/.test($("body").text().slice(0, 4000));
  const hasAuthor = hasAuthorSchema || hasAuthorMarkup;

  const hasVisibleDate =
    $("time[datetime]").length > 0 ||
    jsonLdBlocks.some((b) => b.parsed["dateModified"] || b.parsed["datePublished"]);

  const allInternal = internalLinks.map((l) => l.toLowerCase());
  const policyHits = POLICY_PATHS.filter((p) => allInternal.some((l) => l.includes(p)));
  const hasContact = policyHits.some((p) => p === "/contact" || p === "/about");
  const hasPolicy = policyHits.some((p) => p === "/privacy" || p === "/terms" || p === "/legal");

  let trust_score = 0;
  if (isHttps) trust_score += 20;
  if (hasAuthor) trust_score += 25;
  if (hasVisibleDate) trust_score += 20;
  if (hasContact) trust_score += 15;
  if (hasPolicy) trust_score += 20;
  trust_score = Math.min(100, trust_score);

  if (!hasAuthor) {
    findings.push({
      severity: "warning",
      category: "trust",
      where: "page-level",
      message: "No visible author or author schema — AI engines can't attribute expertise.",
      fix: 'Add a byline with the author\'s name and link a bio, plus Article.author as a {"@type":"Person", ...} node.',
      estimated_impact: "high",
      failure_signal: "Re-audit still finds no author markup or Person node.",
      leading_indicator: "Presence of a named, linked author byline on content pages.",
    });
  }
  if (!hasVisibleDate) {
    findings.push({
      severity: "info",
      category: "trust",
      where: "page-level",
      message: "No visible publish/updated date.",
      fix: "Show a published and last-updated date (and set datePublished/dateModified in JSON-LD).",
      estimated_impact: "medium",
    });
  }
  if (!hasPolicy || !hasContact) {
    const missing = [!hasContact ? "contact/about" : null, !hasPolicy ? "privacy/terms" : null]
      .filter(Boolean)
      .join(" and ");
    findings.push({
      severity: "info",
      category: "trust",
      where: "page-level",
      message: `Missing trust pages linked from this page: ${missing}.`,
      fix: "Link a contact/about page and a privacy/terms page in the footer; these are standard trust signals for AI and raters.",
    });
  }

  // --- ENTITY ---
  const hasOrg = foundTypes.includes("Organization") || foundTypes.includes("LocalBusiness");
  const hasPerson = foundTypes.includes("Person");
  const sameAsCount = jsonLdBlocks.reduce((acc, b) => {
    const sa = b.parsed["sameAs"];
    return acc + (Array.isArray(sa) ? sa.length : sa ? 1 : 0);
  }, 0);

  let entity_score = 0;
  if (hasOrg) entity_score += 45;
  if (hasPerson) entity_score += 20;
  entity_score += Math.min(35, sameAsCount * 12);
  entity_score = Math.min(100, entity_score);

  if (!hasOrg && !hasPerson) {
    findings.push({
      severity: "warning",
      category: "entity",
      where: "page-level",
      message: "No Organization or Person entity in structured data — AI can't identify who publishes this.",
      fix: 'Add an Organization JSON-LD node (name, url, logo, sameAs[]) and, for articles, a Person author. Entity identity is a prerequisite for being cited.',
      estimated_impact: "high",
      failure_signal: "Re-audit still finds no Organization/Person node.",
      leading_indicator: "Whether ChatGPT/Perplexity correctly name the brand when asked (track in citation-intelligence).",
    });
  } else if (hasOrg && sameAsCount === 0) {
    findings.push({
      severity: "info",
      category: "entity",
      where: "Organization.sameAs",
      message: "Entity has no sameAs links to the knowledge graph.",
      fix: 'Add sameAs: ["https://www.wikidata.org/...", "https://www.linkedin.com/company/...", official profiles] so engines can disambiguate the entity.',
      estimated_impact: "medium",
    });
  }

  // --- PRESENCE (on-page proxy only) ---
  const offSiteHosts = new Set<string>();
  for (const href of externalLinks) {
    try {
      const h = new URL(href).hostname.replace(/^www\./, "");
      if (AUTHORITATIVE_HOSTS.some((a) => h.endsWith(a))) offSiteHosts.add(h);
    } catch { /* skip */ }
  }
  const sameAsAuthoritative = jsonLdBlocks.some((b) => {
    const sa = b.parsed["sameAs"];
    const list = Array.isArray(sa) ? sa : sa ? [sa] : [];
    return list.some((u) => typeof u === "string" && AUTHORITATIVE_HOSTS.some((a) => u.includes(a)));
  });
  if (offSiteHosts.size === 0 && !sameAsAuthoritative) {
    findings.push({
      severity: "info",
      category: "presence",
      where: "page-level",
      message: "No links to authoritative/social profiles (Wikipedia, LinkedIn, GitHub, etc.).",
      fix: "Link your verified profiles and any third-party coverage. NOTE: a true off-site brand-mention scan (Reddit/YouTube/Wikipedia citations) lives in the citation-intelligence MCP.",
    });
  }

  return { trust_score, entity_score, findings };
}
