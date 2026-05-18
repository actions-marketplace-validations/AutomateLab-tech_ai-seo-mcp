// Tool: audit_schema
// Validates JSON-LD structured data against Schema.org rules and AI-citation best practices.

import { z } from "zod";
import { politeFetch, ToolFetchError, type HostDelayMap } from "../lib/fetch.js";
import type { RenderMode } from "../lib/cache.js";
import { parseJsonLd, getAllSchemaTypes, getMissingPriorityTypes, validateJsonLd, computeSchemaScore } from "../lib/schema.js";
import type { Finding } from "../types.js";

export const auditSchemaInputSchema = z
  .object({
    url: z.string().url().optional(),
    schema_json: z.string().optional(),
    respect_robots: z.boolean().optional().default(true),
  })
  .refine((d) => d.url !== undefined || d.schema_json !== undefined, {
    message: "One of url or schema_json is required",
  });

export type AuditSchemaInput = z.infer<typeof auditSchemaInputSchema>;

export interface AuditSchemaResult {
  source: "url" | "inline";
  found_types: string[];
  missing_priority_types: string[];
  findings: Finding[];
  ai_citation_readiness_score: number;
}

export async function auditSchema(
  input: AuditSchemaInput,
  hostDelays?: HostDelayMap,
  robotsCache?: Map<string, string>,
  renderMode?: RenderMode
): Promise<AuditSchemaResult> {
  let html: string;
  let source: "url" | "inline";

  if (input.schema_json) {
    source = "inline";
    // Wrap inline JSON in minimal HTML
    html = `<html><head><script type="application/ld+json">${input.schema_json}</script></head></html>`;
  } else {
    source = "url";
    const result = await politeFetch(input.url!, {
      respectRobots: input.respect_robots,
      hostDelays,
      robotsCache,
      renderMode,
    });
    const ct = result.headers["content-type"];
    const ctStr = Array.isArray(ct) ? ct[0] : (ct ?? "");
    if (!ctStr.includes("html") && !ctStr.includes("xml") && ctStr !== "") {
      throw new ToolFetchError({
        type: "non_html_response",
        url: input.url!,
        content_type: ctStr,
      });
    }
    html = result.body;
  }

  const blocks = parseJsonLd(html);
  const foundTypes = getAllSchemaTypes(blocks);
  const missingPriorityTypes = getMissingPriorityTypes(foundTypes);
  const findings = validateJsonLd(blocks);

  // Add finding for no schema at all
  if (foundTypes.length === 0 && source === "url") {
    findings.push({
      severity: "critical",
      category: "schema",
      where: "<head>",
      message: "No JSON-LD structured data found on this page.",
      fix: 'Add at least one <script type="application/ld+json"> block. Start with Article or FAQPage.',
      estimated_impact: "high",
    });
  }

  const ai_citation_readiness_score = computeSchemaScore(findings);

  return {
    source,
    found_types: foundTypes,
    missing_priority_types: missingPriorityTypes,
    findings,
    ai_citation_readiness_score,
  };
}
