// JSON-LD extractor and Schema.org validator.

import { extractJsonLdBlocks } from "./html.js";
import schemaTypes from "./schema-types.json" with { type: "json" };
import deprecatedTypes from "./deprecated-schema-types.json" with { type: "json" };
import type { Finding } from "../types.js";

export const KNOWN_SCHEMA_TYPES = new Set<string>(schemaTypes as string[]);
/** Types still valid in Schema.org but whose Google rich result was retired/narrowed. */
export const DEPRECATED_SCHEMA_TYPES = deprecatedTypes as Record<string, string>;

export interface ParsedJsonLd {
  raw: string;
  parsed: Record<string, unknown>;
  types: string[];
}

/** Flatten @graph arrays into individual objects. */
function flattenGraph(obj: Record<string, unknown>): Record<string, unknown>[] {
  const graph = obj["@graph"];
  if (Array.isArray(graph)) {
    return graph as Record<string, unknown>[];
  }
  return [obj];
}

/** Extract @type value(s) as an array of strings. */
export function extractTypes(obj: Record<string, unknown>): string[] {
  const t = obj["@type"];
  if (!t) return [];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((v) => typeof v === "string") as string[];
  return [];
}

/** Parse all JSON-LD blocks from HTML. Returns only successfully-parsed blocks. */
export function parseJsonLd(html: string): ParsedJsonLd[] {
  const blocks = extractJsonLdBlocks(html);
  const results: ParsedJsonLd[] = [];
  for (const raw of blocks) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const nodes = flattenGraph(parsed);
      for (const node of nodes) {
        results.push({
          raw,
          parsed: node,
          types: extractTypes(node),
        });
      }
    } catch {
      // skip malformed blocks
    }
  }
  return results;
}

/** Extract a flat list of all schema types present. */
export function getAllSchemaTypes(blocks: ParsedJsonLd[]): string[] {
  const all = new Set<string>();
  for (const b of blocks) {
    for (const t of b.types) all.add(t);
  }
  return Array.from(all);
}

const TIER1_TYPES = ["FAQPage", "HowTo", "Article", "BlogPosting", "NewsArticle", "Organization"];
const TIER2_TYPES = ["Product", "BreadcrumbList", "SoftwareApplication", "Person", "Review", "AggregateRating"];

/** Get missing priority schema types. */
export function getMissingPriorityTypes(foundTypes: string[]): string[] {
  const found = new Set(foundTypes);
  const hasArticle = found.has("Article") || found.has("BlogPosting") || found.has("NewsArticle");
  const missing: string[] = [];
  for (const t of TIER1_TYPES) {
    if (t === "Article" || t === "BlogPosting" || t === "NewsArticle") {
      if (!hasArticle) missing.push("Article/BlogPosting/NewsArticle");
      break; // add once
    }
    if (!found.has(t)) missing.push(t);
  }
  // deduplicate
  const uniqueMissing = Array.from(new Set(missing));
  for (const t of TIER2_TYPES) {
    if (!found.has(t)) uniqueMissing.push(t);
  }
  return uniqueMissing;
}

/** Validate all parsed JSON-LD blocks and emit findings. */
export function validateJsonLd(blocks: ParsedJsonLd[]): Finding[] {
  const findings: Finding[] = [];

  for (const block of blocks) {
    const obj = block.parsed;

    // @context must be https
    const ctx = obj["@context"];
    if (typeof ctx === "string" && ctx === "http://schema.org") {
      findings.push({
        severity: "critical",
        category: "schema",
        where: `${block.types.join(",")}.@context`,
        message: "@context uses http:// - must be https://schema.org.",
        fix: 'Replace "http://schema.org" with "https://schema.org".',
        estimated_impact: "medium",
      });
    }

    // Article/BlogPosting/NewsArticle checks
    if (block.types.some((t) => ["Article", "BlogPosting", "NewsArticle"].includes(t))) {
      const author = obj["author"];
      if (author === undefined) {
        findings.push({
          severity: "warning",
          category: "schema",
          where: `${block.types[0]}.author`,
          message: "Article is missing an author property.",
          fix: 'Add {"@type":"Person","name":"Author Name","url":"...","sameAs":["..."]}.',
          estimated_impact: "high",
        });
      } else if (typeof author === "string") {
        findings.push({
          severity: "critical",
          category: "schema",
          where: `${block.types[0]}.author`,
          message: "author is a plain string value, not a Person node.",
          fix: 'Replace with {"@type":"Person","name":"' + author + '","url":"https://...","sameAs":["..."]}.',
          estimated_impact: "high",
        });
      } else if (typeof author === "object" && author !== null) {
        const authorObj = author as Record<string, unknown>;
        if (!authorObj["sameAs"]) {
          findings.push({
            severity: "info",
            category: "schema",
            where: `${block.types[0]}.author.sameAs`,
            message: "Person node has no sameAs links, reducing entity verification.",
            fix: 'Add sameAs array with LinkedIn, Wikipedia, or official profile URLs.',
          });
        }
      }
    }

    // sameAs must be external absolute URLs
    const sameAs = obj["sameAs"];
    if (sameAs) {
      const saList: string[] = Array.isArray(sameAs)
        ? (sameAs as string[])
        : typeof sameAs === "string"
        ? [sameAs]
        : [];
      for (const sa of saList) {
        if (typeof sa !== "string") continue;
        if (!sa.startsWith("http")) {
          findings.push({
            severity: "warning",
            category: "schema",
            where: `${block.types.join(",")}.sameAs`,
            message: `sameAs value "${sa.substring(0, 60)}" is not an absolute URL.`,
            fix: "Use absolute, external, dereferenceable URLs for sameAs values.",
            estimated_impact: "medium",
          });
        } else {
          try {
            const parsed = new URL(sa);
            // Check if it looks internal (no meaningful hostname)
            if (parsed.hostname.length < 4) {
              findings.push({
                severity: "warning",
                category: "schema",
                where: `${block.types.join(",")}.sameAs`,
                message: `sameAs value "${sa}" may be an internal or invalid URL.`,
                fix: "Use external authoritative URLs (Wikipedia, Wikidata, LinkedIn, official brand sites).",
                estimated_impact: "medium",
              });
            }
          } catch {
            findings.push({
              severity: "warning",
              category: "schema",
              where: `${block.types.join(",")}.sameAs`,
              message: `sameAs value "${sa.substring(0, 60)}" is not a valid URL.`,
              fix: "Replace with a valid absolute URL.",
              estimated_impact: "medium",
            });
          }
        }
      }
    }

    // FAQPage checks
    if (block.types.includes("FAQPage")) {
      const mainEntity = obj["mainEntity"];
      if (!mainEntity) {
        findings.push({
          severity: "warning",
          category: "schema",
          where: "FAQPage.mainEntity",
          message: "FAQPage is missing mainEntity (array of Question nodes).",
          fix: 'Add mainEntity: [{"@type":"Question","name":"Q?","acceptedAnswer":{"@type":"Answer","text":"A"}}].',
          estimated_impact: "high",
        });
      } else if (Array.isArray(mainEntity)) {
        const questions = (mainEntity as Record<string, unknown>[]).map((q) =>
          typeof q["name"] === "string" ? q["name"] : ""
        );
        const seen = new Set<string>();
        const duplicates = questions.filter((q) => {
          if (seen.has(q)) return true;
          seen.add(q);
          return false;
        });
        if (duplicates.length > 0) {
          findings.push({
            severity: "critical",
            category: "schema",
            where: "FAQPage.mainEntity",
            message: `FAQPage has ${duplicates.length} duplicate Question.name values.`,
            fix: "Ensure each Question has a unique name value.",
            estimated_impact: "medium",
          });
        }
      }
    }

    // HowTo checks
    if (block.types.includes("HowTo")) {
      const steps = obj["step"];
      if (!steps || (Array.isArray(steps) && steps.length === 0)) {
        findings.push({
          severity: "warning",
          category: "schema",
          where: "HowTo.step",
          message: "HowTo schema has no step array - provides no AI signal.",
          fix: 'Add step: [{"@type":"HowToStep","name":"Step name","text":"Step description"}].',
          estimated_impact: "medium",
        });
      }
    }

    // Review rating checks
    if (block.types.includes("Review")) {
      const reviewRating = obj["reviewRating"] as Record<string, unknown> | undefined;
      if (reviewRating) {
        const ratingValue = reviewRating["ratingValue"];
        if (typeof ratingValue === "number") {
          findings.push({
            severity: "warning",
            category: "schema",
            where: "Review.reviewRating.ratingValue",
            message: "ratingValue is a number - must be a numeric string.",
            fix: 'Change ratingValue from a number to a string, e.g. "4.5" instead of 4.5.',
            estimated_impact: "low",
          });
        }
      }
    }

    // Organization logo check
    if (block.types.includes("Organization")) {
      const logo = obj["logo"];
      if (!logo) {
        findings.push({
          severity: "warning",
          category: "schema",
          where: "Organization.logo",
          message: "Organization is missing a logo property.",
          fix: 'Add logo: {"@type":"ImageObject","url":"https://example.com/logo.png"}.',
          estimated_impact: "medium",
        });
      } else if (typeof logo === "string") {
        findings.push({
          severity: "warning",
          category: "schema",
          where: "Organization.logo",
          message: "Organization.logo is a string URL, not an ImageObject.",
          fix: 'Replace with {"@type":"ImageObject","url":"<logo-url>"}.',
          estimated_impact: "low",
        });
      }
    }

    // Person sameAs check
    if (block.types.includes("Person")) {
      if (!obj["sameAs"]) {
        findings.push({
          severity: "info",
          category: "schema",
          where: "Person.sameAs",
          message: "Person node has no sameAs - reduces E-E-A-T verification.",
          fix: "Add sameAs links to LinkedIn, Twitter/X, Wikipedia, or other authority profiles.",
        });
      }
    }

    // Unknown / deprecated type checks
    for (const t of block.types) {
      if (DEPRECATED_SCHEMA_TYPES[t]) {
        findings.push({
          severity: "info",
          category: "schema",
          where: "@type",
          message: `Schema.org type "${t}" no longer yields a Google rich result.`,
          fix: DEPRECATED_SCHEMA_TYPES[t],
        });
      } else if (!KNOWN_SCHEMA_TYPES.has(t)) {
        findings.push({
          severity: "info",
          category: "schema",
          where: "@type",
          message: `Unrecognized Schema.org type: "${t}".`,
          fix: "Verify the type name at schema.org; correct any typo. If it is a valid but uncommon type, this is safe to ignore.",
          estimated_impact: "low",
        });
      }
    }
  }

  return findings;
}

/** Compute ai_citation_readiness_score from schema findings. */
export function computeSchemaScore(findings: Finding[]): number {
  let score = 100;
  for (const f of findings) {
    if (f.severity === "critical") score -= 20;
    else if (f.severity === "warning") score -= 8;
    else score -= 2;
  }
  return Math.max(0, score);
}
