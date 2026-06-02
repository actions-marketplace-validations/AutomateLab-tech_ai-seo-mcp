// Shared types for the AI-SEO MCP server.

export type Severity = "critical" | "warning" | "info";

export type FindingCategory =
  | "schema"
  | "robots"
  | "technical"
  | "freshness"
  | "structure"
  | "authority"
  | "presence"
  | "sitemap"
  | "llms_txt"
  | "citation" // passage-level extractability / citability
  | "evidence" // citations, statistics, expert quotations
  | "trust"    // E-E-A-T trust signals (author, contact, policies)
  | "entity"   // entity identity / knowledge-graph signals
  | "content"; // generic content-quality (AI-filler, hedging)

export interface Finding {
  /** Severity determines triage priority. critical = blocks citation, warning = hurts probability, info = nice-to-have. */
  severity: Severity;
  category: FindingCategory;
  /** Where the issue was found. Use CSS selector, JSON-LD path like "Article.author", robots.txt line ref, or "page-level". */
  where: string;
  /** Human-readable message. Sentence case. <=120 chars. Do not repeat the fix here. */
  message: string;
  /** Concrete, copy-pasteable fix. Code snippets are acceptable. <=300 chars. */
  fix: string;
  /** Estimated impact on AI citation probability if this finding is resolved. Omit for info-level findings. */
  estimated_impact?: "high" | "medium" | "low";
  /** Falsifiability: the observable signal that would prove the fix did NOT work. Optional. */
  failure_signal?: string;
  /** Falsifiability: the leading indicator to monitor to confirm the fix is landing. Optional. */
  leading_indicator?: string;
}

export interface AuditResult {
  url: string;
  fetched_at: string; // ISO 8601
  findings: Finding[];
  score: number; // 0-100
  grade: "A" | "B" | "C" | "D" | "F";
}

export type ToolError =
  | { type: "invalid_url"; message: string }
  | { type: "fetch_timeout"; url: string; timeout_ms: number }
  | { type: "robots_blocked"; url: string; user_agent: string }
  | { type: "non_html_response"; url: string; content_type: string }
  | { type: "parse_error"; url: string; detail: string }
  | { type: "blocked_host"; url: string; reason: string }
  | { type: "fetch_error"; url: string; status?: number; message: string };
