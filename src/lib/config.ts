// Polite-fetch constants and environment variable reads.
// All values are read once at server startup.

export const POLITE_FETCH = {
  USER_AGENT:
    process.env["USER_AGENT"] ??
    "automatelab-ai-seo-mcp/0.1.3 (+https://github.com/AutomateLab-tech/ai-seo-mcp)",
  TIMEOUT_MS: Number(process.env["FETCH_TIMEOUT_MS"] ?? 15_000),
  MAX_BYTES: Number(process.env["MAX_BYTES"] ?? 5 * 1024 * 1024), // 5MB
  INTER_REQUEST_DELAY_MS: Number(process.env["INTER_REQUEST_DELAY_MS"] ?? 1_500),
  RESPECT_ROBOTS: process.env["RESPECT_ROBOTS"] !== "false",
} as const;
