// Tool: test_citation
// Simulates "would an AI engine cite this page for this query?" via MCP sampling.
// Primary path: ask the host LLM to role-play an AI search engine, decide cite/no-cite,
// and return the excerpt it would surface. Fallback: deterministic heuristic from
// score_citation_worthiness + audit_page findings.

import { z } from "zod";
import { politeFetch, type HostDelayMap } from "../lib/fetch.js";
import { parseBody } from "../lib/html.js";
import { scoreCitationWorthiness } from "./score-citation-worthiness.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const testCitationInputSchema = z
  .object({
    url: z.string().url().optional(),
    text: z.string().optional(),
    target_query: z.string().min(3),
    engine: z
      .enum(["chatgpt", "claude", "perplexity", "google_ai_overviews", "any"])
      .optional()
      .default("any"),
    respect_robots: z.boolean().optional().default(true),
  })
  .refine((d) => d.url !== undefined || d.text !== undefined, {
    message: "One of url or text is required",
  });

export type TestCitationInput = z.infer<typeof testCitationInputSchema>;

export interface TestCitationResult {
  target_query: string;
  engine: "chatgpt" | "claude" | "perplexity" | "google_ai_overviews" | "any";
  would_cite: boolean;
  confidence: number;
  citation_excerpt: string | null;
  reasoning: string;
  blocking_issues: string[];
  improvements: Array<{ change: string; estimated_impact: "high" | "medium" | "low" }>;
  mode: "sampling" | "static_heuristic";
}

const ENGINE_PERSONAS: Record<TestCitationInput["engine"], string> = {
  chatgpt:
    "You are ChatGPT search. You prefer pages with BLUF openings, FAQPage / Article JSON-LD, named-entity density, and links to authoritative sources (Wikipedia, .gov, .edu).",
  claude:
    "You are Claude Search. You favor pages with clear topical coherence, concise definitions, explicit authorship, and minimal marketing fluff. You penalize SEO boilerplate.",
  perplexity:
    "You are Perplexity. You synthesize across sources and pick excerpts that are statistic-dense, citation-friendly, and clearly attributable. You favor numbered lists and comparison tables.",
  google_ai_overviews:
    "You are Google's AI Overviews. You favor pages with Article / FAQ / HowTo schema, recent dateModified, E-E-A-T author signals, and direct answers to the query in the first 80 words.",
  any:
    "You are a generic AI search assistant. You decide cite vs no-cite based on direct query answerability, structured data presence, entity density, and freshness.",
};

const SYSTEM_PROMPT_PREFIX = `You are simulating an AI search engine deciding whether to cite a web page in response to a user query.

Return JSON only, no prose. Shape:
{
  "would_cite": boolean,
  "confidence": 0-100 integer,
  "citation_excerpt": string | null,
  "reasoning": string,
  "blocking_issues": [string, ...],
  "improvements": [{ "change": string, "estimated_impact": "high" | "medium" | "low" }, ...]
}

Rules:
- would_cite=true ONLY if the page contains a clear, attributable answer to the query in the first ~500 words.
- citation_excerpt: if would_cite=true, the 20-60 word verbatim excerpt you would surface; otherwise null.
- confidence reflects how likely a real engine is to surface this page given the query (not your certainty about the decision).
- blocking_issues: 1-5 concrete reasons the page is/isn't citable. Empty array if would_cite=true and excerpt is clearly attributable.
- improvements: 1-5 ranked, specific edits the author should make to improve citation probability.`;

interface SamplingOutput {
  would_cite: boolean;
  confidence: number;
  citation_excerpt: string | null;
  reasoning: string;
  blocking_issues: string[];
  improvements: Array<{ change: string; estimated_impact: "high" | "medium" | "low" }>;
}

async function trySampling(
  bodyText: string,
  url: string | undefined,
  targetQuery: string,
  engine: TestCitationInput["engine"],
  server: McpServer
): Promise<SamplingOutput | null> {
  const persona = ENGINE_PERSONAS[engine];
  const userMessage = `Query: "${targetQuery}"
${url ? `Page URL: ${url}` : ""}
Page content (first 6000 chars):
---
${bodyText.substring(0, 6000)}
---

Decide cite vs no-cite. Return JSON only.`;

  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - sampling API availability varies by client; not typed in all SDK versions
    const samplingResult = await server.server.request(
      {
        method: "sampling/createMessage",
        params: {
          messages: [{ role: "user", content: { type: "text", text: userMessage } }],
          systemPrompt: `${SYSTEM_PROMPT_PREFIX}\n\nPersona: ${persona}`,
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
    const parsed = JSON.parse(jsonStr) as Partial<SamplingOutput>;
    if (typeof parsed.would_cite !== "boolean") return null;
    return {
      would_cite: parsed.would_cite,
      confidence: Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(100, parsed.confidence!)) : 50,
      citation_excerpt: parsed.citation_excerpt ?? null,
      reasoning: parsed.reasoning ?? "",
      blocking_issues: Array.isArray(parsed.blocking_issues) ? parsed.blocking_issues : [],
      improvements: Array.isArray(parsed.improvements) ? parsed.improvements : [],
    };
  } catch {
    return null;
  }
}

export async function testCitation(
  input: TestCitationInput,
  hostDelays?: HostDelayMap,
  robotsCache?: Map<string, string>,
  server?: McpServer
): Promise<TestCitationResult> {
  let bodyText = input.text ?? "";
  if (input.url) {
    const result = await politeFetch(input.url, {
      respectRobots: input.respect_robots,
      hostDelays,
      robotsCache,
    });
    const parsed = parseBody(result.body, input.url);
    bodyText = parsed.bodyText;
  }

  // Primary: MCP sampling
  if (server) {
    const sampled = await trySampling(bodyText, input.url, input.target_query, input.engine, server);
    if (sampled) {
      return {
        target_query: input.target_query,
        engine: input.engine,
        would_cite: sampled.would_cite,
        confidence: sampled.confidence,
        citation_excerpt: sampled.citation_excerpt,
        reasoning: sampled.reasoning,
        blocking_issues: sampled.blocking_issues,
        improvements: sampled.improvements,
        mode: "sampling",
      };
    }
  }

  // Fallback: heuristic from score_citation_worthiness.
  const score = await scoreCitationWorthiness(
    { text: bodyText, target_query: input.target_query, respect_robots: false },
    hostDelays,
    robotsCache
  );

  // would_cite gate: overall >= 70 AND the relevant engine subscore >= 65.
  const engineScoreKey: Record<TestCitationInput["engine"], keyof typeof score.engine_scores | null> = {
    chatgpt: "chatgpt",
    claude: "claude",
    perplexity: "perplexity",
    google_ai_overviews: "google_ai_overviews",
    any: null,
  };
  const key = engineScoreKey[input.engine];
  const engineScore = key ? score.engine_scores[key] : score.overall_score;
  const wouldCite = score.overall_score >= 70 && engineScore >= 65;

  const blocking: string[] = score.findings
    .filter((f) => f.severity === "critical" || f.severity === "warning")
    .slice(0, 5)
    .map((f) => f.message);

  const improvements = score.findings
    .filter((f) => f.severity === "critical" || f.severity === "warning")
    .slice(0, 5)
    .map((f) => ({
      change: f.fix,
      estimated_impact: (f.estimated_impact ?? "medium") as "high" | "medium" | "low",
    }));

  return {
    target_query: input.target_query,
    engine: input.engine,
    would_cite: wouldCite,
    confidence: Math.round((score.overall_score + engineScore) / 2),
    citation_excerpt: null,
    reasoning: wouldCite
      ? `Heuristic verdict: overall citability ${score.overall_score}/100 and ${input.engine} subscore ${engineScore}/100 both clear the cite threshold.`
      : `Heuristic verdict: overall citability ${score.overall_score}/100 and ${input.engine} subscore ${engineScore}/100 fall below cite threshold. Run with an MCP host that supports sampling for a model-based simulation.`,
    blocking_issues: blocking,
    improvements,
    mode: "static_heuristic",
  };
}
