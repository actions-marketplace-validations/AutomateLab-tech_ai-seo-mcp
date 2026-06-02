// Tool: pricing.generate
// Generates a machine-readable /pricing.md for AI agents (agent commerce).
//
// LLM-driven shopping/agent flows increasingly look for a structured pricing
// file the way they look for llms.txt. Opaque, JS-rendered pricing tables get
// filtered out. This tool discovers the site's pricing page, extracts tier
// names and price lines heuristically, and emits a spec-light pricing.md.
// Deterministic; no LLM; read-only (returns the file content as a string).

import { z } from "zod";
import { politeFetch, type HostDelayMap } from "../lib/fetch.js";
import { parseHead, parseBody, extractSections } from "../lib/html.js";
import type { Finding } from "../types.js";

export const generatePricingMdInputSchema = z.object({
  domain: z
    .string()
    .min(3)
    .describe("Hostname or origin to generate pricing.md for, e.g. `example.com`. The tool finds the pricing page (or uses `pricing_url`), extracts tiers and prices, and returns a machine-readable pricing.md string. Read-only."),
  pricing_url: z
    .string()
    .url()
    .optional()
    .describe("Explicit pricing page URL. If omitted, the tool probes common paths (/pricing, /plans, /pricing/)."),
});

export type GeneratePricingMdInput = z.infer<typeof generatePricingMdInputSchema>;

export interface PricingMdResult {
  domain: string;
  pricing_md: string;
  source_url: string | null;
  tiers_detected: number;
  validation_issues: Finding[];
  suggested_path: "/pricing.md";
}

const PRICE_RE = /(\$|€|£|usd|eur|gbp)\s?\d[\d,]*(\.\d+)?(\s?\/\s?(mo|month|yr|year|user|seat|user\/mo))?|\b\d[\d,]*(\.\d+)?\s?(\/\s?(mo|month|yr|year))|\bfree\b|\bcontact (us|sales)\b|\bcustom pricing\b/gi;
const TIER_HINT = /\b(free|freemium|starter|basic|standard|pro|professional|plus|premium|team|teams|business|growth|scale|enterprise|individual|personal)\b/i;

function normalizeDomain(domain: string): string {
  if (domain.startsWith("http://") || domain.startsWith("https://")) {
    try { return new URL(domain).hostname; } catch { return domain; }
  }
  return domain.replace(/\/$/, "");
}

export async function generatePricingMdTool(
  input: GeneratePricingMdInput,
  hostDelays?: HostDelayMap,
  robotsCache?: Map<string, string>
): Promise<PricingMdResult> {
  const hostname = normalizeDomain(input.domain);
  const delays = hostDelays ?? new Map();
  const robots = robotsCache ?? new Map<string, string>();
  const validation_issues: Finding[] = [];

  // Discover the pricing page.
  const candidates = input.pricing_url
    ? [input.pricing_url]
    : [`https://${hostname}/pricing`, `https://${hostname}/pricing/`, `https://${hostname}/plans`, `https://${hostname}/plans/`];

  let sourceUrl: string | null = null;
  let html: string | null = null;
  for (const url of candidates) {
    try {
      const res = await politeFetch(url, { respectRobots: true, hostDelays: delays, robotsCache: robots });
      const ct = res.headers["content-type"] ?? "";
      if (ct.includes("html")) { sourceUrl = res.finalUrl || url; html = res.body; break; }
    } catch { /* try next */ }
  }

  const siteName = hostname;
  if (!html || !sourceUrl) {
    validation_issues.push({
      severity: "warning",
      category: "presence",
      where: "/pricing.md",
      message: "No pricing page found to derive pricing.md from.",
      fix: "Pass pricing_url explicitly, or publish a /pricing page. A template scaffold is returned below for you to fill in.",
      estimated_impact: "low",
    });
    return {
      domain: hostname,
      pricing_md: templateScaffold(siteName),
      source_url: null,
      tiers_detected: 0,
      validation_issues,
      suggested_path: "/pricing.md",
    };
  }

  const head = parseHead(html);
  const body = parseBody(html, sourceUrl);
  const sections = extractSections(html);

  // Tier candidates: sections whose heading names a plan or whose text carries a price.
  const tiers: Array<{ name: string; prices: string[] }> = [];
  for (const s of sections) {
    if (!s.heading) continue;
    const headingIsTier = TIER_HINT.test(s.heading) && s.heading.length < 40;
    const prices = Array.from(new Set((s.text.match(PRICE_RE) ?? []).map((p) => p.trim()))).slice(0, 4);
    if (headingIsTier || (prices.length > 0 && s.heading.length < 50)) {
      tiers.push({ name: s.heading.replace(/\s+/g, " ").trim(), prices });
    }
  }

  // Fallback: pull bare price lines if no tier sections matched.
  const pagePrices = Array.from(new Set((body.bodyText.match(PRICE_RE) ?? []).map((p) => p.trim()))).slice(0, 8);

  const lines: string[] = [];
  const title = head.ogTitle ?? head.title ?? `${siteName} pricing`;
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`> Machine-readable pricing for AI agents. Source: ${sourceUrl}`);
  lines.push("");

  if (tiers.length > 0) {
    for (const t of tiers) {
      lines.push(`## ${t.name}`);
      lines.push(t.prices.length ? `- Price: ${t.prices.join(" · ")}` : "- Price: (not detected — fill in)");
      lines.push("");
    }
  } else if (pagePrices.length > 0) {
    lines.push("## Prices");
    for (const p of pagePrices) lines.push(`- ${p}`);
    lines.push("");
    validation_issues.push({
      severity: "info",
      category: "structure",
      where: "/pricing.md",
      message: "Prices found but not grouped into named tiers.",
      fix: "Give each plan its own H2/H3 heading on the pricing page so tiers can be extracted cleanly.",
    });
  } else {
    validation_issues.push({
      severity: "warning",
      category: "structure",
      where: "/pricing.md",
      message: "Pricing page found but no prices detected (likely JS-rendered or image-based).",
      fix: "Render prices as real text/tables, not images or JS-only widgets, so agents (and this tool) can read them.",
      estimated_impact: "medium",
    });
    return {
      domain: hostname,
      pricing_md: templateScaffold(siteName) + `\n<!-- source: ${sourceUrl} (no machine-readable prices found) -->\n`,
      source_url: sourceUrl,
      tiers_detected: 0,
      validation_issues,
      suggested_path: "/pricing.md",
    };
  }

  return {
    domain: hostname,
    pricing_md: lines.join("\n"),
    source_url: sourceUrl,
    tiers_detected: tiers.length,
    validation_issues,
    suggested_path: "/pricing.md",
  };
}

function templateScaffold(siteName: string): string {
  return [
    `# ${siteName} pricing`,
    "",
    "> Machine-readable pricing for AI agents.",
    "",
    "## Free",
    "- Price: $0",
    "- For: getting started",
    "",
    "## Pro",
    "- Price: $TODO / month",
    "- For: TODO",
    "",
    "## Enterprise",
    "- Price: Contact sales",
    "- For: TODO",
    "",
  ].join("\n");
}
