// Evidence signals (Princeton GEO weighting).
//
// The Princeton "GEO" study measured which content changes lift visibility in
// generative engines: adding CITATIONS to sources (+40%), STATISTICS with
// numbers (+37%), and EXPERT QUOTATIONS (+30%) were the biggest movers;
// keyword stuffing was negative. This module counts those three evidence types
// and emits Princeton-weighted findings when they're absent.

import * as cheerio from "cheerio";
import type { Finding } from "../types.js";

export interface EvidenceResult {
  score: number; // 0-100
  citations: number;  // outbound links to non-self authoritative sources
  statistics: number; // numbers with units / percentages / money
  quotes: number;     // blockquotes or attributed quotations
  findings: Finding[];
}

// Numbers that carry meaning: percentages, money, multipliers, magnitudes, or a
// number followed by a unit-ish word. Bare years/list indices are ignored.
const STAT_RE =
  /(\b\d[\d,]*(\.\d+)?\s?(%|percent|x\b|×|million|billion|trillion|k\b|bps)\b)|(\$\s?\d[\d,]*(\.\d+)?)|(\b\d[\d,]*(\.\d+)?\s?(users|customers|companies|developers|hours|days|minutes|seconds|requests|queries|tokens|words|pages|sites|points|words\/min)\b)/gi;

function countStatistics(text: string): number {
  const m = text.match(STAT_RE);
  return m ? m.length : 0;
}

// Quotation: a 8+ word span inside double quotes, OR an explicit attribution verb.
const QUOTE_SPAN_RE = /["“][^"”]{40,}["”]/g;
const ATTRIBUTION_RE = /\b(said|says|according to|told|notes|argues|explains|writes)\b/gi;

export function scoreEvidence(
  html: string,
  bodyText: string,
  externalLinks: string[],
  wordCount: number
): EvidenceResult {
  const $ = cheerio.load(html);
  $("nav, header, footer, aside, .nav, .menu").remove();

  // Citations: distinct external link hosts (a page that links the same domain
  // 20 times is not 20 citations).
  const hosts = new Set<string>();
  for (const href of externalLinks) {
    try {
      hosts.add(new URL(href).hostname.replace(/^www\./, ""));
    } catch {
      /* skip */
    }
  }
  const citations = hosts.size;

  const statistics = countStatistics(bodyText);

  const blockquotes = $("blockquote").length;
  const quoteSpans = (bodyText.match(QUOTE_SPAN_RE) ?? []).length;
  const attributions = (bodyText.match(ATTRIBUTION_RE) ?? []).length;
  const quotes = blockquotes + Math.min(quoteSpans, attributions);

  const findings: Finding[] = [];
  const isSubstantial = wordCount >= 300;

  // Princeton ordering: citations (+40%) > statistics (+37%) > quotes (+30%).
  if (isSubstantial && citations === 0) {
    findings.push({
      severity: "warning",
      category: "evidence",
      where: "page-level",
      message: "No outbound citations to authoritative sources.",
      fix: "Cite 2-3 primary sources (studies, docs, official stats) with outbound links. Adding citations is the single biggest measured GEO lever (~+40% visibility).",
      estimated_impact: "high",
      failure_signal: "Re-audit still finds zero distinct external citation hosts.",
      leading_indicator: "Count of distinct authoritative domains linked in the body.",
    });
  }
  if (isSubstantial && statistics === 0) {
    findings.push({
      severity: "warning",
      category: "evidence",
      where: "page-level",
      message: "No statistics or quantified claims found.",
      fix: "Add concrete numbers with units/percentages and cite their source. Statistics-with-sources measured ~+37% GEO visibility.",
      estimated_impact: "high",
      leading_indicator: "Number of sourced statistics per 1,000 words.",
    });
  }
  if (isSubstantial && quotes === 0) {
    findings.push({
      severity: "info",
      category: "evidence",
      where: "page-level",
      message: "No expert quotations or attributed statements found.",
      fix: "Add 1-2 attributed expert quotes (with name + source). Expert quotations measured ~+30% GEO visibility.",
      estimated_impact: "medium",
    });
  }

  // Score: weighted presence of the three evidence types, scaled by document
  // length so a 100-word stub isn't punished as hard as a 2,000-word article.
  const citeScore = Math.min(1, citations / 3) * 40;
  const statScore = Math.min(1, statistics / 4) * 37;
  const quoteScore = Math.min(1, quotes / 2) * 23;
  const raw = citeScore + statScore + quoteScore; // max 100
  const score = isSubstantial ? Math.round(raw) : Math.round(Math.max(raw, 50));

  return { score, citations, statistics, quotes, findings };
}
