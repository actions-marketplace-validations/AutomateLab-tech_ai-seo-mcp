// Passage-level citability (GEO).
//
// Convergent finding across independent GEO research (Princeton GEO, and two public
// GEO audit toolkits): AI engines lift CLEAN, SELF-CONTAINED answer passages of
// roughly 134-167 words. Sections far outside that band (giant walls of text, or
// one-line stubs) are cited far less reliably. This module splits the page into
// heading-delimited sections and scores how many are in the citable band.

import { extractSections } from "./html.js";
import type { Finding } from "../types.js";

const OPTIMAL_MIN = 120; // a little wider than 134-167 to avoid false negatives
const OPTIMAL_MAX = 180;
const TOO_LONG = 280;
const TOO_SHORT = 40;

// Sections that open with a dangling reference can't be lifted as a standalone
// answer — the AI would have to pull surrounding context it may not cite.
const DANGLING_OPENERS = /^(this|that|these|those|it|they|he|she|here|there|such|which)\b/i;

export interface CitabilityResult {
  score: number; // 0-100
  passages_analyzed: number;
  optimal_passages: number;
  findings: Finding[];
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

export function scoreCitability(html: string): CitabilityResult {
  const sections = extractSections(html).filter((s) => s.heading.length > 0 && s.text.length > 0);
  const findings: Finding[] = [];

  if (sections.length === 0) {
    // No heading-delimited prose to lift. One finding, neutral-low score.
    findings.push({
      severity: "warning",
      category: "citation",
      where: "<body>",
      message: "No heading-delimited answer passages found; AI engines have nothing self-contained to lift.",
      fix: "Structure content under descriptive H2/H3 headings, each followed by a 120-170 word self-contained answer.",
      estimated_impact: "high",
      failure_signal: "Re-audit still reports 0 heading-delimited passages.",
      leading_indicator: "Number of H2/H3 sections each carrying a standalone answer paragraph.",
    });
    return { score: 30, passages_analyzed: 0, optimal_passages: 0, findings };
  }

  let optimal = 0;
  let tooLong = 0;
  let tooShort = 0;
  let dangling = 0;
  const longSamples: string[] = [];

  for (const s of sections) {
    const wc = wordCount(s.text);
    if (wc >= OPTIMAL_MIN && wc <= OPTIMAL_MAX) optimal++;
    if (wc > TOO_LONG) {
      tooLong++;
      if (longSamples.length < 3) longSamples.push(`"${s.heading.slice(0, 40)}" (${wc}w)`);
    }
    if (wc < TOO_SHORT) tooShort++;
    if (DANGLING_OPENERS.test(s.text.trim())) dangling++;
  }

  // Score: share of sections in the citable band, with partial credit for
  // near-band sections, minus a penalty for dangling openers.
  const inBandRatio = optimal / sections.length;
  const longPenalty = Math.min(0.3, tooLong / sections.length);
  const danglingPenalty = Math.min(0.2, dangling / sections.length);
  const score = Math.round(Math.max(0, Math.min(100, (inBandRatio * 0.7 + 0.3 - longPenalty - danglingPenalty) * 100)));

  if (tooLong >= 2 || (tooLong >= 1 && sections.length <= 3)) {
    findings.push({
      severity: "warning",
      category: "citation",
      where: "page-level",
      message: `${tooLong} section${tooLong === 1 ? " is" : "s are"} too long to cite cleanly (${longSamples.join(", ")}).`,
      fix: "Split each long section into 120-170 word self-contained passages under their own H3 so an AI can lift one answer.",
      estimated_impact: "high",
      failure_signal: "Sections still exceed ~280 words on re-audit.",
      leading_indicator: "Median words-per-section trending toward the 134-167 band.",
    });
  }

  if (optimal === 0 && sections.length >= 2) {
    findings.push({
      severity: "warning",
      category: "citation",
      where: "page-level",
      message: `None of ${sections.length} sections fall in the 134-167 word citable band.`,
      fix: "Rework answers so each H2/H3 section is a self-contained 120-170 word passage that answers one question.",
      estimated_impact: "high",
    });
  }

  if (dangling >= 2) {
    findings.push({
      severity: "info",
      category: "citation",
      where: "page-level",
      message: `${dangling} sections open with a dangling reference (this/it/they), so they can't be lifted standalone.`,
      fix: "Start each section with a self-contained sentence that names its subject explicitly.",
    });
  }

  return { score, passages_analyzed: sections.length, optimal_passages: optimal, findings };
}
