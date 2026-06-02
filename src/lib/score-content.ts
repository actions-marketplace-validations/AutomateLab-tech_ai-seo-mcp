// AI-content / filler heuristic (#10).
//
// Generative-engine guidelines (Google QRG §4.6.5/4.6.6 on "filler") and the
// GEO toolkits flag low-information, hedging, AI-pattern prose. This is a cheap
// lexical heuristic — it flags density of known filler/hedging phrases and the
// "delve into / tapestry / ever-evolving" cluster that signals unedited LLM
// output. It is a DIAGNOSTIC (info-level), never a hard score killer.

import type { Finding } from "../types.js";

const FILLER_PHRASES = [
  "in today's world", "in today's fast-paced", "it is important to note",
  "it's important to note", "it is worth noting", "it's worth noting",
  "when it comes to", "at the end of the day", "needless to say",
  "as we all know", "in the realm of", "in the world of", "navigating the",
  "plays a crucial role", "plays a vital role", "plays a pivotal role",
  "in order to", "a testament to", "the ever-evolving", "ever-changing landscape",
  "unlock the", "unleash the", "delve into", "dive into the world",
  "rich tapestry", "tapestry of", "game-changer", "game changer",
  "in conclusion", "in summary", "last but not least", "first and foremost",
  "it goes without saying", "the power of", "harness the power",
];

export interface ContentResult {
  score: number; // 0-100 (100 = clean, low filler)
  filler_hits: number;
  findings: Finding[];
}

export function scoreContent(bodyText: string, wordCount: number): ContentResult {
  const findings: Finding[] = [];
  if (wordCount < 200) {
    return { score: 100, filler_hits: 0, findings };
  }

  const lower = bodyText.toLowerCase();
  const samples: string[] = [];
  let hits = 0;
  for (const p of FILLER_PHRASES) {
    let idx = lower.indexOf(p);
    while (idx !== -1) {
      hits++;
      if (samples.length < 3 && !samples.includes(p)) samples.push(p);
      idx = lower.indexOf(p, idx + p.length);
    }
  }

  // Density per 1,000 words.
  const density = hits / (wordCount / 1000);
  // 0 hits -> 100; ramps down as density climbs. ~6+ filler phrases / 1k words is heavy.
  const score = Math.round(Math.max(0, Math.min(100, 100 - density * 10)));

  if (density >= 3) {
    findings.push({
      severity: "info",
      category: "content",
      where: "page-level",
      message: `Content shows AI-filler patterns (${hits} filler phrases, e.g. ${samples.map((s) => `"${s}"`).join(", ")}).`,
      fix: "Cut hedging/filler phrasing and lead each section with a concrete, specific claim. Filler dilutes the extractable answer AI engines cite.",
    });
  }

  return { score, filler_hits: hits, findings };
}
