// Agentic Browsing score.
//
// Mirrors the four signals Google added to the Lighthouse "Agentic Browsing"
// category in May 2026: presence of an llms.txt, WebMCP integration, an intact
// accessibility tree, and layout stability. All checks are static, deterministic
// heuristics over the fetched HTML (no headless render required) so the score is
// reproducible. It approximates Lighthouse's runtime signals from markup; it does
// not run Lighthouse.

import * as cheerio from "cheerio";
import type { Finding } from "../types.js";
import { analyzeImages } from "./html.js";

export type Grade = "A" | "B" | "C" | "D" | "F";

export interface AgenticFactor {
  /** 0-100 subscore for this signal. */
  score: number;
  /** One-line description of what was measured. */
  detail: string;
}

export interface AgenticBrowsingResult {
  /** Weighted 0-100 composite (each of the four factors weighs 25%). */
  score: number;
  grade: Grade;
  factors: {
    llms_txt: AgenticFactor;
    webmcp: AgenticFactor;
    accessibility_tree: AgenticFactor;
    layout_stability: AgenticFactor;
  };
  findings: Finding[];
}

function grade(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

export interface LlmsTxtState {
  /** Whether an llms.txt was found for the host. */
  present: boolean;
  /** Whether the found llms.txt passed structural validation (no critical findings). */
  valid?: boolean;
}

/** llms.txt factor: present + valid = 100, present but malformed = 70, absent = 0. */
function scoreLlmsTxt(state: LlmsTxtState): AgenticFactor {
  if (!state.present) {
    return { score: 0, detail: "No llms.txt found at /llms.txt." };
  }
  if (state.valid === false) {
    return { score: 70, detail: "llms.txt present but has structural problems." };
  }
  return { score: 100, detail: "llms.txt present and well-formed." };
}

/**
 * WebMCP factor: looks for any signal that the page exposes Model Context
 * Protocol tools to agents. WebMCP is nascent, so absence is common and only
 * informational; presence is a strong positive.
 */
function scoreWebMcp($: cheerio.CheerioAPI, html: string): AgenticFactor {
  const declared =
    $('script[type="text/mcp"], script[type="application/mcp+json"], script[type="text/mcp+json"]').length > 0 ||
    $('link[rel="mcp"], link[rel="webmcp"]').length > 0 ||
    $('meta[name="mcp"]').length > 0;
  if (declared) {
    return { score: 100, detail: "WebMCP declared via script/link/meta tag." };
  }
  // JS-API usage: navigator.modelContext (WebMCP) or a .well-known/mcp reference.
  const apiHint =
    /navigator\s*\.\s*modelContext/.test(html) ||
    /\.well-known\/mcp\b/.test(html) ||
    /\bregisterTool\s*\(/.test(html);
  if (apiHint) {
    return { score: 60, detail: "Partial WebMCP signal (JS API or .well-known reference)." };
  }
  return { score: 0, detail: "No WebMCP integration detected." };
}

/** Accessibility-tree integrity: lang, landmarks, alt coverage, labeled inputs. */
function scoreAccessibilityTree($: cheerio.CheerioAPI, html: string): AgenticFactor {
  let score = 0;
  const missing: string[] = [];

  const lang = $("html").attr("lang");
  if (lang && lang.trim().length > 0) score += 20;
  else missing.push("html[lang]");

  const hasMain = $("main, [role=main]").length > 0;
  if (hasMain) score += 20;
  else missing.push("<main> landmark");

  const landmarks = $("nav, header, footer, [role=navigation], [role=banner], [role=contentinfo]").length;
  if (landmarks > 0) score += 15;
  else missing.push("nav/header/footer landmarks");

  const img = analyzeImages(html);
  const altCoverage = img.total === 0 ? 1 : img.withMeaningfulAlt / img.total;
  if (altCoverage >= 0.8) score += 20;
  else if (altCoverage >= 0.5) score += 10;
  if (img.total > 0 && altCoverage < 0.8) missing.push("image alt text");

  // Form controls: every input/select/textarea should have a label or aria-label.
  let controls = 0;
  let labeled = 0;
  $("input:not([type=hidden]), select, textarea").each((_, el) => {
    controls++;
    const $el = $(el);
    const id = $el.attr("id");
    const hasLabel =
      (id && $(`label[for="${id}"]`).length > 0) ||
      $el.attr("aria-label") !== undefined ||
      $el.attr("aria-labelledby") !== undefined ||
      $el.closest("label").length > 0;
    if (hasLabel) labeled++;
  });
  if (controls === 0) score += 15;
  else if (labeled / controls >= 0.9) score += 15;
  else {
    score += Math.round((labeled / controls) * 15);
    missing.push("labeled form controls");
  }

  // Discernible names on interactive elements (links/buttons with no text/aria).
  let interactive = 0;
  let named = 0;
  $("a[href], button").each((_, el) => {
    interactive++;
    const $el = $(el);
    const text = $el.text().replace(/\s+/g, " ").trim();
    const hasName =
      text.length > 0 ||
      $el.attr("aria-label") !== undefined ||
      $el.attr("title") !== undefined ||
      $el.find("img[alt]").filter((_i, im) => ($(im).attr("alt") ?? "").trim().length > 0).length > 0;
    if (hasName) named++;
  });
  if (interactive === 0 || named / interactive >= 0.95) score += 10;
  else missing.push("discernible link/button names");

  score = Math.min(100, score);
  const detail =
    missing.length === 0
      ? "Accessibility tree intact (lang, landmarks, alt text, labels)."
      : `Accessibility gaps: ${missing.join(", ")}.`;
  return { score, detail };
}

/**
 * Layout stability: a CLS proxy. Media that declares intrinsic dimensions
 * (width+height attrs or a CSS aspect-ratio) reserves space and won't shift.
 * Score is the share of media (img/iframe/video) that declares dimensions.
 */
function scoreLayoutStability($: cheerio.CheerioAPI): AgenticFactor {
  let media = 0;
  let dimensioned = 0;
  $("img, iframe, video").each((_, el) => {
    media++;
    const $el = $(el);
    const w = $el.attr("width");
    const h = $el.attr("height");
    const style = ($el.attr("style") ?? "").toLowerCase();
    const hasAspect = style.includes("aspect-ratio") || (/(^|;)\s*width\s*:/.test(style) && /(^|;)\s*height\s*:/.test(style));
    if ((w && h) || hasAspect) dimensioned++;
  });
  if (media === 0) {
    return { score: 100, detail: "No media elements that could shift layout." };
  }
  const ratio = dimensioned / media;
  return {
    score: Math.round(ratio * 100),
    detail: `${dimensioned}/${media} media elements declare intrinsic dimensions.`,
  };
}

/** Compute the full Agentic Browsing score for a fetched HTML page. */
export function scoreAgenticBrowsing(html: string, llmsTxt: LlmsTxtState): AgenticBrowsingResult {
  const $ = cheerio.load(html);

  const factors = {
    llms_txt: scoreLlmsTxt(llmsTxt),
    webmcp: scoreWebMcp($, html),
    accessibility_tree: scoreAccessibilityTree($, html),
    layout_stability: scoreLayoutStability($),
  };

  const score = Math.round(
    factors.llms_txt.score * 0.25 +
      factors.webmcp.score * 0.25 +
      factors.accessibility_tree.score * 0.25 +
      factors.layout_stability.score * 0.25,
  );

  const findings: Finding[] = [];
  if (factors.llms_txt.score < 100) {
    findings.push({
      severity: llmsTxt.present ? "info" : "warning",
      category: "llms_txt",
      where: "/llms.txt",
      message: factors.llms_txt.detail,
      fix: "Publish a spec-compliant llms.txt at the site root listing your key pages. Lighthouse's Agentic Browsing audit checks for it.",
      estimated_impact: "low",
    });
  }
  if (factors.webmcp.score < 100) {
    findings.push({
      severity: "info",
      category: "technical",
      where: "<head>",
      message: factors.webmcp.detail,
      fix: "If your site offers agent actions, expose them via WebMCP (a <script type=\"text/mcp\"> manifest or navigator.modelContext). Optional but a positive agentic-browsing signal.",
    });
  }
  if (factors.accessibility_tree.score < 75) {
    findings.push({
      severity: "warning",
      category: "structure",
      where: "<body>",
      message: factors.accessibility_tree.detail,
      fix: "Add html[lang], a <main> landmark, alt text on content images, and labels on form controls. Agents read the accessibility tree to understand the page.",
      estimated_impact: "medium",
    });
  }
  if (factors.layout_stability.score < 75) {
    findings.push({
      severity: "warning",
      category: "technical",
      where: "<img>/<iframe>/<video>",
      message: factors.layout_stability.detail,
      fix: "Set explicit width and height (or CSS aspect-ratio) on images, iframes, and videos so content does not shift while loading.",
      estimated_impact: "medium",
    });
  }

  return { score, grade: grade(score), factors, findings };
}
