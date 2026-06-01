// Tool: score_agentic_browsing
// Scores a page against the Lighthouse "Agentic Browsing" category signals
// (llms.txt, WebMCP, accessibility tree, layout stability).

import { z } from "zod";
import { politeFetch, type HostDelayMap } from "../lib/fetch.js";
import type { RenderMode } from "../lib/cache.js";
import { scoreAgenticBrowsing, type AgenticBrowsingResult, type LlmsTxtState } from "../lib/agentic.js";
import { validateLlmsTxtContent } from "../lib/llms-txt.js";

export const scoreAgenticBrowsingInputSchema = z
  .object({
    url: z.string().url().optional(),
    html: z.string().optional(),
    respect_robots: z.boolean().optional().default(true),
    render: z.enum(["static", "headless"]).optional().default("static"),
    check_llms_txt: z.boolean().optional().default(true),
  })
  .refine((d) => d.url !== undefined || d.html !== undefined, {
    message: "One of url or html is required",
  });

export type ScoreAgenticBrowsingInput = z.infer<typeof scoreAgenticBrowsingInputSchema>;

export interface AgenticBrowsingToolResult extends AgenticBrowsingResult {
  url: string | null;
  fetched_at: string;
}

/** Probe /llms.txt for the host of `url`. Absent file -> { present: false }. */
async function probeLlmsTxt(
  url: string,
  hostDelays: HostDelayMap,
  robotsCache: Map<string, string>,
): Promise<LlmsTxtState> {
  try {
    const origin = new URL(url).origin;
    const result = await politeFetch(`${origin}/llms.txt`, {
      respectRobots: false,
      hostDelays,
      robotsCache,
    });
    const criticals = validateLlmsTxtContent(result.body).filter((f) => f.severity === "critical");
    return { present: true, valid: criticals.length === 0 };
  } catch {
    return { present: false };
  }
}

export async function scoreAgenticBrowsingTool(
  input: ScoreAgenticBrowsingInput,
): Promise<AgenticBrowsingToolResult> {
  const fetched_at = new Date().toISOString();
  const hostDelays: HostDelayMap = new Map();
  const robotsCache = new Map<string, string>();

  if (input.html !== undefined) {
    // Offline mode: no URL means we cannot probe a real llms.txt.
    const result = scoreAgenticBrowsing(input.html, { present: false });
    return { ...result, url: null, fetched_at };
  }

  const renderMode: RenderMode = input.render ?? "static";
  const page = await politeFetch(input.url!, {
    respectRobots: input.respect_robots,
    hostDelays,
    robotsCache,
    renderMode,
  });

  const llmsTxt = input.check_llms_txt
    ? await probeLlmsTxt(input.url!, hostDelays, robotsCache)
    : { present: false };

  const result = scoreAgenticBrowsing(page.body, llmsTxt);
  return { ...result, url: input.url!, fetched_at };
}
