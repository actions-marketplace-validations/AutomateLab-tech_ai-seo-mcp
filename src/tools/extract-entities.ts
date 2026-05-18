// Tool: extract_entities
// Extracts named entities, linked concepts, and sameAs graph nodes from page content.
// Primary path: MCP sampling (host LLM does NER). Fallback: regex heuristic.

import { z } from "zod";
import { politeFetch, type HostDelayMap } from "../lib/fetch.js";
import type { RenderMode } from "../lib/cache.js";
import { parseBody } from "../lib/html.js";
import { parseJsonLd } from "../lib/schema.js";
import {
  extractJsonLdEntities,
  extractTextEntities,
  mergeEntities,
  type ExtractedEntity,
} from "../lib/entities.js";
import type { Finding } from "../types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const extractEntitiesInputSchema = z
  .object({
    url: z.string().url().optional(),
    text: z.string().optional(),
    respect_robots: z.boolean().optional().default(true),
    render: z.enum(["static", "headless"]).optional().default("static"),
  })
  .refine((d) => d.url !== undefined || d.text !== undefined, {
    message: "One of url or text is required",
  });

export type ExtractEntitiesInput = z.infer<typeof extractEntitiesInputSchema>;

export interface ExtractEntitiesResult {
  entities: ExtractedEntity[];
  entity_count: number;
  connected_entity_count: number;
  citation_density_score: number;
  findings: Finding[];
  mode: "sampling" | "regex_fallback";
}

const SAMPLING_SYSTEM_PROMPT = `You are an entity extractor for AI-citation optimization. Identify named entities (organizations, people, products, technologies, locations) in the provided content.

For each entity:
- "name": the canonical entity name as it appears
- "type": one of "Organization", "Person", "Product", "Technology", "Location", "Event", "Other"
- "same_as": array of URLs found in the page that authoritatively identify this entity (Wikipedia, Wikidata, LinkedIn, official brand site, etc.). Empty array if none found in the provided URL list.

Skip generic terms, common words, and section headings. Cap at ~50 entities.

Return JSON only, no prose. Shape: { "entities": [{ "name": "...", "type": "...", "same_as": ["..."] }] }`;

interface SamplingEntity {
  name: string;
  type?: string;
  same_as?: string[];
}

async function trySampling(
  bodyText: string,
  externalLinks: string[],
  server: McpServer
): Promise<SamplingEntity[] | null> {
  const userMessage = `Page content (first 8000 chars):
---
${bodyText.substring(0, 8000)}
---

External links found on the page (use these to populate same_as where they authoritatively identify an entity):
${externalLinks.slice(0, 40).map((l) => `- ${l}`).join("\n") || "(none)"}

Extract entities and return JSON.`;

  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - sampling API availability varies by client; not typed in all SDK versions
    const samplingResult = await server.server.request(
      {
        method: "sampling/createMessage",
        params: {
          messages: [{ role: "user", content: { type: "text", text: userMessage } }],
          systemPrompt: SAMPLING_SYSTEM_PROMPT,
          maxTokens: 2048,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any
    );
    const text: string =
      samplingResult?.content?.text ?? samplingResult?.content?.[0]?.text ?? "";
    if (!text) return null;
    const jsonMatch = text.match(/```json\n([\s\S]+?)\n```/) ?? text.match(/\{[\s\S]+\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text;
    const parsed = JSON.parse(jsonStr) as { entities?: SamplingEntity[] };
    if (!parsed.entities || !Array.isArray(parsed.entities)) return null;
    return parsed.entities;
  } catch {
    return null;
  }
}

function countOccurrences(text: string, term: string): number {
  if (!term) return 0;
  const lower = text.toLowerCase();
  const termLower = term.toLowerCase();
  let count = 0;
  let idx = 0;
  while ((idx = lower.indexOf(termLower, idx)) !== -1) {
    count++;
    idx += termLower.length;
  }
  return count;
}

export async function extractEntities(
  input: ExtractEntitiesInput,
  hostDelays?: HostDelayMap,
  robotsCache?: Map<string, string>,
  server?: McpServer
): Promise<ExtractEntitiesResult> {
  const findings: Finding[] = [];
  let bodyText = "";
  let jsonLdBlocks: ReturnType<typeof parseJsonLd> = [];
  let externalLinks: string[] = [];

  if (input.url) {
    const result = await politeFetch(input.url, {
      respectRobots: input.respect_robots,
      hostDelays,
      robotsCache,
      renderMode: input.render,
    });
    const pageData = parseBody(result.body, input.url);
    bodyText = pageData.bodyText;
    externalLinks = pageData.externalLinks ?? [];
    jsonLdBlocks = parseJsonLd(result.body);
  } else {
    bodyText = input.text!;
  }

  const jsonLdEntities = extractJsonLdEntities(jsonLdBlocks);

  // Primary path: MCP sampling.
  let mode: "sampling" | "regex_fallback" = "regex_fallback";
  let entities: ExtractedEntity[] = [];

  if (server) {
    const sampled = await trySampling(bodyText, externalLinks, server);
    if (sampled && sampled.length > 0) {
      mode = "sampling";
      const sampledEntities: ExtractedEntity[] = sampled.map((e) => ({
        name: e.name,
        type: e.type ?? null,
        same_as: Array.isArray(e.same_as) ? e.same_as.filter((s) => typeof s === "string") : [],
        mention_count: countOccurrences(bodyText, e.name),
        is_defined: false,
      }));
      // Merge with JSON-LD entities (JSON-LD wins on dup name, lowercase keyed).
      const byName = new Map<string, ExtractedEntity>();
      for (const e of sampledEntities) byName.set(e.name.toLowerCase(), e);
      for (const e of jsonLdEntities) {
        const key = e.name.toLowerCase();
        const existing = byName.get(key);
        const count = countOccurrences(bodyText, e.name);
        if (existing) {
          // JSON-LD's sameAs wins; merge with sampled name/type.
          byName.set(key, {
            ...existing,
            same_as: e.same_as.length > 0 ? e.same_as : existing.same_as,
            type: e.type ?? existing.type,
            mention_count: count || existing.mention_count,
          });
        } else {
          byName.set(key, { ...e, mention_count: count });
        }
      }
      entities = Array.from(byName.values()).sort((a, b) => b.mention_count - a.mention_count);
    }
  }

  // Fallback: regex extractor.
  if (mode === "regex_fallback") {
    const textEntities = extractTextEntities(bodyText);
    entities = mergeEntities(jsonLdEntities, textEntities, bodyText);
  }

  const entity_count = entities.length;
  const connected_entity_count = entities.filter((e) => e.same_as.length > 0).length;
  // Threshold: 15 connected entities = score of 100
  const citation_density_score = Math.min(100, Math.round((connected_entity_count / 15) * 100));

  if (entity_count === 0) {
    findings.push({
      severity: "warning",
      category: "authority",
      where: "page-level",
      message: "No named entities detected on this page.",
      fix: "Add JSON-LD schema with named entities (Organization, Person, Product) and sameAs links.",
      estimated_impact: "medium",
    });
  } else if (connected_entity_count < 5) {
    findings.push({
      severity: "warning",
      category: "authority",
      where: "page-level",
      message: `Only ${connected_entity_count} entities have sameAs links. Pages with 15+ connected entities have 4.8x higher AI citation probability.`,
      fix: "Add sameAs links to JSON-LD entity nodes pointing to Wikidata, Wikipedia, LinkedIn, or official brand sites.",
      estimated_impact: "high",
    });
  }

  return {
    entities,
    entity_count,
    connected_entity_count,
    citation_density_score,
    findings,
    mode,
  };
}
