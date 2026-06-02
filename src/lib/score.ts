// Grade derivation and dimension weighting formulas.

import type { Finding } from "../types.js";

export type Grade = "A" | "B" | "C" | "D" | "F";

/** Derive a letter grade from a 0-100 numeric score. */
export function deriveGrade(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

export interface DimensionScores {
  schema: number;
  technical: number;
  structure: number;
  robots: number;
  freshness: number;
  authority: number;
  entity_density: number;
  sitemap: number;
  citability: number; // passage-level extractability (GEO)
  evidence: number;   // citations / statistics / quotations (Princeton GEO)
  trust: number;      // E-E-A-T trust signals
}

/**
 * Weighted dimension score for audit_page. Weights re-balanced for AI citation:
 * schema 18%, citability 15%, evidence 12%, structure 12%, technical 12%,
 * trust 8%, authority 7%, robots 7%, freshness 5%, entity_density 2%, sitemap 2%.
 * (Citation-content dimensions now dominate, per converging GEO research.)
 */
export function computeWeightedScore(dimensions: DimensionScores): number {
  const score =
    dimensions.schema * 0.18 +
    dimensions.citability * 0.15 +
    dimensions.evidence * 0.12 +
    dimensions.structure * 0.12 +
    dimensions.technical * 0.12 +
    dimensions.trust * 0.08 +
    dimensions.authority * 0.07 +
    dimensions.robots * 0.07 +
    dimensions.freshness * 0.05 +
    dimensions.entity_density * 0.02 +
    dimensions.sitemap * 0.02;
  return Math.round(Math.max(0, Math.min(100, score)));
}

/**
 * Veto caps: certain hard blockers make the whole page effectively uncitable,
 * no matter how well the other dimensions score. When any veto is present the
 * composite is capped (default 60 = grade C ceiling). Returns the (possibly
 * capped) score plus the human-readable reasons that triggered the cap.
 */
export function applyVetoCaps(
  score: number,
  vetoes: string[],
  ceiling = 60
): { score: number; capped: boolean; reasons: string[] } {
  if (vetoes.length === 0) return { score, capped: false, reasons: [] };
  return { score: Math.min(score, ceiling), capped: score > ceiling, reasons: vetoes };
}

export type PlatformLabel = "ready" | "partial" | "weak";

export interface PlatformReadiness {
  chatgpt: { score: number; label: PlatformLabel };
  perplexity: { score: number; label: PlatformLabel };
  google_ai_overview: { score: number; label: PlatformLabel };
  gemini: { score: number; label: PlatformLabel };
}

function label(score: number): PlatformLabel {
  return score >= 75 ? "ready" : score >= 50 ? "partial" : "weak";
}

const avg = (...xs: number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * Derive per-engine readiness from the dimension scores. Different engines
 * reward different signals (only ~11% of domains are cited by both ChatGPT and
 * Google AI Overviews), so a single composite hides real gaps.
 */
export function platformReadiness(d: DimensionScores): PlatformReadiness {
  const chatgpt = avg(d.citability, d.evidence, d.robots, d.structure);
  const perplexity = avg(d.citability, d.evidence, d.freshness, d.structure);
  const google_ai_overview = avg(d.schema, d.structure, d.technical, d.freshness);
  const gemini = avg(d.schema, d.entity_density, d.robots, d.authority);
  return {
    chatgpt: { score: chatgpt, label: label(chatgpt) },
    perplexity: { score: perplexity, label: label(perplexity) },
    google_ai_overview: { score: google_ai_overview, label: label(google_ai_overview) },
    gemini: { score: gemini, label: label(gemini) },
  };
}

/**
 * Compute a simple score from a findings list.
 * Starts at 100, deducts per finding severity.
 * critical: -15, warning: -7, info: -2
 */
export function scoreFromFindings(
  findings: Finding[],
  baseScore = 100,
  weights = { critical: 15, warning: 7, info: 2 }
): number {
  let score = baseScore;
  for (const f of findings) {
    if (f.severity === "critical") score -= weights.critical;
    else if (f.severity === "warning") score -= weights.warning;
    else score -= weights.info;
  }
  return Math.max(0, Math.min(100, score));
}

/** Freshness score from a dateModified ISO string. 100 if within 90 days, decays linearly to 0 at 365 days. */
export function freshnessScore(dateModified: string | null): number {
  if (!dateModified) return 30; // unknown freshness - partial credit
  const modified = new Date(dateModified).getTime();
  const now = Date.now();
  const ageMs = now - modified;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays <= 90) return 100;
  if (ageDays >= 365) return 0;
  // linear decay from 100 at 90 days to 0 at 365 days
  return Math.round(100 * (1 - (ageDays - 90) / (365 - 90)));
}
